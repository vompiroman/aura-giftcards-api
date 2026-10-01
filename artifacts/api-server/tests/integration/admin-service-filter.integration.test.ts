import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const { fromMock, getUserMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  getUserMock: vi.fn(),
}));
vi.mock("../../src/lib/supabase", () => ({
  supabase: { auth: { getUser: getUserMock }, from: fromMock },
  supabaseAuth: { auth: { getUser: getUserMock }, from: fromMock },
  supabaseAdmin: { auth: { getUser: getUserMock }, from: fromMock },
}));
import app from "../../src/app";

const orders = [
  { order_id: "ORD-netflix", items: [{ name: "Netflix Premium 1 mois" }] },
  { order_id: "ORD-snapchat-3", items: [{ name: "Snapchat+ 3 mois", snapchat_username: "client.snap" }] },
  { order_id: "ORD-snapchat-6", items: JSON.stringify([{ name: "Snapchat+ 6 mois" }]) },
  { order_id: "ORD-spotify", items: [{ name: "Spotify Family 1 mois" }] },
];

describe("admin order service filter", () => {
  beforeEach(() => {
    getUserMock.mockResolvedValue({ data: { user: {
      id: "admin-123", email: "admin@example.com", app_metadata: { role: "admin" },
    } }, error: null });
    const builder: Record<string, any> = {};
    for (const method of ["select", "order", "eq", "or", "gte", "lte"]) {
      builder[method] = vi.fn(() => builder);
    }
    builder.range = vi.fn(async () => ({ data: orders, count: orders.length, error: null }));
    fromMock.mockReturnValue(builder);
  });

  it("returns only Snapchat orders with the correct pagination total", async () => {
    const response = await request(app).get("/api/admin/all-orders?service=Snapchat&page=2&limit=1")
      .set("Authorization", "Bearer test-token").expect(200);
    expect(response.body.orders.map((order: any) => order.order_id)).toEqual(["ORD-snapchat-6"]);
    expect(response.body).toMatchObject({ total: 2, total_pages: 2, page: 2 });
  });

  it("keeps all services visible without a service filter", async () => {
    const response = await request(app).get("/api/admin/all-orders")
      .set("Authorization", "Bearer test-token").expect(200);
    expect(response.body.orders).toHaveLength(4);
  });

  it("rejects non-administrators", async () => {
    getUserMock.mockResolvedValue({ data: { user: {
      id: "client-123", email: "client@example.com", app_metadata: {},
    } }, error: null });
    await request(app).get("/api/admin/all-orders?service=Snapchat")
      .set("Authorization", "Bearer test-token").expect(403);
    expect(fromMock).not.toHaveBeenCalled();
  });
});
