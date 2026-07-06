import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";

// ─── Références de mock partagées (hoistées avant les imports) ────────────
// vi.hoisted garantit que ces fns existent au moment où vi.mock est remonté
// en haut du module, donc avant que `app` (et sa chaîne d'imports) ne charge.
const { notifyAdminMock, rpcMock, fromMock } = vi.hoisted(() => ({
  notifyAdminMock: vi.fn(),
  rpcMock: vi.fn(),
  fromMock: vi.fn(),
}));

// Mock de notifyAdmin : on n'envoie jamais de vrai message Discord en test,
// on capture seulement l'appel et ses arguments.
vi.mock("../../src/lib/notifyAdmin", () => ({
  notifyAdmin: notifyAdminMock,
}));

// Mock du client Supabase utilisé par webhook.ts (`import { supabase } from "../lib/supabase"`).
vi.mock("../../src/lib/supabase", () => ({
  supabase: {
    rpc: rpcMock,
    from: fromMock,
  },
}));

// L'app Express est importée APRÈS les mocks : sa chaîne d'imports les reçoit.
import app from "../../src/app";

// ─── Helpers de payload / réponses Supabase ───────────────────────────────
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "test-webhook-secret";

function webhookPayload(orderId: string) {
  return {
    completed: 1,
    status: "completed",
    order_id: orderId,
    transferId: "TEST-TX-" + orderId,
  };
}

// Construit un builder Supabase minimal et chaînable pour les lectures de commande.
// Chaque méthode renvoie `this` sauf la terminale (maybeSingle) qui résout la row.
function orderQueryStub(orderRow: Record<string, unknown> | null) {
  const builder: Record<string, any> = {};
  for (const m of ["select", "eq", "update", "insert", "is"]) {
    builder[m] = vi.fn(() => builder);
  }
  builder.maybeSingle = vi.fn(async () => ({ data: orderRow, error: null }));
  builder.single = vi.fn(async () => ({ data: orderRow, error: null }));
  builder.then = undefined;
  return builder;
}

describe("Intégration — webhook /webhook (mock notifyAdmin + Supabase)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromMock.mockReturnValue(orderQueryStub({ order_id: "ORD-x", status: "pending", items: [{ name: "Netflix 1 mois", quantity: 1 }] }));
  });

  it("rejette un secret invalide sans jamais alerter l'admin", async () => {
    const res = await request(app)
      .post("/webhook")
      .set("x-webhook-secret", "mauvais-secret")
      .send(webhookPayload("ORD-bad"));

    expect([401, 403]).toContain(res.status);
    expect(notifyAdminMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("stock épuisé : répond 200 + needs_manual et ALERTE l'admin, sans activer", async () => {
    const orderId = "ORD-stockout-1";

    // La RPC lève une exception en base quand le stock est épuisé
    rpcMock.mockResolvedValue({ data: null, error: { message: "OUT_OF_STOCK: Plus de stock Netflix disponible." } });

    const res = await request(app)
      .post("/webhook")
      .set("x-webhook-secret", WEBHOOK_SECRET)
      .send(webhookPayload(orderId));

    expect(res.status).toBe(200);
    expect(res.body.needs_manual).toBe(true);
    expect(notifyAdminMock).toHaveBeenCalledTimes(1);
    expect(notifyAdminMock).toHaveBeenCalledWith(
      expect.stringContaining("Stock épuisé"),
      "critical"
    );
  });

  it("stock disponible : active la commande sans alerter l'admin", async () => {
    const orderId = "ORD-ok-1";

    // La RPC réussit l'assignation
    rpcMock.mockResolvedValue({ data: { assigned_id: "inv-1" }, error: null });

    const res = await request(app)
      .post("/webhook")
      .set("x-webhook-secret", WEBHOOK_SECRET)
      .send(webhookPayload(orderId));

    expect(res.status).toBe(200);
    expect(notifyAdminMock).not.toHaveBeenCalled();
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it("idempotence : un webhook déjà traité n'alerte pas et ne réassigne pas", async () => {
    const orderId = "ORD-dup-1";

    fromMock.mockReturnValue(
      orderQueryStub({ order_id: orderId, status: "completed" })
    );

    const res = await request(app)
      .post("/webhook")
      .set("x-webhook-secret", WEBHOOK_SECRET)
      .send(webhookPayload(orderId));

    expect(res.status).toBe(200);
    expect(notifyAdminMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
