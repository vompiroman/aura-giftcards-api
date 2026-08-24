import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  fetchInvoiceMock,
  fulfillMock,
  notifyAdminMock,
  observeMock,
  fromMock,
} = vi.hoisted(() => ({
  fetchInvoiceMock: vi.fn(),
  fulfillMock: vi.fn(),
  notifyAdminMock: vi.fn(),
  observeMock: vi.fn(),
  fromMock: vi.fn(),
}));

vi.mock("../../src/lib/supabase", () => ({
  supabaseAdmin: { from: fromMock },
}));
vi.mock("../../src/lib/slickpay", () => ({ fetchSlickPayInvoice: fetchInvoiceMock }));
vi.mock("../../src/lib/paymentFulfillment", () => ({ fulfillVerifiedPayment: fulfillMock }));
vi.mock("../../src/lib/slickpayObservation", () => ({ observeSlickPayPayment: observeMock }));
vi.mock("../../src/lib/notifyAdmin", () => ({ notifyAdmin: notifyAdminMock }));

import { runPaymentReconciliation } from "../../src/jobs/paymentReconciliation";

function reconciliationQuery(rows: Record<string, unknown>[]) {
  const builder: Record<string, any> = {};
  for (const method of ["select", "in", "not", "gte", "order"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.limit = vi.fn(async () => ({ data: rows, error: null }));
  return builder;
}

const order = {
  order_id: "ORD-reconcile-1",
  assigned_email: "client@example.com",
  amount: 800,
  status: "pending",
  payment_status: "unpaid",
  promo_code_id: null,
  slickpay_invoice_id: "INV-reconcile-1",
  items: [{ name: "Netflix 1 mois", quantity: 1 }],
  marketing_consent: false,
  meta_purchase_sent_at: null,
};

describe("SlickPay payment reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromMock.mockReturnValue(reconciliationQuery([order]));
    fulfillMock.mockResolvedValue({ payment_status: "paid", order_status: "active" });
  });

  it("confirme et exécute une facture payée retrouvée par l'API", async () => {
    const provider = { state: "paid", amount: 800 };
    fetchInvoiceMock.mockResolvedValue(provider);
    observeMock.mockResolvedValue({
      result: "confirmed",
      transitioned: true,
      payment_status: "paid",
      order_status: "pending",
    });

    const summary = await runPaymentReconciliation();

    expect(summary).toEqual({ checked: 1, confirmed: 1, pending: 0, errors: 0 });
    expect(observeMock).toHaveBeenCalledWith(order.order_id, order.slickpay_invoice_id, provider);
    expect(fulfillMock).toHaveBeenCalledWith(order, "slickpay_reconcile", {
      paymentTransitioned: true,
    });
  });

  it("enregistre une facture encore impayée sans activer la commande", async () => {
    const provider = { state: "unpaid", amount: 800 };
    fetchInvoiceMock.mockResolvedValue(provider);
    observeMock.mockResolvedValue({
      result: "unpaid",
      transitioned: false,
      payment_status: "unpaid",
      order_status: "pending",
    });

    const summary = await runPaymentReconciliation();

    expect(summary).toEqual({ checked: 1, confirmed: 0, pending: 1, errors: 0 });
    expect(observeMock).toHaveBeenCalledTimes(1);
    expect(fulfillMock).not.toHaveBeenCalled();
  });

  it("bloque et alerte si le montant SlickPay est incohérent", async () => {
    const provider = { state: "paid", amount: 799 };
    fetchInvoiceMock.mockResolvedValue(provider);
    observeMock.mockResolvedValue({
      result: "amount_mismatch",
      transitioned: false,
      payment_status: "unpaid",
      order_status: "pending",
    });

    const summary = await runPaymentReconciliation();

    expect(summary).toEqual({ checked: 1, confirmed: 0, pending: 0, errors: 1 });
    expect(fulfillMock).not.toHaveBeenCalled();
    expect(notifyAdminMock).toHaveBeenCalledWith(
      expect.stringContaining("incohérent"),
      expect.objectContaining({ level: "critical", orderId: order.order_id }),
    );
  });
});
