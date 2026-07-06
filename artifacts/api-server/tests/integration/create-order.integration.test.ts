import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";

// Références de mock hoistées avant les imports de la chaîne applicative.
const { getUserMock, rpcMock, fromMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  rpcMock: vi.fn(),
  fromMock: vi.fn(),
}));

// Client Supabase mocké : auth (token), rpc et from (insertions/lectures).
vi.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: { getUser: getUserMock },
    rpc: rpcMock,
    from: fromMock,
  },
}));

import app from "../../src/app";

const VALID_TOKEN = "valid-test-token";

// Utilisateur authentifié standard renvoyé par auth.getUser sur un token valide.
function authOk() {
  getUserMock.mockResolvedValue({
    data: { user: { id: "user-123", email: "e2e-tester@exemple.com" } },
    error: null,
  });
}

function orderQueryStub() {
  const builder: Record<string, any> = {};
  for (const m of ["select", "eq", "update", "insert", "is", "delete", "maybeSingle", "single"]) {
    builder[m] = vi.fn(async () => ({ data: null, error: null }));
  }
  builder.then = undefined;
  return builder;
}

describe("Intégration — POST /create-order (recalcul serveur + rejet articles inconnus)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authOk();
    fromMock.mockReturnValue(orderQueryStub());
  });

  it("refuse la requête sans token (401) sans rien créer", async () => {
    const res = await request(app)
      .post("/create-order")
      .send({ items: [{ name: "Netflix 1 mois", quantity: 1 }] });

    expect(res.status).toBe(401);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("recalcule le montant côté serveur et IGNORE tout prix envoyé par le client", async () => {
    // Le catalogue serveur fixe Netflix 1 mois à 600 DA dans PRICES
    const res = await request(app)
      .post("/create-order")
      .set("Authorization", `Bearer ${VALID_TOKEN}`)
      .send({
        items: [{ name: "Netflix 1 mois", quantity: 1, price: 1 }],
        amount: 1, // tentative de tampering
      });

    expect([200, 201]).toContain(res.status);
    expect(res.body.order_id).toMatch(/^ORD-/);
    // Le montant renvoyé est le montant serveur, pas le montant falsifié.
    expect(res.body.amount).toBe(600);
    expect(res.body.amount).not.toBe(1);
  });

  it("rejette un article inconnu (400) sans créer de commande", async () => {
    const res = await request(app)
      .post("/create-order")
      .set("Authorization", `Bearer ${VALID_TOKEN}`)
      .send({ items: [{ name: "Article-Inexistant-XYZ", quantity: 1 }] });

    expect(res.status).toBe(400);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("rejette un panier vide (400)", async () => {
    const res = await request(app)
      .post("/create-order")
      .set("Authorization", `Bearer ${VALID_TOKEN}`)
      .send({ items: [] });

    expect(res.status).toBe(400);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("rejette une quantité invalide (400)", async () => {
    const res = await request(app)
      .post("/create-order")
      .set("Authorization", `Bearer ${VALID_TOKEN}`)
      .send({ items: [{ name: "Netflix 1 mois", quantity: 0 }] });

    expect(res.status).toBe(400);
    expect(fromMock).not.toHaveBeenCalled();
  });
});
