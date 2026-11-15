import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), config: vi.fn(), send: vi.fn() }));
vi.mock("../../src/lib/supabase", () => ({ supabaseAdmin: { from: mocks.from, rpc: mocks.rpc } }));
vi.mock("../../src/lib/purchaseEmail", () => ({
  getPurchaseEmailConfig: mocks.config,
  sendPartnerRenewalReminder: mocks.send,
}));

import { runPartnerReminders } from "../../src/jobs/partnerReminders";

const claim = {
  email: "old@example.invalid",
  order_id: "ORD-test",
  expires_at: "2026-11-20T12:00:00.000Z",
  days_before: 7,
  language: "fr",
  claim_id: "f70d91e5-cd99-46d3-b141-b8058c3b1783",
};
const config = { provider: "resend" };

function selection(data: unknown) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    gt: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data, error: null })),
  };
  return query;
}

describe("partner renewal delivery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("PARTNER_PROGRAM_ENABLED", "true");
    mocks.config.mockReturnValue(config);
    mocks.rpc.mockResolvedValue({ data: [claim], error: null });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("uses the latest recipient and language and marks only the claimed delivery", async () => {
    const order = selection({ assigned_email: "partner@example.invalid" });
    const settings = selection({ language: "ar" });
    const response = Promise.resolve({ error: null });
    const eq = vi.fn(() => response);
    const update = vi.fn(() => Object.assign(response, { eq }));
    const tables: Record<string, unknown> = {
      orders: order, partner_order_settings: settings, partner_reminder_deliveries: { update },
    };
    mocks.from.mockImplementation(table => tables[table]);

    expect(await runPartnerReminders()).toEqual({ sent: 1, errors: 0 });
    expect(settings.eq).toHaveBeenCalledWith("reminders", true);
    expect(order.eq).toHaveBeenCalledWith("expires_at", claim.expires_at);
    expect(mocks.send).toHaveBeenCalledWith({
      ...claim, email: "partner@example.invalid", language: "ar",
    }, config);
    expect(update).toHaveBeenCalledWith({ sent_at: expect.any(String) });
    expect(eq.mock.calls).toEqual([
      ["claim_id", claim.claim_id], ["order_id", claim.order_id],
      ["expires_at", claim.expires_at], ["days_before", 7],
    ]);
  });

  it("skips a reminder if the partner opted out after it was claimed", async () => {
    mocks.from.mockImplementation(table => table === "orders"
      ? selection({ assigned_email: "partner@example.invalid" }) : selection(null));
    expect(await runPartnerReminders()).toEqual({ sent: 0, errors: 0 });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("leaves a failed send available for retry without marking it as delivered", async () => {
    mocks.from.mockImplementation(table => table === "orders"
      ? selection({ assigned_email: "partner@example.invalid" }) : selection({ language: "fr" }));
    mocks.send.mockRejectedValue(new Error("mail provider unavailable"));
    expect(await runPartnerReminders()).toEqual({ sent: 0, errors: 1 });
    expect(mocks.from).not.toHaveBeenCalledWith("partner_reminder_deliveries");
  });
});
