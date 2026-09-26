import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  fromMock,
  rpcMock,
  notifyAdminMock,
  appendAuditLogMock,
  recordPaymentFailureMock,
  resetPaymentFailureMock,
  deliverActivationNotificationsMock,
} = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  notifyAdminMock: vi.fn(),
  appendAuditLogMock: vi.fn(),
  recordPaymentFailureMock: vi.fn(),
  resetPaymentFailureMock: vi.fn(),
  deliverActivationNotificationsMock: vi.fn(),
}));

vi.mock("../../src/lib/supabase", () => ({
  supabaseAdmin: { from: fromMock, rpc: rpcMock },
}));
vi.mock("../../src/lib/notifyAdmin", () => ({ notifyAdmin: notifyAdminMock }));
vi.mock("../../src/lib/metaConversions", () => ({ sendMetaPurchase: vi.fn() }));
vi.mock("../../src/lib/auditLog", () => ({ appendAuditLog: appendAuditLogMock }));
vi.mock("../../src/lib/paymentAlerts", () => ({
  recordPaymentFailure: recordPaymentFailureMock,
  resetPaymentFailure: resetPaymentFailureMock,
}));
vi.mock("../../src/lib/promos", () => ({ clientPromoHash: vi.fn(() => "client-hash") }));
vi.mock("../../src/jobs/activationNotificationDelivery", () => ({
  deliverActivationNotificationsForOrder: deliverActivationNotificationsMock,
}));

import { fulfillVerifiedPayment } from "../../src/lib/paymentFulfillment";

function renewedOrderQuery() {
  const builder: Record<string, any> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.maybeSingle = vi.fn(async () => ({
    data: {
      order_id: "ORD-original",
      assigned_email: "client@example.com",
      payment_status: "paid",
      status: "active",
      expires_at: "2026-10-01T12:00:00.000Z",
    },
    error: null,
  }));
  return builder;
}

describe("Netflix renewal fulfillment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T12:00:00.000Z"));
    fromMock.mockReturnValue(renewedOrderQuery());
    rpcMock.mockResolvedValue({
      data: {
        status: "assigned",
        order_id: "ORD-renewal",
        renewed_from_order_id: "ORD-original",
      },
      error: null,
    });
    deliverActivationNotificationsMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("prolonge depuis l'ancienne échéance et demande le transfert atomique du profil", async () => {
    const result = await fulfillVerifiedPayment({
      order_id: "ORD-renewal",
      assigned_email: "client@example.com",
      amount: 600,
      status: "pending",
      payment_status: "paid",
      renewal_order_id: "ORD-original",
      items: [{ name: "Netflix Premium 1 mois", quantity: 1 }],
    }, "slickpay_reconcile", { paymentTransitioned: true });

    expect(rpcMock).toHaveBeenCalledWith("assign_inventory_for_order", {
      p_order_id: "ORD-renewal",
      p_expires_at: "2026-11-01T12:00:00.000Z",
    });
    expect(result).toMatchObject({
      payment_status: "paid",
      order_status: "active",
      expires_at: "2026-11-01T12:00:00.000Z",
    });
  });

  it("bloque un renouvellement qui ne correspond plus au même client", async () => {
    const query = renewedOrderQuery();
    query.maybeSingle.mockResolvedValue({
      data: {
        order_id: "ORD-original",
        assigned_email: "other@example.com",
        payment_status: "paid",
        status: "active",
        expires_at: "2026-10-01T12:00:00.000Z",
      },
      error: null,
    });
    fromMock.mockReturnValue(query);

    await expect(fulfillVerifiedPayment({
      order_id: "ORD-renewal",
      assigned_email: "client@example.com",
      amount: 600,
      status: "pending",
      payment_status: "paid",
      renewal_order_id: "ORD-original",
      items: [{ name: "Netflix Premium 1 mois", quantity: 1 }],
    }, "slickpay_reconcile", { paymentTransitioned: true })).rejects.toThrow("RENEWAL_ORDER_INVALID");
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
