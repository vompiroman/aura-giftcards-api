import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));

vi.mock("../../src/lib/supabase", () => ({
  supabaseAdmin: { from: fromMock },
  supabaseAuth: { auth: { getUser: vi.fn(async () => ({ data: { user: { email: "client@example.com" } }, error: null })) } },
}));
vi.mock("../../src/middleware/requireAdmin", () => ({
  requireAdmin: (req: any, _res: any, next: any) => {
    req.adminUserId = "22222222-2222-4222-8222-222222222222";
    next();
  },
}));
vi.mock("../../src/lib/auditLog", () => ({ appendAuditLog: vi.fn() }));

import promosRouter from "../../src/routes/promos";

const promo = {
  id: "11111111-1111-4111-8111-111111111111",
  code_prefix: "AURA",
  discount_type: "percentage",
  discount_value: 10,
  starts_at: null,
  ends_at: null,
  max_uses: 100,
  max_uses_per_client: 1,
  services: ["netflix"],
  active: true,
  created_at: "2026-07-26T00:00:00.000Z",
};

describe("admin promo contract", () => {
  beforeEach(() => {
    fromMock.mockReset();
  });

  it("returns masked_code and usage_count without redemption details", async () => {
    fromMock.mockReturnValueOnce({
      select: vi.fn(() => ({
        order: vi.fn(async () => ({
          data: [{ ...promo, promo_redemptions: [{ count: 3, client_hash: "private" }] }],
          error: null,
        })),
      })),
    });
    const app = express();
    app.use(express.json(), promosRouter);

    const response = await request(app).get("/admin/promo-codes").expect(200);
    expect(response.body.promo_codes[0]).toMatchObject({
      id: promo.id,
      masked_code: "AURA••••",
      usage_count: 3,
    });
    expect(response.body.promo_codes[0]).not.toHaveProperty("promo_redemptions");
  });

  it("accepts the compatibility PATCH body while retaining the REST route", async () => {
    fromMock
      .mockReturnValueOnce({
        update: vi.fn(() => ({
          eq: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn(async () => ({ data: { ...promo, active: false }, error: null })),
            })),
          })),
        })),
      })
      .mockReturnValueOnce({
        select: vi.fn(() => ({
          eq: vi.fn(async () => ({ count: 3, error: null })),
        })),
      });
    const app = express();
    app.use(express.json(), promosRouter);

    const response = await request(app)
      .patch("/admin/promo-codes")
      .send({ id: promo.id, active: false })
      .expect(200);
    expect(response.body.promo_code).toMatchObject({
      id: promo.id,
      active: false,
      masked_code: "AURA••••",
      usage_count: 3,
    });
  });

  it("validates a promo server-side without reserving usage", async () => {
    fromMock.mockReturnValueOnce({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn(async () => ({
              data: {
                id: promo.id,
                discount_type: "percentage",
                discount_value: 10,
                starts_at: null,
                ends_at: null,
                max_uses: 10,
                max_uses_per_client: 1,
                services: ["netflix"],
                active: true,
              },
              error: null,
            })),
          })),
        })),
      })),
    });
    const app = express();
    app.use(express.json(), promosRouter);

    const response = await request(app)
      .post("/validate-promo")
      .set("Authorization", "Bearer valid-token")
      .send({ code: "AURA10", items: [{ name: "Netflix 1 mois", quantity: 1 }] })
      .expect(200);
    expect(response.body).toMatchObject({
      valid: true,
      discount_amount: 60,
      total: 540,
      subtotal: 600,
    });
  });
});
