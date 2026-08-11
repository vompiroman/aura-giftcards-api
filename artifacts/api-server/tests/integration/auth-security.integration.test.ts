import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const { resetPasswordMock, signUpMock, signInMock, getUserMock, refreshSessionMock, adminSignOutMock, axiosPutMock } = vi.hoisted(() => ({
  resetPasswordMock: vi.fn(),
  signUpMock: vi.fn(),
  signInMock: vi.fn(),
  getUserMock: vi.fn(),
  refreshSessionMock: vi.fn(),
  adminSignOutMock: vi.fn(),
  axiosPutMock: vi.fn(),
}));

vi.mock("axios", () => ({
  default: {
    put: axiosPutMock,
    isAxiosError: vi.fn(() => false),
  },
}));

vi.mock("../../src/lib/supabase", () => ({
  supabase: { auth: { getUser: getUserMock } },
  supabaseAdmin: { auth: { getUser: getUserMock, admin: { signOut: adminSignOutMock } } },
  supabaseAuth: {
    auth: {
      resetPasswordForEmail: resetPasswordMock,
      signUp: signUpMock,
      signInWithPassword: signInMock,
      refreshSession: refreshSessionMock,
      getUser: getUserMock,
    },
  },
}));

import app from "../../src/app";

function accessTokenWithAmr(method: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ amr: [{ method, timestamp }] })}.signature`;
}

describe("sécurité de l'authentification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FRONTEND_URL = "https://www.aura-stream.com";
    process.env.SUPABASE_URL = "https://test-project.supabase.co";
    process.env.SUPABASE_ANON_KEY = "sb_publishable_test_key";
  });

  it("ne permet pas d'énumérer les comptes via mot de passe oublié", async () => {
    resetPasswordMock
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { code: "user_not_found", message: "Unknown user" } });

    const existing = await request(app)
      .post("/api/forgot-password")
      .send({ email: "client@example.com" });
    const missing = await request(app)
      .post("/api/forgot-password")
      .send({ email: "absent@example.com" });

    expect(existing.status).toBe(200);
    expect(missing.status).toBe(200);
    expect(missing.body).toEqual(existing.body);
  });

  it("rejette les jetons de récupération trop grands ou contenant un retour à la ligne", async () => {
    const tooLarge = await request(app)
      .post("/api/reset-password")
      .send({ token: "a".repeat(4097), password: "mot-de-passe-fort-2026" });
    const injected = await request(app)
      .post("/api/reset-password")
      .send({ token: `${"a".repeat(30)}\r\nInjected: value`, password: "mot-de-passe-fort-2026" });

    expect(tooLarge.status).toBe(400);
    expect(injected.status).toBe(400);
  });

  it("rejette un jeton de session ordinaire sur la route de réinitialisation", async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: "user-1", email: "client@example.com" } },
      error: null,
    });

    const response = await request(app)
      .post("/api/reset-password")
      .send({ token: accessTokenWithAmr("password"), password: "mot-de-passe-fort-2026" });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/invalide|expiré/i);
    expect(adminSignOutMock).not.toHaveBeenCalled();
  });

  it("accepte un jeton recovery récent puis révoque toutes les sessions", async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: "user-1", email: "client@example.com" } },
      error: null,
    });
    axiosPutMock.mockResolvedValue({ data: { id: "user-1" } });
    adminSignOutMock.mockResolvedValue({ error: null });
    const token = accessTokenWithAmr("recovery");

    const response = await request(app)
      .post("/api/reset-password")
      .send({ token, password: "mot-de-passe-fort-2026" });

    expect(response.status).toBe(200);
    expect(axiosPutMock).toHaveBeenCalledWith(
      expect.stringContaining("/auth/v1/user"),
      { password: "mot-de-passe-fort-2026" },
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: `Bearer ${token}` }) }),
    );
    expect(adminSignOutMock).toHaveBeenCalledWith(token, "global");
  });

  it("rejette un jeton recovery trop ancien", async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: "user-1", email: "client@example.com" } },
      error: null,
    });

    const response = await request(app)
      .post("/api/reset-password")
      .send({
        token: accessTokenWithAmr("recovery", Math.floor(Date.now() / 1000) - 16 * 60),
        password: "mot-de-passe-fort-2026",
      });

    expect(response.status).toBe(400);
    expect(axiosPutMock).not.toHaveBeenCalled();
  });

  it("révoque la session Supabase lors de la déconnexion", async () => {
    adminSignOutMock.mockResolvedValue({ error: null });

    const response = await request(app)
      .post("/api/logout")
      .set("Authorization", "Bearer valid-access-token");

    expect(response.status).toBe(204);
    expect(adminSignOutMock).toHaveBeenCalledWith("valid-access-token", "local");
  });

  it("ne renvoie pas les champs internes Supabase lors de l'inscription", async () => {
    signUpMock.mockResolvedValue({
      data: {
        user: {
          id: "user-1",
          email: "client@example.com",
          aud: "authenticated",
          identities: [{ id: "private-provider-id" }],
          user_metadata: { full_name: "Client Aura", phone: "0550000000" },
          app_metadata: {},
        },
      },
      error: null,
    });

    const response = await request(app)
      .post("/api/register")
      .send({ email: "client@example.com", password: "mot-de-passe-fort-2026", full_name: "Client Aura" });

    expect(response.status).toBe(201);
    expect(response.body.user).toEqual({
      id: "user-1",
      email: "client@example.com",
      user_metadata: {
        full_name: "Client Aura",
        phone: "0550000000",
      },
      is_admin: false,
    });
    expect(response.body.user.aud).toBeUndefined();
    expect(response.body.user.identities).toBeUndefined();
  });

  it("renouvelle une session et effectue la rotation du refresh token", async () => {
    refreshSessionMock.mockResolvedValue({
      data: {
        session: {
          access_token: "new-access-token",
          refresh_token: "new-refresh-token-that-is-long-enough",
          expires_at: 1_786_200_000,
        },
        user: {
          id: "admin-1",
          email: "admin@example.com",
          user_metadata: {},
          app_metadata: { role: "admin" },
        },
      },
      error: null,
    });

    const response = await request(app)
      .post("/api/refresh-session")
      .send({ refresh_token: "123456789012" });

    expect(response.status).toBe(200);
    expect(refreshSessionMock).toHaveBeenCalledWith({
      refresh_token: "123456789012",
    });
    expect(response.body).toMatchObject({
      authenticated: true,
      expires_at: 1_786_200_000,
      user: { id: "admin-1", is_admin: true },
    });
    expect(response.body.access_token).toBeUndefined();
    expect(response.body.refresh_token).toBeUndefined();
    expect(response.headers["set-cookie"]).toEqual(expect.arrayContaining([
      expect.stringMatching(/^aura_access=/),
      expect.stringMatching(/^aura_refresh=/),
    ]));
  });

  it("rejette un refresh token invalide sans appeler Supabase", async () => {
    const response = await request(app)
      .post("/api/refresh-session")
      .send({ refresh_token: "court" });

    expect(response.status).toBe(400);
    expect(refreshSessionMock).not.toHaveBeenCalled();
  });
});
