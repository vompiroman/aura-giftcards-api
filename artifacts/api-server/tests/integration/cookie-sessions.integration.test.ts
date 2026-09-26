import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const { signInMock, getUserMock, refreshSessionMock, adminSignOutMock } = vi.hoisted(() => ({
  signInMock: vi.fn(),
  getUserMock: vi.fn(),
  refreshSessionMock: vi.fn(),
  adminSignOutMock: vi.fn(),
}));

vi.mock("../../src/lib/supabase", () => ({
  supabase: { auth: { getUser: getUserMock } },
  supabaseAdmin: { auth: { getUser: getUserMock, admin: { signOut: adminSignOutMock } } },
  supabaseAuth: {
    auth: {
      resetPasswordForEmail: vi.fn(),
      signUp: vi.fn(),
      signInWithPassword: signInMock,
      refreshSession: refreshSessionMock,
      getUser: getUserMock,
    },
  },
}));

import app from "../../src/app";

const user = {
  id: "user-cookie-1",
  email: "client@example.com",
  user_metadata: { full_name: "Client Aura" },
  app_metadata: {},
};

function cookieHeader(response: request.Response): string[] {
  const header = response.headers["set-cookie"];
  return Array.isArray(header) ? header : header ? [header] : [];
}

describe("sessions par cookies HttpOnly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signInMock.mockResolvedValue({
      data: {
        user,
        session: {
          access_token: "access-token-cookie",
          refresh_token: "refresh-token-cookie-long-enough",
          expires_at: 1_900_000_000,
        },
      },
      error: null,
    });
    getUserMock.mockResolvedValue({ data: { user }, error: null });
    adminSignOutMock.mockResolvedValue({ error: null });
  });

  it("place les jetons dans des cookies HttpOnly sans les exposer dans le JSON", async () => {
    const response = await request(app)
      .post("/api/login")
      .set("Origin", "https://www.aura-stream.com")
      .send({ email: user.email, password: "mot-de-passe-fort-2026", remember: true });

    expect(response.status).toBe(200);
    expect(response.body.access_token).toBeUndefined();
    expect(response.body.refresh_token).toBeUndefined();
    expect(response.body.authenticated).toBe(true);

    const cookies = cookieHeader(response);
    expect(cookies.some((value) => /^aura_access=/.test(value) && /HttpOnly/i.test(value))).toBe(true);
    expect(cookies.some((value) => /^aura_refresh=/.test(value) && /HttpOnly/i.test(value))).toBe(true);
    expect(cookies.every((value) => /SameSite=Lax/i.test(value))).toBe(true);
  });

  it("authentifie /me avec le cookie sans en-tête Authorization", async () => {
    const agent = request.agent(app);
    await agent
      .post("/api/login")
      .set("Origin", "https://www.aura-stream.com")
      .send({ email: user.email, password: "mot-de-passe-fort-2026" })
      .expect(200);

    const response = await agent.get("/api/me");

    expect(response.status).toBe(200);
    expect(getUserMock).toHaveBeenCalledWith("access-token-cookie");
    expect(response.body.user.email).toBe(user.email);
  });

  it("rend la session persistante par défaut à la connexion", async () => {
    const response = await request(app)
      .post("/api/login")
      .set("Origin", "https://www.aura-stream.com")
      .send({ email: user.email, password: "mot-de-passe-fort-2026" });

    expect(response.status).toBe(200);
    expect(cookieHeader(response).some((value) => /^aura_refresh=/.test(value) && /Max-Age=315360000/i.test(value))).toBe(true);
    expect(cookieHeader(response).some((value) => /^aura_remember=1/.test(value))).toBe(true);
  });

  it("fait tourner le refresh token depuis le cookie et ne le renvoie pas au navigateur", async () => {
    refreshSessionMock.mockResolvedValue({
      data: {
        user,
        session: {
          access_token: "rotated-access-token",
          refresh_token: "rotated-refresh-token-long-enough",
          expires_at: 1_900_003_600,
        },
      },
      error: null,
    });

    const response = await request(app)
      .post("/api/refresh-session")
      .set("Origin", "https://www.aura-stream.com")
      .set("Cookie", "aura_refresh=refresh-token-cookie-long-enough; aura_remember=1")
      .send({});

    expect(response.status).toBe(200);
    expect(refreshSessionMock).toHaveBeenCalledWith({
      refresh_token: "refresh-token-cookie-long-enough",
    });
    expect(response.body.access_token).toBeUndefined();
    expect(response.body.refresh_token).toBeUndefined();
    expect(cookieHeader(response).some((value) => value.startsWith("aura_refresh=rotated-refresh-token"))).toBe(true);
  });

  it("efface les cookies et révoque la session à la déconnexion", async () => {
    const response = await request(app)
      .post("/api/logout")
      .set("Origin", "https://www.aura-stream.com")
      .set("Cookie", "aura_access=access-token-cookie; aura_refresh=refresh-token-cookie-long-enough")
      .send({});

    expect(response.status).toBe(204);
    expect(adminSignOutMock).toHaveBeenCalledWith("access-token-cookie", "local");
    expect(cookieHeader(response).filter((value) => /aura_(access|refresh)=;/i.test(value)).length).toBe(2);
  });

  it("restaure une session valide en une seule requête sans renouvellement", async () => {
    const response = await request(app).post("/api/session").set("Origin", "https://www.aura-stream.com")
      .set("Cookie", "aura_access=valid-token").send({});
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ authenticated: true, user: { email: user.email } });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(getUserMock).toHaveBeenCalledTimes(1);
    expect(refreshSessionMock).not.toHaveBeenCalled();
  });

  it("convertit une ancienne session cookie en session persistante", async () => {
    const response = await request(app).post("/api/session").set("Origin", "https://www.aura-stream.com")
      .set("Cookie", "aura_access=valid-token; aura_refresh=refresh-token-cookie-long-enough").send({});
    expect(response.status).toBe(200);
    expect(cookieHeader(response).some((value) => /^aura_refresh=/.test(value) && /Max-Age=315360000/i.test(value))).toBe(true);
    expect(cookieHeader(response).some((value) => /^aura_remember=1/.test(value))).toBe(true);
  });

  it("ne contacte pas Supabase pour un visiteur anonyme", async () => {
    const response = await request(app).post("/api/session").set("Origin", "https://www.aura-stream.com").send({});
    expect(response.body).toEqual({ authenticated: false, user: null });
    expect(getUserMock).not.toHaveBeenCalled();
    expect(refreshSessionMock).not.toHaveBeenCalled();
  });

  it("restaure directement avec le refresh cookie si le cookie d'accès a expiré", async () => {
    refreshSessionMock.mockResolvedValue({ data: { user, session: {
      access_token: "restored-access", refresh_token: "restored-refresh", expires_at: 1_900_000_000,
    } }, error: null });
    const response = await request(app).post("/api/session").set("Origin", "https://www.aura-stream.com")
      .set("Cookie", "aura_refresh=refresh-token-cookie-long-enough; aura_remember=1").send({});
    expect(response.status).toBe(200);
    expect(response.body.authenticated).toBe(true);
    expect(response.body.access_token).toBeUndefined();
    expect(response.body.refresh_token).toBeUndefined();
    expect(getUserMock).not.toHaveBeenCalled();
    expect(refreshSessionMock).toHaveBeenCalledTimes(1);
    expect(cookieHeader(response).some(value => value.startsWith("aura_access=restored-access") && value.includes("HttpOnly"))).toBe(true);
  });

  it("conserve la session pendant une panne temporaire Supabase", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: { status: 503 } });
    const response = await request(app).post("/api/session").set("Origin", "https://www.aura-stream.com")
      .set("Cookie", "aura_access=valid-token; aura_refresh=refresh-token-long-enough").send({});
    expect(response.status).toBe(503);
    expect(cookieHeader(response)).toEqual([]);
    expect(refreshSessionMock).not.toHaveBeenCalled();
  });

  it("renouvelle après un token expiré sans seconde requête du navigateur", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: { status: 401 } });
    refreshSessionMock.mockResolvedValue({ data: { user, session: {
      access_token: "restored-access", refresh_token: "restored-refresh", expires_at: 1_900_000_000,
    } }, error: null });
    const response = await request(app).post("/api/session").set("Origin", "https://www.aura-stream.com")
      .set("Cookie", "aura_access=expired-token; aura_refresh=refresh-token-long-enough").send({});
    expect(response.status).toBe(200);
    expect(response.body.authenticated).toBe(true);
    expect(refreshSessionMock).toHaveBeenCalledTimes(1);
  });

  it("bloque une requête mutante provenant d'une origine non autorisée", async () => {
    const response = await request(app)
      .post("/api/login")
      .set("Origin", "https://example.invalid")
      .send({ email: user.email, password: "mot-de-passe-fort-2026" });

    expect(response.status).toBe(403);
    expect(signInMock).not.toHaveBeenCalled();
  });
});
