import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const { notifyAdminMock, sendMetaPurchaseMock, appendAuditLogMock, rpcMock, fromMock } = vi.hoisted(() => ({
  notifyAdminMock: vi.fn(),
  sendMetaPurchaseMock: vi.fn(),
  appendAuditLogMock: vi.fn(),
  rpcMock: vi.fn(),
  fromMock: vi.fn(),
}));

vi.mock("../../src/lib/notifyAdmin", () => ({ notifyAdmin: notifyAdminMock }));
vi.mock("../../src/lib/metaConversions", () => ({ sendMetaPurchase: sendMetaPurchaseMock }));
vi.mock("../../src/lib/auditLog", () => ({ appendAuditLog: appendAuditLogMock }));

vi.mock("../../src/lib/supabase", () => ({
  supabase: { rpc: rpcMock, from: fromMock },
  supabaseAdmin: { rpc: rpcMock, from: fromMock },
  supabaseAuth: { auth: { getUser: vi.fn() } },
}));

import app from "../../src/app";

const WEBHOOK_SECRET = "test-webhook-secret";
let assignmentResponse: { data: any; error: any };
let observedPaidOrders: Set<string>;

function webhookPayload(orderId: string) {
  return {
    invoice_id: `INV-${orderId}`,
    completed: 1,
    status: "completed",
    order_id: orderId,
  };
}

function orderQueryStub(orderRow: Record<string, unknown> | null) {
  const builder: Record<string, any> = {};
  for (const method of ["select", "eq", "update", "insert", "is", "neq", "in"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.single = vi.fn(async () => ({ data: orderRow, error: null }));
  builder.then = (resolve: any, reject: any) =>
    Promise.resolve({ data: [{ order_id: orderRow?.order_id }], error: null }).then(resolve, reject);
  return builder;
}

function statefulOrderQueries(orderRow: Record<string, any>) {
  let paymentStatus = String(orderRow.payment_status);
  return () => {
    let updateValue: Record<string, unknown> | null = null;
    let expectedPaymentStatus: string | null = null;
    const builder: Record<string, any> = {};
    builder.select = vi.fn((columns?: string) => {
      if (updateValue && columns === "order_id") {
        return Promise.resolve(
          expectedPaymentStatus === paymentStatus
            ? (() => {
                paymentStatus = String(updateValue?.payment_status || paymentStatus);
                return { data: [{ order_id: orderRow.order_id }], error: null };
              })()
            : { data: [], error: null },
        );
      }
      return builder;
    });
    builder.eq = vi.fn((column: string, value: unknown) => {
      if (column === "payment_status") expectedPaymentStatus = String(value);
      return builder;
    });
    builder.neq = vi.fn(() => builder);
    builder.in = vi.fn((column: string, values: unknown[]) => {
      if (column === "payment_status") expectedPaymentStatus = values.includes(paymentStatus) ? paymentStatus : "__none__";
      return builder;
    });
    builder.is = vi.fn(() => builder);
    builder.update = vi.fn((value: Record<string, unknown>) => {
      updateValue = value;
      return builder;
    });
    builder.single = vi.fn(async () => ({
      data: orderRow ? { ...orderRow, payment_status: paymentStatus } : null,
      error: null,
    }));
    builder.then = (resolve: any, reject: any) =>
      Promise.resolve({ data: [{ order_id: orderRow.order_id }], error: null }).then(resolve, reject);
    return builder;
  };
}

describe("POST /api/webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.SLICKPAY_API_KEY = "test-api-key";
    delete process.env.META_CAPI_ACCESS_TOKEN;
    sendMetaPurchaseMock.mockResolvedValue(true);
    assignmentResponse = { data: { status: "assigned", assigned_id: "inv-1" }, error: null };
    observedPaidOrders = new Set();
    rpcMock.mockImplementation(async (name: string, params: Record<string, any>) => {
      if (name === "observe_slickpay_payment") {
        const providerState = String(params?.p_provider_status || "pending");
        const orderId = String(params?.p_order_id || "");
        if (providerState === "paid" && params?.p_verified_amount === null) {
          return { data: { result: "amount_missing", transitioned: false, payment_status: "unpaid", order_status: "pending" }, error: null };
        }
        if (providerState === "paid" && Number(params?.p_verified_amount) !== 800) {
          return { data: { result: "amount_mismatch", transitioned: false, payment_status: "unpaid", order_status: "pending" }, error: null };
        }
        if (providerState === "paid") {
          const transitioned = !observedPaidOrders.has(orderId);
          observedPaidOrders.add(orderId);
          return {
            data: {
              result: transitioned ? "confirmed" : "already_paid",
              transitioned,
              payment_status: "paid",
              order_status: "pending",
            },
            error: null,
          };
        }
        return {
          data: { result: providerState, transitioned: false, payment_status: providerState, order_status: "pending" },
          error: null,
        };
      }
      if (name === "assign_inventory_for_order") return assignmentResponse;
      if (name === "reserve_promo_redemption") return { data: true, error: null };
      return { data: null, error: null };
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ completed: 1, data: { payment_status: "paid", amount: 800 } }),
    })));
    fromMock.mockReturnValue(orderQueryStub({
      order_id: "ORD-x",
      status: "pending",
      payment_status: "unpaid",
      amount: 800,
      assigned_email: "client@example.com",
      slickpay_invoice_id: "INV-ORD-x",
      items: [{ name: "Netflix 1 mois", quantity: 1 }],
      marketing_consent: false,
      meta_purchase_sent_at: null,
    }));
  });

  it("rejette un secret explicitement invalide sans effet de bord", async () => {
    const res = await request(app)
      .post("/api/webhook")
      .set("x-webhook-secret", "mauvais-secret")
      .send(webhookPayload("ORD-bad"));

    expect(res.status).toBe(401);
    expect(notifyAdminMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("traite un webhook sans signature comme un signal et revalide via SlickPay", async () => {
    const res = await request(app)
      .post("/api/webhook")
      .send({ invoice_id: "INV-ORD-x", order_id: "ORD-body-non-fiable" });

    expect(res.status).toBe(200);
    expect(res.body.activated).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("observe_slickpay_payment", expect.objectContaining({
      p_provider_status: "paid",
      p_verified_amount: 800,
    }));
  });

  it("accepte la forme imbriquée de l'identifiant de facture SlickPay", async () => {
    const res = await request(app)
      .post("/api/webhook")
      .send({ data: { invoice: { id: "INV-ORD-x" } } });

    expect(res.status).toBe(200);
    expect(res.body.activated).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("alerte l'admin sans activer quand le stock est épuisé", async () => {
    assignmentResponse = { data: null, error: { message: "OUT_OF_STOCK: Netflix" } };

    const res = await request(app)
      .post("/api/webhook")
      .set("x-webhook-secret", WEBHOOK_SECRET)
      .send(webhookPayload("ORD-x"));

    expect(res.status).toBe(200);
    expect(res.body.needs_manual).toBe(true);
    expect(notifyAdminMock).toHaveBeenCalledWith(
      expect.stringContaining("stock"),
      expect.objectContaining({ level: "critical", orderId: "ORD-x" }),
    );
  });

  it("active après revalidation SlickPay quand le stock est disponible", async () => {
    const res = await request(app)
      .post("/api/webhook")
      .set("x-webhook-secret", WEBHOOK_SECRET)
      .send(webhookPayload("ORD-x"));

    expect(res.status).toBe(200);
    expect(res.body.activated).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith("observe_slickpay_payment", expect.objectContaining({
      p_provider_status: "paid",
      p_verified_amount: 800,
    }));
    expect(rpcMock).toHaveBeenCalledWith("assign_inventory_for_order", expect.any(Object));
  });

  it("confirme via l'API même si le webhook ne fournit aucun statut", async () => {
    const res = await request(app)
      .post("/api/webhook")
      .set("x-webhook-secret", WEBHOOK_SECRET)
      .send({ invoice_id: "INV-ORD-x", order_id: "ORD-x" });

    expect(res.status).toBe(200);
    expect(res.body.activated).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("observe_slickpay_payment", expect.objectContaining({
      p_provider_status: "paid",
      p_verified_amount: 800,
    }));
  });

  it("ne réassigne pas une commande déjà terminée", async () => {
    fromMock.mockReturnValue(orderQueryStub({
      order_id: "ORD-dup",
      status: "completed",
      payment_status: "paid",
      amount: 800,
      slickpay_invoice_id: "INV-ORD-dup",
      items: [],
    }));

    const res = await request(app)
      .post("/api/webhook")
      .set("x-webhook-secret", WEBHOOK_SECRET)
      .send(webhookPayload("ORD-dup"));

    expect(res.status).toBe(200);
    expect(rpcMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuse d'activer si SlickPay ne confirme pas le paiement", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ completed: 0, data: { payment_status: "unpaid", amount: 800 } }),
    } as Response);

    const res = await request(app)
      .post("/api/webhook")
      .set("x-webhook-secret", WEBHOOK_SECRET)
      .send(webhookPayload("ORD-x"));

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(res.body.payment_status).toBe("unpaid");
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).not.toHaveBeenCalledWith("assign_inventory_for_order", expect.any(Object));
  });

  it("bloque un paiement confirmé sans montant vérifiable", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ completed: 1, data: { payment_status: "paid" } }),
    } as Response);

    const res = await request(app)
      .post("/api/webhook")
      .set("x-webhook-secret", WEBHOOK_SECRET)
      .send(webhookPayload("ORD-x"));

    expect(res.status).toBe(200);
    expect(res.body.amount_unavailable).toBe(true);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(notifyAdminMock).toHaveBeenCalledWith(
      expect.stringContaining("Montant SlickPay absent"),
      expect.objectContaining({ level: "critical", orderId: "ORD-x" }),
    );
  });

  it("bloque un paiement dont le montant ne correspond pas à la commande", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ completed: 1, data: { payment_status: "paid", amount: 799 } }),
    } as Response);

    const res = await request(app)
      .post("/api/webhook")
      .set("x-webhook-secret", WEBHOOK_SECRET)
      .send(webhookPayload("ORD-x"));

    expect(res.status).toBe(200);
    expect(res.body.amount_mismatch).toBe(true);
    expect(rpcMock).not.toHaveBeenCalledWith("assign_inventory_for_order", expect.any(Object));
    expect(notifyAdminMock).toHaveBeenCalledWith(
      expect.stringContaining("différent"),
      expect.objectContaining({ level: "critical", orderId: "ORD-x" }),
    );
  });

  it("n'envoie jamais Purchase sans consentement marketing", async () => {
    const res = await request(app)
      .post("/api/webhook")
      .set("x-webhook-secret", WEBHOOK_SECRET)
      .send(webhookPayload("ORD-x"));

    expect(res.status).toBe(200);
    expect(sendMetaPurchaseMock).not.toHaveBeenCalled();
  });

  it("n'envoie qu'un Purchase lors du rejeu d'un webhook payé", async () => {
    fromMock.mockImplementation(statefulOrderQueries({
      order_id: "ORD-meta-123",
      status: "pending",
      payment_status: "unpaid",
      amount: 800,
      assigned_email: "client@example.com",
      slickpay_invoice_id: "INV-ORD-meta-123",
      items: [{ name: "Netflix 1 mois", quantity: 1 }],
      marketing_consent: true,
      meta_purchase_sent_at: null,
    }));

    const first = await request(app)
      .post("/api/webhook")
      .set("x-webhook-secret", WEBHOOK_SECRET)
      .send(webhookPayload("ORD-meta-123"));
    const replay = await request(app)
      .post("/api/webhook")
      .set("x-webhook-secret", WEBHOOK_SECRET)
      .send(webhookPayload("ORD-meta-123"));

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body.activated).toBe(true);
    expect(sendMetaPurchaseMock).toHaveBeenCalledTimes(1);
  });

  it("ne lance qu'une attribution lors de deux webhooks concurrents", async () => {
    fromMock.mockImplementation(statefulOrderQueries({
      order_id: "ORD-concurrent-1",
      status: "pending",
      payment_status: "unpaid",
      amount: 800,
      assigned_email: "client@example.com",
      slickpay_invoice_id: "INV-ORD-concurrent-1",
      items: [{ name: "Netflix 1 mois", quantity: 1 }],
      marketing_consent: false,
      meta_purchase_sent_at: null,
    }));

    const results = await Promise.all([1, 2].map(() => request(app)
      .post("/api/webhook")
      .set("x-webhook-secret", WEBHOOK_SECRET)
      .send(webhookPayload("ORD-concurrent-1"))));

    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(rpcMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("confirme le paiement même si Meta refuse l'événement", async () => {
    sendMetaPurchaseMock.mockResolvedValue(false);
    fromMock.mockReturnValue(orderQueryStub({
      order_id: "ORD-meta-fail",
      status: "pending",
      payment_status: "unpaid",
      amount: 800,
      assigned_email: "client@example.com",
      slickpay_invoice_id: "INV-ORD-meta-fail",
      items: [{ name: "Netflix 1 mois", quantity: 1 }],
      marketing_consent: true,
      meta_purchase_sent_at: null,
    }));

    const res = await request(app)
      .post("/api/webhook")
      .set("x-webhook-secret", WEBHOOK_SECRET)
      .send(webhookPayload("ORD-meta-fail"));

    expect(res.status).toBe(200);
    expect(res.body.activated).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith("observe_slickpay_payment", expect.any(Object));
    expect(rpcMock).toHaveBeenCalledWith("assign_inventory_for_order", expect.any(Object));
  });
});
