import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { appendAuditLogMock, fromMock, notifyOperationsMock } = vi.hoisted(() => ({
  appendAuditLogMock: vi.fn(),
  fromMock: vi.fn(),
  notifyOperationsMock: vi.fn(),
}));

vi.mock("../../src/lib/auditLog", () => ({ appendAuditLog: appendAuditLogMock }));
vi.mock("../../src/lib/notifyOperations", () => ({ notifyOperations: notifyOperationsMock }));
vi.mock("../../src/lib/supabase", () => ({ supabaseAdmin: { from: fromMock } }));

import { deliverPendingActivationNotifications } from "../../src/jobs/activationNotificationDelivery";
import { adminOrderItems, setClientCredentials } from "../../src/lib/orderItems";

function pendingOrdersQuery(items: any[]) {
  const builder: Record<string, any> = {};
  for (const method of ["select", "eq", "order"]) builder[method] = vi.fn(() => builder);
  builder.limit = vi.fn(async () => ({
    data: [{ order_id: "ORD-retry-spotify", items }],
    error: null,
  }));
  return builder;
}

function updateQuery(updatePayloads: any[]) {
  const builder: Record<string, any> = {};
  builder.update = vi.fn((payload: any) => {
    updatePayloads.push(payload);
    return builder;
  });
  builder.eq = vi.fn(() => builder);
  builder.select = vi.fn(async () => ({ data: [{ order_id: "ORD-retry-spotify" }], error: null }));
  return builder;
}

describe("rattrapage des notifications d'activation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CLIENT_CREDENTIALS_KEY = "dedicated-client-credentials-key-32-chars";
  });

  afterEach(() => {
    delete process.env.CLIENT_CREDENTIALS_KEY;
  });

  it("renvoie les identifiants chiffrés à Discord puis marque la livraison", async () => {
    const items = setClientCredentials(
      [{ name: "Spotify Family 1 mois" }],
      "spotify",
      { email: "spotify@example.com", password: "temporary", whatsapp: "+213555000000" },
    );
    const updates: any[] = [];
    fromMock
      .mockReturnValueOnce(pendingOrdersQuery(items))
      .mockReturnValueOnce(updateQuery(updates));
    notifyOperationsMock.mockResolvedValue(true);

    await expect(deliverPendingActivationNotifications()).resolves.toEqual({
      checked: 1,
      sent: 1,
      pending: 0,
      errors: 0,
    });
    expect(notifyOperationsMock).toHaveBeenCalledWith(
      expect.stringContaining("Nouveau compte spotify payé"),
      expect.objectContaining({
        orderId: "ORD-retry-spotify",
        service: "spotify",
        credentials: {
          email: "spotify@example.com",
          password: "temporary",
          whatsapp: "+213555000000",
        },
      }),
    );
    expect(adminOrderItems(updates[0].items)[0]).toMatchObject({
      client_credentials_notification_sent_at: expect.any(String),
      client_credentials: { email: "spotify@example.com" },
    });
  });

  it("conserve la notification en attente lorsque Discord est indisponible", async () => {
    const items = setClientCredentials(
      [{ name: "Spotify Family 1 mois" }],
      "spotify",
      { email: "spotify@example.com", password: "temporary", whatsapp: "+213555000000" },
    );
    fromMock.mockReturnValueOnce(pendingOrdersQuery(items));
    notifyOperationsMock.mockResolvedValue(false);

    await expect(deliverPendingActivationNotifications()).resolves.toEqual({
      checked: 1,
      sent: 0,
      pending: 1,
      errors: 1,
    });
  });
});
