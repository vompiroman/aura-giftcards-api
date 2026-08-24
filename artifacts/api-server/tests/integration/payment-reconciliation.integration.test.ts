import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  fetchInvoiceMock,
  fulfillMock,
  notifyAdminMock,
  observeMock,
  expireMock,
  appendAuditLogMock,
  fromMock,
} = vi.hoisted(() => ({
  fetchInvoiceMock: vi.fn(),
  fulfillMock: vi.fn(),
  notifyAdminMock: vi.fn(),
  observeMock: vi.fn(),
  expireMock: vi.fn(),
  appendAuditLogMock: vi.fn(),
  fromMock: vi.fn(),
}));

vi.mock("../../src/lib/supabase", () => ({
  supabaseAdmin: { from: fromMock },
}));
vi.mock("../../src/lib/slickpay", () => ({ fetchSlickPayInvoice: fetchInvoiceMock }));
vi.mock("../../src/lib/paymentFulfillment", () => ({ fulfillVerifiedPayment: fulfillMock }));
vi.mock("../../src/lib/slickpayObservation", () => ({ observeSlickPayPayment: observeMock }));
vi.mock("../../src/lib/slickpayExpiration", () => ({ expireUnpaidSlickPayOrder: expireMock }));
vi.mock("../../src/lib/notifyAdmin", () => ({ notifyAdmin: notifyAdminMock }));
vi.mock("../../src/lib/auditLog", () => ({ appendAuditLog: appendAuditLogMock }));

import { runPaymentReconciliation } from "../../src/jobs/paymentReconciliation";

function reconciliationQuery(rows: Record<string, unknown>[]) {
  const builder: Record<string, any> = {};
  for (const method of ["select", "in", "not", "gt", "lte", "order"]) {
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
  created_at: new Date().toISOString(),
};

function prepareQueries(
  recent: Record<string, unknown>[] = [],
  stale: Record<string, unknown>[] = [],
): void {
  fromMock
    .mockReturnValueOnce(reconciliationQuery(recent))
    .mockReturnValueOnce(reconciliationQuery(stale));
}

describe("SlickPay payment reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fulfillMock.mockResolvedValue({ payment_status: "paid", order_status: "active" });
    expireMock.mockResolvedValue({ result: "deleted", provider_status: "unpaid" });
  });

  it("confirme et exécute une facture payée retrouvée par l'API", async () => {
    prepareQueries([order]);
    const provider = { state: "paid", amount: 800 };
    fetchInvoiceMock.mockResolvedValue(provider);
    observeMock.mockResolvedValue({
      result: "confirmed",
      transitioned: true,
      payment_status: "paid",
      order_status: "pending",
    });

    const summary = await runPaymentReconciliation();

    expect(summary).toEqual({ checked: 1, confirmed: 1, pending: 0, expired: 0, errors: 0 });
    expect(observeMock).toHaveBeenCalledWith(order.order_id, order.slickpay_invoice_id, provider);
    expect(fulfillMock).toHaveBeenCalledWith(order, "slickpay_reconcile", {
      paymentTransitioned: true,
    });
  });

  it("enregistre une facture encore impayée sans activer la commande", async () => {
    prepareQueries([order]);
    const provider = { state: "unpaid", amount: 800 };
    fetchInvoiceMock.mockResolvedValue(provider);
    observeMock.mockResolvedValue({
      result: "unpaid",
      transitioned: false,
      payment_status: "unpaid",
      order_status: "pending",
    });

    const summary = await runPaymentReconciliation();

    expect(summary).toEqual({ checked: 1, confirmed: 0, pending: 1, expired: 0, errors: 0 });
    expect(observeMock).toHaveBeenCalledTimes(1);
    expect(fulfillMock).not.toHaveBeenCalled();
  });

  it("bloque et alerte si le montant SlickPay est incohérent", async () => {
    prepareQueries([order]);
    const provider = { state: "paid", amount: 799 };
    fetchInvoiceMock.mockResolvedValue(provider);
    observeMock.mockResolvedValue({
      result: "amount_mismatch",
      transitioned: false,
      payment_status: "unpaid",
      order_status: "pending",
    });

    const summary = await runPaymentReconciliation();

    expect(summary).toEqual({ checked: 1, confirmed: 0, pending: 0, expired: 0, errors: 1 });
    expect(fulfillMock).not.toHaveBeenCalled();
    expect(notifyAdminMock).toHaveBeenCalledWith(
      expect.stringContaining("incohérent"),
      expect.objectContaining({ level: "critical", orderId: order.order_id }),
    );
  });

  it("supprime après 24 h une facture que SlickPay confirme encore impayée", async () => {
    const staleOrder = { ...order, created_at: "2026-08-20T00:00:00.000Z" };
    prepareQueries([], [staleOrder]);
    const provider = { state: "unpaid", amount: 800 };
    fetchInvoiceMock.mockResolvedValue(provider);
    observeMock.mockResolvedValue({
      result: "unpaid",
      transitioned: false,
      payment_status: "unpaid",
      order_status: "pending",
    });

    const summary = await runPaymentReconciliation();

    expect(summary).toEqual({ checked: 1, confirmed: 0, pending: 0, expired: 1, errors: 0 });
    expect(observeMock).toHaveBeenCalledWith(order.order_id, order.slickpay_invoice_id, provider);
    expect(expireMock).toHaveBeenCalledWith(order.order_id, order.slickpay_invoice_id, expect.any(String));
    expect(appendAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "order_auto_expiration",
      targetId: order.order_id,
    }));
  });

  it("confirme au lieu de supprimer si le paiement arrive à la limite des 24 h", async () => {
    const staleOrder = { ...order, created_at: "2026-08-20T00:00:00.000Z" };
    prepareQueries([], [staleOrder]);
    const provider = { state: "paid", amount: 800 };
    fetchInvoiceMock.mockResolvedValue(provider);
    observeMock.mockResolvedValue({
      result: "confirmed",
      transitioned: true,
      payment_status: "paid",
      order_status: "pending",
    });

    const summary = await runPaymentReconciliation();

    expect(summary).toEqual({ checked: 1, confirmed: 1, pending: 0, expired: 0, errors: 0 });
    expect(fulfillMock).toHaveBeenCalledTimes(1);
    expect(expireMock).not.toHaveBeenCalled();
  });

  it("ne supprime jamais si l'API SlickPay est indisponible", async () => {
    const staleOrder = { ...order, created_at: "2026-08-20T00:00:00.000Z" };
    prepareQueries([], [staleOrder]);
    fetchInvoiceMock.mockRejectedValue(new Error("SLICKPAY_HTTP_503"));

    const summary = await runPaymentReconciliation({ warn: vi.fn() });

    expect(summary).toEqual({ checked: 1, confirmed: 0, pending: 0, expired: 0, errors: 1 });
    expect(expireMock).not.toHaveBeenCalled();
  });

  it("supprime un verrou local abandonné après 24 h sans appeler SlickPay", async () => {
    const staleClaim = {
      ...order,
      slickpay_invoice_id: "pending:1787000000000:test-claim",
      created_at: "2026-08-20T00:00:00.000Z",
    };
    prepareQueries([], [staleClaim]);
    expireMock.mockResolvedValue({ result: "deleted", provider_status: "local_claim" });

    const summary = await runPaymentReconciliation();

    expect(summary).toEqual({ checked: 1, confirmed: 0, pending: 0, expired: 1, errors: 0 });
    expect(fetchInvoiceMock).not.toHaveBeenCalled();
    expect(observeMock).not.toHaveBeenCalled();
    expect(expireMock).toHaveBeenCalledTimes(1);
  });

  it("respecte la protection atomique si la commande devient payée avant la suppression", async () => {
    const staleOrder = { ...order, created_at: "2026-08-20T00:00:00.000Z" };
    prepareQueries([], [staleOrder]);
    fetchInvoiceMock.mockResolvedValue({ state: "pending", amount: 800 });
    observeMock.mockResolvedValue({
      result: "pending",
      transitioned: false,
      payment_status: "unpaid",
      order_status: "pending",
    });
    expireMock.mockResolvedValue({ result: "protected_paid" });

    const summary = await runPaymentReconciliation();

    expect(summary).toEqual({ checked: 1, confirmed: 0, pending: 0, expired: 0, errors: 0 });
    expect(appendAuditLogMock).not.toHaveBeenCalled();
  });
});
