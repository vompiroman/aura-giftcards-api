import { beforeEach, expect, it, vi } from "vitest";
import request from "supertest";

const { from, upsert, select, ilike, eq, is, limit } = vi.hoisted(() => ({
  from: vi.fn(), upsert: vi.fn(), select: vi.fn(), ilike: vi.fn(), eq: vi.fn(), is: vi.fn(), limit: vi.fn(),
}));
vi.mock("../../src/lib/supabase", () => ({
  supabaseAdmin: { from },
  supabaseAuth: { auth: {} },
}));

import app from "../../src/app";

const origin = "https://www.aura-stream.com";
const event = {
  journey_id: "550e8400-e29b-41d4-a716-446655440000",
  services: ["netflix", "netflix", "snapchat"],
  stage: "cart_view",
};

beforeEach(() => {
  from.mockReturnValue({ upsert, select });
  upsert.mockResolvedValue({ error: null });
});

it("writes minimized, idempotent rows for the consenting browser", async () => {
  await request(app).post("/api/checkout-funnel").set("Origin", origin).send(event).expect(204);
  expect(from).toHaveBeenCalledWith("checkout_funnel_events");
  expect(upsert).toHaveBeenCalledWith([
    { journey_id: event.journey_id, service: "netflix", stage: "cart_view" },
    { journey_id: event.journey_id, service: "snapchat", stage: "cart_view" },
  ], { onConflict: "journey_id,service,stage", ignoreDuplicates: true });
});

it("rejects unknown fields, fabricated purchase milestones and cross-origin events", async () => {
  await request(app).post("/api/checkout-funnel").set("Origin", origin)
    .send({ ...event, email: "ignored@example.invalid" }).expect(400);
  await request(app).post("/api/checkout-funnel").set("Origin", origin)
    .send({ ...event, stage: "purchase" }).expect(400);
  await request(app).post("/api/checkout-funnel").set("Origin", "https://elsewhere.example").send(event).expect(403);
  await request(app).post("/api/checkout-funnel").send(event).expect(403);
  await request(app).get("/api/admin/checkout-funnel").expect(401);
  expect(from).not.toHaveBeenCalled();
});

it("only exposes a boolean on the public stock route", async () => {
  select.mockReturnValue({ ilike });
  ilike.mockReturnValue({ eq });
  eq.mockReturnValue({ is });
  is.mockReturnValue({ limit });
  limit.mockResolvedValueOnce({ data: [{ id: "private-row" }] }).mockResolvedValueOnce({ data: [] })
    .mockResolvedValueOnce({ error: { message: "offline" } });
  expect((await request(app).get("/api/catalog/netflix-availability").expect(200)).body).toEqual({ available: true });
  expect((await request(app).get("/api/catalog/netflix-availability").expect(200)).body).toEqual({ available: false });
  await request(app).get("/api/catalog/netflix-availability").expect(503);
  expect(is).toHaveBeenCalledWith("assigned_order_id", null);
  expect(eq).toHaveBeenCalledWith("is_used", false);
});
