import { beforeEach, expect, it, vi } from "vitest";
import request from "supertest";
import { adminTestToken } from "./helpers/admin-session";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(), setSession: vi.fn(), listFactors: vi.fn(), enroll: vi.fn(),
  challengeAndVerify: vi.fn(), resolve: vi.fn(), revoke: vi.fn(), create: vi.fn(), from: vi.fn(),
}));

vi.mock("../../src/lib/supabase", () => ({
  supabaseAuth: { auth: { getUser: mocks.getUser } },
  supabaseAdmin: { from: mocks.from },
  createAuthClient: () => ({
    auth: {
      setSession: mocks.setSession,
      mfa: { listFactors: mocks.listFactors, enroll: mocks.enroll, challengeAndVerify: mocks.challengeAndVerify },
    },
  }),
}));
vi.mock("../../src/lib/webSessionStore", () => ({
  webSessions: () => ({ resolve: mocks.resolve, revoke: mocks.revoke, create: mocks.create }),
}));
vi.mock("../../src/lib/auditLog", () => ({ appendAuditLog: vi.fn() }));

import app from "../../src/app";

const admin = { id: "admin-id", email: "admin@example.invalid", app_metadata: { role: "admin" } };
const passwordToken = adminTestToken(admin.id, "aal1");
const verifiedToken = adminTestToken(admin.id, "aal2");
const factorId = "550e8400-e29b-41d4-a716-446655440000";
const cookie = "aura_session_v2=existing-test-cookie";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: admin }, error: null });
  mocks.setSession.mockResolvedValue({ data: {}, error: null });
  mocks.listFactors.mockResolvedValue({ data: { all: [], totp: [] }, error: null });
  mocks.resolve.mockResolvedValue({
    row: { user_id: admin.id, remember: false },
    tokens: { access_token: passwordToken, refresh_token: "fixture", expires_at: 2000000000 },
  });
  mocks.create.mockResolvedValue("new-test-cookie");
});

it("exige le second facteur sur l’inventaire, les commandes et l’export", async () => {
  for (const path of ["/admin/inventory", "/admin/all-orders", "/admin/orders-export.csv"]) {
    const response = await request(app).get(`/api${path}`).set("Cookie", cookie);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("ADMIN_MFA_REQUIRED");
  }
  expect(mocks.from).not.toHaveBeenCalled();
});

it("autorise la configuration du premier facteur depuis la session du site", async () => {
  const status = await request(app).get("/api/admin/security").set("Cookie", cookie).expect(200);
  expect(status.body).toEqual({ verified: false, factors: [] });
  mocks.enroll.mockResolvedValue({
    data: { id: factorId, totp: { secret: "TESTSETUP", qr_code: "data:image/svg+xml;utf-8,<svg/>" } },
    error: null,
  });
  const result = await request(app).post("/api/admin/security/enroll")
    .set("Cookie", cookie).set("Origin", "https://www.aura-stream.com").send({}).expect(201);
  expect(result.body).toMatchObject({ id: factorId, secret: "TESTSETUP" });
  expect(mocks.enroll).toHaveBeenCalledWith({ factorType: "totp", issuer: "Aura Stream" });
});

it("renouvelle le cookie HttpOnly après vérification et garde les jetons côté serveur", async () => {
  mocks.challengeAndVerify.mockResolvedValue({
    data: { user: admin, access_token: verifiedToken, refresh_token: "new-fixture", expires_in: 3600, token_type: "bearer" },
    error: null,
  });
  const result = await request(app).post("/api/admin/security/verify")
    .set("Cookie", cookie).set("Origin", "https://www.aura-stream.com")
    .send({ factor_id: factorId, code: "123456" }).expect(200);
  expect(result.body).toEqual({ verified: true });
  expect(result.headers["set-cookie"][0]).toMatch(/^aura_session_v2=new-test-cookie;.*HttpOnly/);
  expect(mocks.revoke).toHaveBeenCalledWith("existing-test-cookie");
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ access_token: verifiedToken }), admin.id, false);
});
