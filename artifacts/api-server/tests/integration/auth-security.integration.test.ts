import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const { resetPasswordMock, signUpMock, signInMock, getUserMock, refreshSessionMock } = vi.hoisted(() => ({
  resetPasswordMock: vi.fn(),
  signUpMock: vi.fn(),
  signInMock: vi.fn(),
  getUserMock: vi.fn(),
  refreshSessionMock: vi.fn(),
}));

vi.mock("../../src/lib/supabase", () => ({
  supabase: { auth: { getUser: getUserMock } },
  supabaseAdmin: { auth: { getUser: getUserMock } },
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

describe("sécurité de l'authentification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FRONTEND_URL = "https://www.aura-stream.com";
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
      .send({ refresh_token: "old-refresh-token-that-is-long-enough" });

    expect(response.status).toBe(200);
    expect(refreshSessionMock).toHaveBeenCalledWith({
      refresh_token: "old-refresh-token-that-is-long-enough",
    });
    expect(response.body).toMatchObject({
      access_token: "new-access-token",
      refresh_token: "new-refresh-token-that-is-long-enough",
      expires_at: 1_786_200_000,
      user: { id: "admin-1", is_admin: true },
    });
  });

  it("rejette un refresh token invalide sans appeler Supabase", async () => {
    const response = await request(app)
      .post("/api/refresh-session")
      .send({ refresh_token: "trop-court" });

    expect(response.status).toBe(400);
    expect(refreshSessionMock).not.toHaveBeenCalled();
  });
});
