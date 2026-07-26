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

function orderSelectStub(data: Record<string, unknown>) {
  const builder: Record<string, any> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.single = vi.fn(async () => ({ data, error: null }));
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

  it("enregistre le consentement marketing avec sa version", async () => {
    const builder = orderInsertStub();
    fromMock.mockReturnValue(builder);

    const res = await request(app)
      .post("/api/create-order")
      .set("Authorization", `Bearer ${VALID_TOKEN}`)
      .send({
        items: [{ name: "Spotify 1 mois", quantity: 1 }],
        marketing_consent: true,
        marketing_consent_version: "2026-07-26",
        marketing_consent_at: "2000-01-01T00:00:00.000Z",
      });

    expect(res.status).toBe(201);
    expect(builder.insert).toHaveBeenCalledWith(expect.objectContaining({
      marketing_consent: true,
      marketing_consent_at: expect.any(String),
      consent_version: "2026-07-26",
    }));
    const inserted = builder.insert.mock.calls[0][0];
    expect(inserted.marketing_consent_at).not.toBe("2000-01-01T00:00:00.000Z");
  });

  it("rejette une version de consentement inconnue", async () => {
    const builder = orderInsertStub();
    fromMock.mockReturnValue(builder);

    const res = await request(app)
      .post("/api/create-order")
      .set("Authorization", `Bearer ${VALID_TOKEN}`)
      .send({
        items: [{ name: "Spotify 1 mois", quantity: 1 }],
        marketing_consent: true,
        marketing_consent_version: "ancienne-version",
      });

    expect(res.status).toBe(400);
    expect(builder.insert).not.toHaveBeenCalled();
  });

  it("refuse implicitement le suivi marketing sans consentement explicite", async () => {
    const builder = orderInsertStub();
    fromMock.mockReturnValue(builder);

    const res = await request(app)
      .post("/api/create-order")
      .set("Authorization", `Bearer ${VALID_TOKEN}`)
      .send({ items: [{ name: "Netflix 1 mois", quantity: 1 }] });

    expect(res.status).toBe(201);
    expect(builder.insert).toHaveBeenCalledWith(expect.objectContaining({
      marketing_consent: false,
      marketing_consent_at: null,
      consent_version: null,
    }));
  });

  it("retourne le montant serveur et les articles au propriétaire", async () => {
    fromMock.mockReturnValue(orderSelectStub({
      order_id: "ORD-owner-123",
      assigned_email: "e2e-tester@exemple.com",
      status: "pending",
      payment_status: "paid",
      expires_at: null,
      amount: 800,
      items: [{
        name: "Spotify 1 mois",
        client_credentials: { email: "secret@example.com", password: "secret" },
      }],
    }));

    const res = await request(app)
      .get("/api/validate-order?id=ORD-owner-123")
      .set("Authorization", `Bearer ${VALID_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(800);
    expect(res.body.items).toEqual([expect.objectContaining({
      name: "Spotify 1 mois",
      client_credentials_submitted: true,
    })]);
    expect(JSON.stringify(res.body)).not.toContain("secret@example.com");
  });

  it("ne divulgue ni montant ni articles à un autre client", async () => {
    fromMock.mockReturnValue(orderSelectStub({
      order_id: "ORD-other-123",
      assigned_email: "other@example.com",
      status: "pending",
      payment_status: "paid",
      expires_at: null,
      amount: 800,
      items: [{ name: "Netflix 1 mois" }],
    }));

    const res = await request(app)
      .get("/api/validate-order?id=ORD-other-123")
      .set("Authorization", `Bearer ${VALID_TOKEN}`);

    expect(res.status).toBe(403);
    expect(res.body.amount).toBeUndefined();
    expect(res.body.items).toBeUndefined();
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
