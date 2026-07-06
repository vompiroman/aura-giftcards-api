import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { env } from "./helpers/env";
import { apiPost, login } from "./helpers/api";
import {
  getOrder,
  countAssignedInventory,
  cleanupOrder,
  lockAllStock,
  releaseLockedStock,
} from "./helpers/supabase-admin";

// État partagé entre les étapes (la suite est séquentielle par nature).
let token: string;
let orderId: string;
let serverAmount: number;

// Payload webhook aligné sur ton handler (lit order_id, teste completed/status).
function webhookPayload(oid: string) {
  return {
    completed: 1,
    status: "completed",
    order_id: oid,
    transferId: "TEST-TX-" + oid,
  };
}

describe("E2E — chaîne de paiement Aura Stream", () => {
  beforeAll(async () => {
    token = await login();
    expect(token, "Un token doit être obtenu au login").toBeTruthy();
  });

  afterAll(async () => {
    // Nettoyage best-effort : on ne veut pas polluer la base de staging.
    if (orderId) {
      await cleanupOrder(orderId);
    }
  });

  it("1. crée une commande et recalcule le montant côté serveur", async () => {
    const res = await apiPost<{ order_id: string; amount: number }>(
      "/create-order",
      { items: [{ name: env.ITEM_NAME, quantity: 1 }] },
      { Authorization: `Bearer ${token}` }
    );

    expect(res.ok, `create-order a échoué : ${JSON.stringify(res.body)}`).toBe(true);
    expect(res.body.order_id).toBeTruthy();
    expect(res.body.amount).toBeGreaterThan(0);

    orderId = res.body.order_id;
    serverAmount = res.body.amount;
  });

  it("2. ignore tout prix falsifié envoyé par le client (anti-tampering)", async () => {
    const res = await apiPost<{ amount: number }>(
      "/create-order",
      // On injecte un prix et un montant bidons : le serveur DOIT les ignorer.
      { items: [{ name: env.ITEM_NAME, quantity: 1, price: 1 }], amount: 1 },
      { Authorization: `Bearer ${token}` }
    );

    expect(res.ok).toBe(true);
    // Le montant recalculé doit être identique au montant légitime, pas à 1.
    expect(res.body.amount).toBe(serverAmount);

    // Cette commande parasite est nettoyée immédiatement pour ne pas fausser l'inventaire.
    if ((res.body as any).order_id) {
      await cleanupOrder((res.body as any).order_id);
    }
  });

  it("3. refuse /create-order sans token (401)", async () => {
    const res = await apiPost(
      "/create-order",
      { items: [{ name: env.ITEM_NAME, quantity: 1 }] }
      // pas d'Authorization
    );
    expect(res.status).toBe(401);
  });

  it("4. crée une facture en relisant le montant en base", async () => {
    const res = await apiPost<{ payment_url: string }>(
      "/create-invoice",
      { order_id: orderId },
      { Authorization: `Bearer ${token}` }
    );

    expect(res.ok, `create-invoice a échoué : ${JSON.stringify(res.body)}`).toBe(true);
    expect(res.body.payment_url).toMatch(/^https?:\/\//);
  });

  it("5. active la commande sur webhook 'completed' (statut + inventaire)", async () => {
    const res = await apiPost(
      "/webhook",
      webhookPayload(orderId),
      { "x-webhook-secret": env.WEBHOOK_SECRET }
    );
    expect(res.status, `webhook : ${JSON.stringify(res.body)}`).toBe(200);

    // Assertion base : la commande est passée à 'completed'.
    const order = await getOrder(orderId);
    expect(order, "La commande doit exister en base").not.toBeNull();
    expect(order!.status).toBe("completed");
    expect(order!.amount).toBe(serverAmount);

    // Assertion base : exactement UN item d'inventaire assigné (assignation atomique).
    const assigned = await countAssignedInventory(orderId);
    expect(assigned).toBe(1);
  });

  it("6. est idempotent : rejouer le webhook ne double PAS l'assignation", async () => {
    const res = await apiPost(
      "/webhook",
      webhookPayload(orderId),
      { "x-webhook-secret": env.WEBHOOK_SECRET }
    );
    expect(res.status).toBe(200);

    // Toujours exactement 1 : aucun second compte assigné malgré le rejeu.
    const assigned = await countAssignedInventory(orderId);
    expect(assigned).toBe(1);
  });

  it("7. rejette un webhook avec un secret invalide (401/403)", async () => {
    const res = await apiPost(
      "/webhook",
      webhookPayload(orderId),
      { "x-webhook-secret": "mauvais-secret" }
    );
    expect([401, 403]).toContain(res.status);

    // Sécurité : l'assignation ne doit pas avoir bougé après une tentative non authentifiée.
    const assigned = await countAssignedInventory(orderId);
    expect(assigned).toBe(1);
  });
});

describe("E2E — chemin 'stock épuisé' (client payé, plus d'inventaire)", () => {
  let token: string;
  let orderId: string;
  let lockedCount = 0;

  // Payload identique à celui du flux nominal (aligné sur ton webhook.ts).
  function webhookPayload(oid: string) {
    return {
      completed: 1,
      status: "completed",
      order_id: oid,
      transferId: "TEST-TX-" + oid,
    };
  }

  beforeAll(async () => {
    token = await login();
    // On vide tout le stock du service testé pour forcer la rupture.
    lockedCount = await lockAllStock(env.ITEM_SERVICE);
  });

  afterAll(async () => {
    // Libération best-effort dans tous les cas, même si un test a échoué.
    await releaseLockedStock(env.ITEM_SERVICE);
    if (orderId) {
      await cleanupOrder(orderId);
    }
  });

  it("0. précondition : le stock du service est bien vidé", () => {
    // S'il n'y avait aucun stock au départ, le test n'aurait aucune valeur :
    // on exige explicitement qu'on ait réellement verrouillé au moins 1 compte.
    expect(
      lockedCount,
      `Aucun stock à verrouiller pour "${env.ITEM_SERVICE}" : ajoute de l'inventaire de test avant de lancer ce scénario.`
    ).toBeGreaterThan(0);
  });

  it("1. crée la commande de test (stock déjà vide)", async () => {
    const res = await apiPost<{ order_id: string; amount: number }>(
      "/create-order",
      { items: [{ name: env.ITEM_NAME, quantity: 1 }] },
      { Authorization: `Bearer ${token}` }
    );
    expect(res.ok, `create-order : ${JSON.stringify(res.body)}`).toBe(true);
    expect(res.body.order_id).toBeTruthy();
    orderId = res.body.order_id;
  });

  it("2. webhook payé sans stock → 200 + needs_manual, SANS activation", async () => {
    const res = await apiPost<{ received?: boolean; needs_manual?: boolean }>(
      "/webhook",
      webhookPayload(orderId),
      { "x-webhook-secret": env.WEBHOOK_SECRET }
    );

    // Le webhook ne doit JAMAIS boucler ni renvoyer 5xx : il accuse réception en 200…
    expect(res.status, `webhook : ${JSON.stringify(res.body)}`).toBe(200);
    // …mais signale explicitement qu'une intervention manuelle est requise.
    expect(res.body.needs_manual).toBe(true);
  });

  it("3. aucune activation : la commande reste 'pending' (rollback)", async () => {
    const order = await getOrder(orderId);
    expect(order, "La commande doit exister").not.toBeNull();
    // Rollback PostgreSQL : la commande revient à son état initial exact.
    expect(order!.status).toBe("pending");
  });

  it("4. aucun inventaire assigné (rollback atomique de la RPC)", async () => {
    // Le cœur de la garantie : malgré le paiement, RIEN n'a été assigné.
    const assigned = await countAssignedInventory(orderId);
    expect(assigned).toBe(0);
  });

  it("5. idempotence en rupture : rejouer ne crée toujours aucune assignation", async () => {
    const res = await apiPost(
      "/webhook",
      webhookPayload(orderId),
      { "x-webhook-secret": env.WEBHOOK_SECRET }
    );
    expect(res.status).toBe(200);

    const assigned = await countAssignedInventory(orderId);
    expect(assigned).toBe(0);
  });
});
