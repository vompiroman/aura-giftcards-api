import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  appendAuditLogMock,
  deliverActivationNotificationsMock,
  notifyAdminMock,
  recordPaymentFailureMock,
  resetPaymentFailureMock,
  rpcMock,
  sendMetaPurchaseMock,
} = vi.hoisted(() => ({
  appendAuditLogMock: vi.fn(),
  deliverActivationNotificationsMock: vi.fn(),
  notifyAdminMock: vi.fn(),
  recordPaymentFailureMock: vi.fn(),
  resetPaymentFailureMock: vi.fn(),
  rpcMock: vi.fn(),
  sendMetaPurchaseMock: vi.fn(),
}));

vi.mock("../../src/lib/supabase", () => ({ supabaseAdmin: { rpc: rpcMock } }));
vi.mock("../../src/lib/auditLog", () => ({ appendAuditLog: appendAuditLogMock }));
vi.mock("../../src/lib/notifyAdmin", () => ({ notifyAdmin: notifyAdminMock }));
vi.mock("../../src/lib/metaConversions", () => ({ sendMetaPurchase: sendMetaPurchaseMock }));
vi.mock("../../src/lib/paymentAlerts", () => ({
  recordPaymentFailure: recordPaymentFailureMock,
  resetPaymentFailure: resetPaymentFailureMock,
}));
vi.mock("../../src/jobs/activationNotificationDelivery", () => ({
  deliverActivationNotificationsForOrder: deliverActivationNotificationsMock,
}));

import { fulfillVerifiedPayment } from "../../src/lib/paymentFulfillment";

describe("notification d’activation après confirmation de paiement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deliverActivationNotificationsMock.mockResolvedValue({ checked: 1, sent: 1, pending: 0, errors: 0 });
    rpcMock.mockResolvedValue({
      data: { status: "awaiting_manual_activation" },
      error: null,
    });
  });

  it("transmet les identifiants à l’équipe seulement depuis le fulfillment payé", async () => {
    const items = [{
      name: "Spotify Family 1 mois",
      client_credentials: {
        version: 1,
        email: { iv: "iv", tag: "tag", value: "email" },
        password: { iv: "iv", tag: "tag", value: "password" },
        whatsapp: { iv: "iv", tag: "tag", value: "whatsapp" },
      },
    }];

    await expect(fulfillVerifiedPayment({
      order_id: "ORD-paid-spotify",
      assigned_email: "client@example.com",
      status: "pending",
      payment_status: "paid",
      amount: 500,
      items,
      marketing_consent: false,
      meta_purchase_sent_at: null,
    }, "slickpay_webhook", { paymentTransitioned: true })).resolves.toMatchObject({
      payment_status: "paid",
      order_status: "pending",
      awaiting_manual_activation: true,
    });

    expect(deliverActivationNotificationsMock).toHaveBeenCalledTimes(1);
    expect(deliverActivationNotificationsMock).toHaveBeenCalledWith("ORD-paid-spotify", items);
  });
});
