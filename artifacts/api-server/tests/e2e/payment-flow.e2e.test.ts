import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "./helpers/env";
import { apiPost, login } from "./helpers/api";
import { cleanupOrder, countAssignedInventory, getOrder } from "./helpers/supabase-admin";

let token: string;
let orderId: string;
let invoiceId: string;
let serverAmount: number;

describe("E2E — chaîne de paiement Aura Stream", () => {
  beforeAll(async () => {
    token = await login();
    expect(token, "Un token doit être obtenu au login").toBeTruthy();
  });

  afterAll(async () => {
    if (orderId) await cleanupOrder(orderId);
  });

  it("1. crée une commande et recalcule le montant côté serveur", async () => {
    const res = await apiPost<{ order_id: string; amount: number }>(
      "/create-order",
      { items: [{ name: env.ITEM_NAME, quantity: 1 }] },
      { Authorization: `Bearer ${token}` },
    );
    expect(res.ok, JSON.stringify(res.body)).toBe(true);
    orderId = res.body.order_id;
    serverAmount = res.body.amount;
    expect(orderId).toMatch(/^ORD-/);
    expect(serverAmount).toBeGreaterThan(0);
  });

  it("2. ignore un prix et un montant falsifiés", async () => {
    const res = await apiPost<{ order_id: string; amount: number }>(
      "/create-order",
      { items: [{ name: env.ITEM_NAME, quantity: 1, price: 1 }], amount: 1 },
      { Authorization: `Bearer ${token}` },
    );
    expect(res.ok).toBe(true);
    expect(res.body.amount).toBe(serverAmount);
    await cleanupOrder(res.body.order_id);
  });

  it("3. refuse une commande sans authentification", async () => {
    const res = await apiPost("/create-order", { items: [{ name: env.ITEM_NAME, quantity: 1 }] });
    expect(res.status).toBe(401);
  });

  it("4. crée une facture liée à la commande", async () => {
    const res = await apiPost<{ payment_url: string; invoice_id: string; amount: number }>(
      "/create-invoice",
      { order_id: orderId },
      { Authorization: `Bearer ${token}` },
    );
    expect(res.ok, JSON.stringify(res.body)).toBe(true);
    expect(res.body.payment_url).toMatch(/^https:\/\//);
    expect(res.body.amount).toBe(serverAmount);
    invoiceId = res.body.invoice_id;
    expect(invoiceId).toBeTruthy();
  });

  it("5. ne fait jamais confiance à un faux webhook paid", async () => {
    const res = await apiPost(
      "/webhook",
      { invoice_id: invoiceId, order_id: orderId, status: "completed", completed: 1 },
      { "x-webhook-secret": env.WEBHOOK_SECRET },
    );
    expect(res.status).toBe(200);

    const order = await getOrder(orderId);
    expect(order).not.toBeNull();
    expect(order!.payment_status).not.toBe("paid");
    expect(await countAssignedInventory(orderId)).toBe(0);
  });

  it("6. rejette un webhook avec un secret invalide", async () => {
    const res = await apiPost(
      "/webhook",
      { invoice_id: invoiceId, order_id: orderId, status: "completed", completed: 1 },
      { "x-webhook-secret": "mauvais-secret" },
    );
    expect([401, 403]).toContain(res.status);
    expect(await countAssignedInventory(orderId)).toBe(0);
  });
});
