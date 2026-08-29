import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const {
  authGetUserMock,
  fromMock,
  insertMock,
  fulfillWaitingMock,
  appendAuditLogMock,
} = vi.hoisted(() => ({
  authGetUserMock: vi.fn(),
  fromMock: vi.fn(),
  insertMock: vi.fn(),
  fulfillWaitingMock: vi.fn(),
  appendAuditLogMock: vi.fn(),
}));

vi.mock("../../src/lib/supabase", () => ({
  supabaseAuth: { auth: { getUser: authGetUserMock } },
  supabaseAdmin: { from: fromMock, rpc: vi.fn() },
  supabase: { auth: { getUser: authGetUserMock }, from: fromMock, rpc: vi.fn() },
}));
vi.mock("../../src/jobs/stockFulfillment", () => ({
  fulfillPaidOrdersWaitingForStock: fulfillWaitingMock,
}));
vi.mock("../../src/lib/auditLog", () => ({ appendAuditLog: appendAuditLogMock }));

import app from "../../src/app";

describe("admin Netflix inventory routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ADMIN_EMAILS = "admin@aura-stream.com";
    authGetUserMock.mockResolvedValue({
      data: { user: { id: "admin-id", email: "admin@aura-stream.com", app_metadata: { role: "admin" } } },
      error: null,
    });
    insertMock.mockResolvedValue({ error: null });
    fromMock.mockImplementation((table: string) => {
      if (table === "inventory") return { insert: insertMock };
      return {};
    });
    fulfillWaitingMock.mockResolvedValue({
      checked: 1,
      fulfilled: 1,
      awaiting_manual_activation: 0,
      waiting_for_stock: 0,
      errors: 0,
    });
  });

  it("ajoute un profil OTP sans mot de passe Netflix historique", async () => {
    const response = await request(app)
      .post("/api/admin/inventory")
      .set("Authorization", "Bearer admin-token")
      .send({
        service: "netflix",
        account_email: "AuraStream06@Aura-Stream.com",
        profile_name: "Aura 6",
        profile_pin: "0606",
      });

    expect(response.status).toBe(201);
    expect(response.body.stock_reconciliation.fulfilled).toBe(1);
    expect(insertMock).toHaveBeenCalledWith([
      expect.objectContaining({
        service: "netflix",
        account_email: "aurastream06@aura-stream.com",
        account_password: null,
        imap_password: null,
        imap_host: null,
        imap_port: 993,
        imap_user: "aurastream06@aura-stream.com",
        profile_name: "Aura 6",
        profile_pin: "0606",
        is_used: false,
      }),
    ]);
    expect(fulfillWaitingMock).toHaveBeenCalledTimes(1);
  });

  it("refuse un profil incomplet avant tout accès à la base", async () => {
    const response = await request(app)
      .post("/api/admin/inventory")
      .set("Authorization", "Bearer admin-token")
      .send({
        service: "netflix",
        account_email: "aurastream07@aura-stream.com",
        profile_name: "",
        profile_pin: "0707",
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("profil Netflix");
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("retourne un message clair quand le profil existe déjà", async () => {
    insertMock.mockResolvedValueOnce({ error: { code: "23505" } });

    const response = await request(app)
      .post("/api/admin/inventory")
      .set("Authorization", "Bearer admin-token")
      .send({
        service: "netflix",
        account_email: "aurastream06@aura-stream.com",
        profile_name: "Aura 6",
        profile_pin: "0606",
      });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain("existe déjà");
    expect(fulfillWaitingMock).not.toHaveBeenCalled();
  });
});
