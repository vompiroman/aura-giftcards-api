import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const { getUserMock, notifyAdminMock, notifyOperationsMock, fromMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  notifyAdminMock: vi.fn(),
  notifyOperationsMock: vi.fn(),
  fromMock: vi.fn(),
}));

vi.mock("../../src/lib/notifyAdmin", () => ({ notifyAdmin: notifyAdminMock }));
vi.mock("../../src/lib/notifyOperations", () => ({ notifyOperations: notifyOperationsMock }));
vi.mock("../../src/lib/supabase", () => ({
  supabase: { from: fromMock },
  supabaseAdmin: { from: fromMock },
  supabaseAuth: { auth: { getUser: getUserMock } },
}));

import app from "../../src/app";

function selectSingleStub(data: Record<string, unknown>) {
  const builder: Record<string, any> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.single = vi.fn(async () => ({ data, error: null }));
  return builder;
}

function updateStub() {
  const builder: Record<string, any> = {};
  builder.update = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.neq = vi.fn(() => builder);
  builder.select = vi.fn(async () => ({ data: [{ order_id: "ORD-spotify-1" }], error: null }));
  return builder;
}

function reminderQueryStub(data: Array<Record<string, unknown>>) {
  const builder: Record<string, any> = {};
  for (const method of ["select", "eq", "lte"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.gt = vi.fn(async () => ({ data, error: null }));
  return builder;
}

describe("notifications administrateur", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CLIENT_CREDENTIALS_KEY = "dedicated-client-credentials-key-32-chars";
    process.env.CRON_SECRET = "test-cron-secret";
    notifyAdminMock.mockResolvedValue(true);
    notifyOperationsMock.mockResolvedValue(true);
    getUserMock.mockResolvedValue({
      data: { user: { email: "client@example.com" } },
      error: null,
    });
  });

  afterEach(() => {
    delete process.env.CLIENT_CREDENTIALS_KEY;
    delete process.env.CRON_SECRET;
  });

  it("envoie les demandes Spotify via le webhook opérationnel", async () => {
    fromMock
      .mockReturnValueOnce(selectSingleStub({
        order_id: "ORD-spotify-1",
        assigned_email: "client@example.com",
        status: "pending",
        payment_status: "paid",
        items: [{ name: "Spotify 1 mois" }],
      }))
      .mockReturnValueOnce(updateStub());

    const res = await request(app)
      .post("/api/client-credentials")
      .set("Authorization", "Bearer valid-token")
      .send({
        order_id: "ORD-spotify-1",
        service: "spotify",
        email: "spotify@example.com",
        password: "secret",
        whatsapp: "0555000000",
      });

    expect(res.status).toBe(200);
    expect(notifyOperationsMock).toHaveBeenCalledWith(
      expect.stringContaining("à activer"),
      expect.objectContaining({ orderId: "ORD-spotify-1", service: "spotify" }),
    );
    expect(notifyAdminMock).not.toHaveBeenCalled();
    expect(notifyOperationsMock).toHaveBeenCalledWith(
      expect.stringContaining("panneau sécurisé"),
      expect.objectContaining({
        credentials: {
          email: "spotify@example.com",
          password: "secret",
          whatsapp: "+213555000000",
        },
      }),
    );
  });

  it("envoie les rappels d'expiration via notifyAdmin", async () => {
    fromMock.mockReturnValue(reminderQueryStub([{
      order_id: "ORD-reminder-1",
      assigned_email: "client@example.com",
      items: [{ name: "Netflix 1 mois" }],
      expires_at: "2026-07-29T00:00:00.000Z",
      status: "active",
      payment_status: "paid",
    }]));

    const res = await request(app)
      .post("/api/cron/reminders")
      .set("x-cron-secret", "test-cron-secret")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("1 rappel(s) envoyé(s) sur Discord.");
    expect(notifyAdminMock).toHaveBeenCalledWith(
      expect.stringContaining("Rappel d'expiration"),
      expect.objectContaining({
        level: "warning",
        orderId: "ORD-reminder-1",
      }),
    );
  });
});
