import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const { fromMock, getUserMock, state } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  getUserMock: vi.fn(),
  state: { accounts: [] as Array<Record<string, unknown>> },
}));

vi.mock("../../src/lib/supabase", () => ({
  supabase: { auth: { getUser: getUserMock }, from: fromMock },
  supabaseAuth: { auth: { getUser: getUserMock }, from: fromMock },
  supabaseAdmin: { auth: { getUser: getUserMock }, from: fromMock },
}));

import app from "../../src/app";

function ordersBuilder() {
  const builder: Record<string, any> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.in = vi.fn(() => builder);
  builder.order = vi.fn(async () => ({
    data: [{
      id: "database-order-id",
      order_id: "ORD-multi-netflix",
      assigned_email: "client@example.com",
      amount: 1_200,
      status: "pending",
      payment_status: "paid",
      items: [{ name: "Netflix Premium 1 mois", quantity: 2 }],
      created_at: "2026-08-24T12:00:00.000Z",
      expires_at: null,
      activated_at: null,
    }],
    error: null,
  }));
  return builder;
}

function inventoryBuilder() {
  const builder: Record<string, any> = {};
  builder.select = vi.fn(() => builder);
  builder.in = vi.fn(async () => ({ data: state.accounts, error: null }));
  return builder;
}

describe("GET /api/my-orders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserMock.mockResolvedValue({
      data: { user: { id: "user-123", email: "client@example.com" } },
      error: null,
    });
    fromMock.mockImplementation((table: string) => table === "orders" ? ordersBuilder() : inventoryBuilder());
  });

  it("retourne tous les profils attribués sans exposer leurs secrets", async () => {
    state.accounts = [
      { id: "inventory-1", assigned_order_id: "ORD-multi-netflix", account_email: "one@example.com", profile_name: "Aura 1", profile_pin: "1111", service: "Netflix" },
      { id: "inventory-2", assigned_order_id: "ORD-multi-netflix", account_email: "two@example.com", profile_name: "Aura 2", profile_pin: "2222", service: "Netflix" },
    ];

    const response = await request(app)
      .get("/api/my-orders")
      .set("Authorization", "Bearer valid-test-token");

    expect(response.status).toBe(200);
    expect(response.body.orders[0].waiting_for_stock).toBe(false);
    expect(response.body.orders[0].accounts).toHaveLength(2);
    expect(response.body.orders[0].account.id).toBe("inventory-1");
    expect(JSON.stringify(response.body)).not.toContain("password");
  });

  it("signale le stock incomplet lorsque tous les profils n'ont pas été attribués", async () => {
    state.accounts = [
      { id: "inventory-1", assigned_order_id: "ORD-multi-netflix", account_email: "one@example.com", profile_name: "Aura 1", profile_pin: "1111", service: "Netflix" },
    ];

    const response = await request(app)
      .get("/api/my-orders")
      .set("Authorization", "Bearer valid-test-token");

    expect(response.status).toBe(200);
    expect(response.body.orders[0].waiting_for_stock).toBe(true);
    expect(response.body.orders[0].accounts).toHaveLength(1);
  });
});
