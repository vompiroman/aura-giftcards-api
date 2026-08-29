import { beforeEach, describe, expect, it, vi } from "vitest";

const { fromMock, fulfillMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  fulfillMock: vi.fn(),
}));

vi.mock("../../src/lib/supabase", () => ({
  supabaseAdmin: { from: fromMock },
}));
vi.mock("../../src/lib/paymentFulfillment", () => ({
  fulfillVerifiedPayment: fulfillMock,
}));

import { fulfillPaidOrdersWaitingForStock } from "../../src/jobs/stockFulfillment";

const netflixOrder = {
  order_id: "ORD-stock-waiting-1",
  assigned_email: "client@example.com",
  amount: 600,
  status: "pending",
  payment_status: "paid",
  promo_code_id: null,
  items: [{ name: "Netflix Premium 1 mois", quantity: 1 }],
  marketing_consent: false,
  meta_purchase_sent_at: null,
  created_at: "2026-08-29T18:00:00.000Z",
};

function orderQuery(rows: Record<string, unknown>[]) {
  const builder: Record<string, any> = {};
  for (const method of ["select", "eq", "order"]) builder[method] = vi.fn(() => builder);
  builder.limit = vi.fn(async () => ({ data: rows, error: null }));
  return builder;
}

function inventoryCountQuery(count: number) {
  const builder: Record<string, any> = {};
  for (const method of ["select", "eq"]) builder[method] = vi.fn(() => builder);
  builder.ilike = vi.fn(async () => ({ count, error: null }));
  return builder;
}

describe("paid orders waiting for Netflix stock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("attribue le nouveau profil à la plus ancienne commande payée", async () => {
    fromMock
      .mockReturnValueOnce(orderQuery([netflixOrder]))
      .mockReturnValueOnce(inventoryCountQuery(0));
    fulfillMock.mockResolvedValue({ payment_status: "paid", order_status: "active" });

    const summary = await fulfillPaidOrdersWaitingForStock();

    expect(summary).toEqual({
      checked: 1,
      fulfilled: 1,
      awaiting_manual_activation: 0,
      waiting_for_stock: 0,
      errors: 0,
    });
    expect(fulfillMock).toHaveBeenCalledWith(netflixOrder, "slickpay_reconcile", {
      paymentTransitioned: false,
    });
  });

  it("ignore les activations manuelles sans produit Netflix", async () => {
    const manualOrder = {
      ...netflixOrder,
      order_id: "ORD-manual-only",
      items: [{ name: "Spotify Family 1 mois", quantity: 1 }],
    };
    fromMock.mockReturnValueOnce(orderQuery([manualOrder]));

    const summary = await fulfillPaidOrdersWaitingForStock();

    expect(summary.checked).toBe(0);
    expect(fulfillMock).not.toHaveBeenCalled();
  });

  it("préserve l'ordre FIFO si le stock reste insuffisant", async () => {
    fromMock
      .mockReturnValueOnce(orderQuery([
        { ...netflixOrder, items: [{ name: "Netflix Premium 1 mois", quantity: 2 }] },
        { ...netflixOrder, order_id: "ORD-stock-waiting-2" },
      ]))
      .mockReturnValueOnce(inventoryCountQuery(0));
    fulfillMock.mockResolvedValue({
      payment_status: "paid",
      order_status: "pending",
      waiting_for_stock: true,
    });

    const summary = await fulfillPaidOrdersWaitingForStock();

    expect(summary.waiting_for_stock).toBe(1);
    expect(fulfillMock).toHaveBeenCalledTimes(1);
  });
});
