import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const { getUserMock, rpcMock, fromMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  rpcMock: vi.fn(),
  fromMock: vi.fn(),
}));

vi.mock("../../src/lib/supabase", () => ({
  supabase: { from: fromMock, rpc: rpcMock },
  supabaseAdmin: { from: fromMock, rpc: rpcMock },
  supabaseAuth: { auth: { getUser: getUserMock } },
}));

import app from "../../src/app";

const VALID_TOKEN = "valid-test-token";

function orderInsertStub() {
  const builder: Record<string, any> = {};
  builder.insert = vi.fn(() => builder);
  builder.select = vi.fn(async () => ({ data: [{ order_id: "ORD-test" }], error: null }));
  return builder;
}

describe("POST /api/create-order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserMock.mockResolvedValue({
      data: { user: { id: "user-123", email: "e2e-tester@exemple.com" } },
      error: null,
    });
    fromMock.mockReturnValue(orderInsertStub());
  });

  it("refuse une requête sans token", async () => {
    const res = await request(app)
      .post("/api/create-order")
      .send({ items: [{ name: "Netflix 1 mois", quantity: 1 }] });

    expect(res.status).toBe(401);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("recalcule le montant côté serveur", async () => {
    const res = await request(app)
      .post("/api/create-order")
      .set("Authorization", `Bearer ${VALID_TOKEN}`)
      .send({
        items: [{ name: "Netflix 1 mois", quantity: 1, price: 1 }],
        amount: 1,
      });

    expect(res.status).toBe(201);
    expect(res.body.order_id).toMatch(/^ORD-/);
    expect(res.body.amount).toBe(600);
  });

  it("rejette un article inconnu", async () => {
    const res = await request(app)
      .post("/api/create-order")
      .set("Authorization", `Bearer ${VALID_TOKEN}`)
      .send({ items: [{ name: "Article-Inexistant-XYZ", quantity: 1 }] });

    expect(res.status).toBe(400);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it.each([
    { items: [] },
    { items: [{ name: "Netflix 1 mois", quantity: 0 }] },
  ])("rejette un panier invalide", async (body) => {
    const res = await request(app)
      .post("/api/create-order")
      .set("Authorization", `Bearer ${VALID_TOKEN}`)
      .send(body);

    expect(res.status).toBe(400);
  });
});
