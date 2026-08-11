import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock, fromMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  fromMock: vi.fn(),
}));

vi.mock("../../src/lib/supabase", () => ({
  supabaseAdmin: { rpc: rpcMock, from: fromMock },
}));
vi.mock("../../src/middleware/requireAdmin", () => ({
  requireAdmin: (req: any, _res: any, next: any) => {
    req.adminUserId = "22222222-2222-4222-8222-222222222222";
    next();
  },
}));

import adminDashboardRouter from "../../src/routes/adminDashboard";

describe("admin dashboard contract", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    fromMock.mockReset();
  });

  it("returns revenue, sales and stock metrics from the protected RPC", async () => {
    rpcMock.mockResolvedValue({
      data: {
        summary: {
          revenue_total: 3600,
          revenue_period: 3600,
          paid_orders_total: 6,
          activation_pending: 0,
        },
        revenue_by_day: [{ date: "2026-07-30", revenue: 600, sales: 1 }],
        stock: [{ service: "netflix", total: 1, available: 0, assigned: 1 }],
      },
      error: null,
    });
    const app = express();
    app.use(adminDashboardRouter);

    const response = await request(app).get("/admin/dashboard?days=30").expect(200);
    expect(rpcMock).toHaveBeenCalledWith("get_admin_dashboard_metrics", { p_days: 30 });
    expect(response.body.summary).toMatchObject({
      revenue_total: 3600,
      paid_orders_total: 6,
    });
    expect(response.body.stock[0]).toMatchObject({ service: "netflix", available: 0 });
  });

  it("caps the requested reporting period at one year", async () => {
    rpcMock.mockResolvedValue({
      data: { summary: {}, revenue_by_day: [], stock: [] },
      error: null,
    });
    const app = express();
    app.use(adminDashboardRouter);

    await request(app).get("/admin/dashboard?days=10000").expect(200);
    expect(rpcMock).toHaveBeenCalledWith("get_admin_dashboard_metrics", { p_days: 365 });
  });

  it("returns an inclusive custom revenue range in Algeria time", async () => {
    rpcMock.mockResolvedValue({
      data: {
        summary: { revenue_total: 5000, average_order: 600 },
        revenue_by_day: [],
        stock: [],
      },
      error: null,
    });
    const rangeMock = vi.fn(async () => ({
      data: [
        { amount: 600, created_at: "2026-06-30T23:30:00.000Z" },
        { amount: 500, created_at: "2026-07-02T10:00:00.000Z" },
      ],
      error: null,
    }));
    const orderMock = vi.fn(() => ({ range: rangeMock }));
    const ltMock = vi.fn(() => ({ order: orderMock }));
    const gteMock = vi.fn(() => ({ lt: ltMock }));
    const eqMock = vi.fn(() => ({ gte: gteMock }));
    const selectMock = vi.fn(() => ({ eq: eqMock }));
    fromMock.mockReturnValue({ select: selectMock });

    const app = express();
    app.use(adminDashboardRouter);

    const response = await request(app)
      .get("/admin/dashboard?start_date=2026-07-01&end_date=2026-07-03")
      .expect(200);

    expect(rpcMock).toHaveBeenCalledWith("get_admin_dashboard_metrics", { p_days: 3 });
    expect(gteMock).toHaveBeenCalledWith("created_at", "2026-06-30T23:00:00.000Z");
    expect(ltMock).toHaveBeenCalledWith("created_at", "2026-07-03T23:00:00.000Z");
    expect(response.body).toMatchObject({
      period_days: 3,
      period_start: "2026-07-01",
      period_end: "2026-07-03",
      summary: { revenue_period: 1100, paid_orders_period: 2 },
      revenue_by_day: [
        { date: "2026-07-01", revenue: 600, sales: 1 },
        { date: "2026-07-02", revenue: 500, sales: 1 },
        { date: "2026-07-03", revenue: 0, sales: 0 },
      ],
    });
  });

  it("rejects incomplete or oversized custom report ranges", async () => {
    const app = express();
    app.use(adminDashboardRouter);

    await request(app).get("/admin/dashboard?start_date=2026-07-01").expect(400);
    await request(app)
      .get("/admin/dashboard?start_date=2025-01-01&end_date=2026-07-03")
      .expect(400);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("returns only bounded audit-log fields", async () => {
    const limitMock = vi.fn(async () => ({
      data: [{
        id: "log-1",
        created_at: "2026-07-30T10:00:00.000Z",
        action: "admin_promo_create",
        target_type: "promo_code",
        target_id: "promo-1",
        details: { discount_value: 10 },
      }],
      error: null,
    }));
    const orderMock = vi.fn(() => ({ limit: limitMock }));
    const selectMock = vi.fn(() => ({ order: orderMock }));
    fromMock.mockReturnValue({ select: selectMock });

    const app = express();
    app.use(adminDashboardRouter);
    const response = await request(app).get("/admin/audit-logs?limit=500").expect(200);

    expect(selectMock).toHaveBeenCalledWith(
      "id, created_at, action, target_type, target_id, details",
    );
    expect(limitMock).toHaveBeenCalledWith(100);
    expect(response.body.events).toHaveLength(1);
  });
});
