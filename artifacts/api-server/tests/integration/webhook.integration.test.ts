import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const { notifyAdminMock, rpcMock, fromMock } = vi.hoisted(() => ({
  notifyAdminMock: vi.fn(),
  rpcMock: vi.fn(),
  fromMock: vi.fn(),
}));

vi.mock("../../src/lib/notifyAdmin", () => ({ notifyAdmin: notifyAdminMock }));

vi.mock("../../src/lib/supabase", () => ({
  supabase: { rpc: rpcMock, from: fromMock },
  supabaseAdmin: { rpc: rpcMock, from: fromMock },
  supabaseAuth: { auth: { getUser: vi.fn() } },
}));

import app from "../../src/app";

const WEBHOOK_SECRET = "test-webhook-secret";

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
  for (const method of ["select", "eq", "update", "insert", "is", "neq"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.single = vi.fn(async () => ({ data: orderRow, error: null }));
  builder.then = (resolve: any, reject: any) =>
    Promise.resolve({ data: [{ order_id: orderRow?.order_id }], error: null }).then(resolve, reject);
  return builder;
}

describe("POST /api/webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.SLICKPAY_API_KEY = "test-api-key";
    delete process.env.META_CAPI_ACCESS_TOKEN;
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
    }));
  });

  it("rejette un secret invalide sans effet de bord", async () => {
    const res = await request(app)
      .post("/api/webhook")
      .set("x-webhook-secret", "mauvais-secret")
      .send(webhookPayload("ORD-bad"));

    expect(res.status).toBe(401);
    expect(notifyAdminMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("alerte l'admin sans activer quand le stock est épuisé", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "OUT_OF_STOCK: Netflix" } });

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
    rpcMock.mockResolvedValue({ data: { assigned_id: "inv-1" }, error: null });

    const res = await request(app)
      .post("/api/webhook")
      .set("x-webhook-secret", WEBHOOK_SECRET)
      .send(webhookPayload("ORD-x"));

    expect(res.status).toBe(200);
    expect(res.body.activated).toBe(true);
    expect(rpcMock).toHaveBeenCalledTimes(1);
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
    expect(res.body.verified).toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
