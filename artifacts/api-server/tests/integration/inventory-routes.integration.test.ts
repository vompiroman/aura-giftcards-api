import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const {
  authGetUserMock,
  fromMock,
  insertMock,
  rpcMock,
  fulfillWaitingMock,
  appendAuditLogMock,
} = vi.hoisted(() => ({
  authGetUserMock: vi.fn(),
  fromMock: vi.fn(),
  insertMock: vi.fn(),
  rpcMock: vi.fn(),
  fulfillWaitingMock: vi.fn(),
  appendAuditLogMock: vi.fn(),
}));

vi.mock("../../src/lib/supabase", () => ({
  supabaseAuth: { auth: { getUser: authGetUserMock } },
  supabaseAdmin: { from: fromMock, rpc: rpcMock },
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
    rpcMock.mockResolvedValue({ data: { result: "deleted", previous_order_id: null }, error: null });
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

  it("supprime un profil disponible avec l'opération atomique", async () => {
    const inventoryId = "4973a601-68ac-4d08-b2ae-6b8613b005e4";
    const response = await request(app)
      .delete(`/api/admin/inventory/${inventoryId}`)
      .set("Authorization", "Bearer admin-token")
      .send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(rpcMock).toHaveBeenCalledWith("delete_inactive_inventory_item", {
      p_inventory_id: inventoryId,
      p_confirm_disconnected: false,
    });
    expect(appendAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "admin_inventory_delete",
      actorUserId: "admin-id",
      targetId: inventoryId,
    }));
  });

  it("autorise la suppression confirmée d'un profil lié à une commande inactive", async () => {
    const inventoryId = "78dfcba1-52bd-4c7a-b47b-d2f43a6714fa";
    rpcMock.mockResolvedValueOnce({
      data: { result: "deleted", previous_order_id: "ORD-expired" },
      error: null,
    });

    const response = await request(app)
      .delete(`/api/admin/inventory/${inventoryId}`)
      .set("Authorization", "Bearer admin-token")
      .send({ confirm_disconnected: true });

    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("delete_inactive_inventory_item", {
      p_inventory_id: inventoryId,
      p_confirm_disconnected: true,
    });
    expect(appendAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({
      details: { previous_order_id: "ORD-expired" },
    }));
  });

  it("refuse de supprimer le profil d'un abonnement encore actif", async () => {
    rpcMock.mockResolvedValueOnce({ data: { result: "assigned_active" }, error: null });

    const response = await request(app)
      .delete("/api/admin/inventory/8907ce93-eb65-4fbd-9e95-3a7cc1c3071b")
      .set("Authorization", "Bearer admin-token")
      .send({ confirm_disconnected: true });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain("encore actif");
    expect(appendAuditLogMock).not.toHaveBeenCalled();
  });
});
