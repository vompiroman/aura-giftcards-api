import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock, notifyAdminMock, getConfigMock, sendEmailMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  notifyAdminMock: vi.fn(),
  getConfigMock: vi.fn(),
  sendEmailMock: vi.fn(),
}));

vi.mock("../../src/lib/supabase", () => ({
  supabaseAdmin: { rpc: rpcMock },
}));

vi.mock("../../src/lib/notifyAdmin", () => ({
  notifyAdmin: notifyAdminMock,
}));

vi.mock("../../src/lib/purchaseEmail", () => ({
  getPurchaseEmailConfig: getConfigMock,
  sendPurchaseConfirmationEmail: sendEmailMock,
}));

import { runPurchaseEmailDelivery } from "../../src/jobs/purchaseEmailDelivery";

const job = {
  job_order_id: "ORD-EMAIL-JOB-1",
  customer_email: "client@example.com",
  total_amount: 500,
  subtotal_amount: 500,
  discount_amount: 0,
  order_items: [{ name: "Spotify Family 1 mois", quantity: 1 }],
  ordered_at: "2026-08-24T12:00:00.000Z",
  paid_at: "2026-08-24T12:05:00.000Z",
  claim_token: "00000000-0000-4000-8000-000000000001",
  delivery_attempt: 1,
};

describe("file d'envoi des confirmations d'achat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfigMock.mockReturnValue({
      apiKey: "re_test",
      fromEmail: "support@aura-stream.com",
      fromName: "Aura Stream",
    });
  });

  it("ne réclame aucun travail tant que l'expéditeur professionnel n'est pas configuré", async () => {
    getConfigMock.mockReturnValue(null);
    const summary = await runPurchaseEmailDelivery({ warn: vi.fn() });
    expect(summary).toMatchObject({ claimed: 0, sent: 0, failed: 0, skipped: true });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("marque la commande comme envoyée après la réponse du fournisseur", async () => {
    rpcMock
      .mockResolvedValueOnce({ data: [job], error: null })
      .mockResolvedValueOnce({ data: true, error: null });
    sendEmailMock.mockResolvedValue({ providerId: "provider-message-1" });

    const summary = await runPurchaseEmailDelivery();

    expect(summary).toEqual({ claimed: 1, sent: 1, failed: 0 });
    expect(rpcMock).toHaveBeenNthCalledWith(1, "claim_purchase_email_jobs", { p_limit: 5 });
    expect(rpcMock).toHaveBeenNthCalledWith(2, "complete_purchase_email_job", {
      p_order_id: job.job_order_id,
      p_claim_token: job.claim_token,
      p_provider_id: "provider-message-1",
    });
  });

  it("libère le travail et alerte l'administrateur après la dernière tentative", async () => {
    rpcMock
      .mockResolvedValueOnce({ data: [{ ...job, delivery_attempt: 6 }], error: null })
      .mockResolvedValueOnce({ data: 6, error: null });
    sendEmailMock.mockRejectedValue(Object.assign(new Error("provider down"), { code: "RESEND_HTTP_503" }));
    notifyAdminMock.mockResolvedValue(true);

    const summary = await runPurchaseEmailDelivery({ warn: vi.fn(), error: vi.fn() });

    expect(summary).toEqual({ claimed: 1, sent: 0, failed: 1 });
    expect(rpcMock).toHaveBeenNthCalledWith(2, "release_purchase_email_job", {
      p_order_id: job.job_order_id,
      p_claim_token: job.claim_token,
      p_error_code: "RESEND_HTTP_503",
    });
    expect(notifyAdminMock).toHaveBeenCalledWith(expect.stringMatching(/facture/i), expect.objectContaining({
      orderId: job.job_order_id,
      level: "critical",
    }));
  });
});
