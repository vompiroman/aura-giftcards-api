import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { WEB_SESSION_COOKIE } from "../../src/lib/webSession";
import { issuePasswordRecoveryToken, readPasswordRecoveryToken } from "../../src/lib/passwordRecoveryToken";

const { generateLinkMock, sendRecoveryEmailMock, signUpMock, signInMock, getUserMock, verifyOtpMock, refreshSessionMock, adminSignOutMock, axiosPutMock, partnerFrom, partnerRpc } = vi.hoisted(() => ({
  generateLinkMock: vi.fn(),
  sendRecoveryEmailMock: vi.fn(),
  signUpMock: vi.fn(),
  signInMock: vi.fn(),
  getUserMock: vi.fn(),
  verifyOtpMock: vi.fn(),
  refreshSessionMock: vi.fn(),
  adminSignOutMock: vi.fn(),
  axiosPutMock: vi.fn(),
  partnerFrom: vi.fn(),
  partnerRpc: vi.fn(),
}));

vi.mock("../../src/lib/purchaseEmail", () => ({
  getPurchaseEmailConfig: vi.fn(() => ({
    provider: "resend",
    apiKey: "re_test",
    fromEmail: "admin@aura-stream.com",
    fromName: "Aura Stream",
  })),
  sendPasswordRecoveryEmail: sendRecoveryEmailMock,
  sendPurchaseConfirmationEmail: vi.fn(),
}));

vi.mock("axios", () => ({
  default: {
    put: axiosPutMock,
    isAxiosError: vi.fn(() => false),
  },
}));

vi.mock("../../src/lib/supabase", () => ({
  createAuthClient: () => ({ auth: { refreshSession: refreshSessionMock, verifyOtp: verifyOtpMock } }),
  supabase: { auth: { getUser: getUserMock } },
  supabaseAdmin: { from:partnerFrom,rpc:partnerRpc,auth: { getUser: getUserMock, admin: { signOut: adminSignOutMock, generateLink: generateLinkMock } } },
  supabaseAuth: {
    auth: {
      signUp: signUpMock,
      signInWithPassword: signInMock,
      refreshSession: refreshSessionMock,
      getUser: getUserMock,
    },
  },
}));

import app from "../../src/app";
afterEach(()=>vi.unstubAllEnvs());

vi.mock("../../src/lib/webSessionStore", async () => {
  const { createSessionCipher, createWebSessions } = await import("../../src/lib/webSession");
  const { memoryWebSessionStore } = await import("./helpers/web-session-store");
  const { store } = memoryWebSessionStore();
  const engine = createWebSessions({ store, cipher: createSessionCipher("security-tests-session-cipher-key-32-characters"),
    refresh: async token => refreshSessionMock({ refresh_token: token }) });
  return { webSessions: () => engine };
});

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
    vi.stubEnv("SESSION_ENCRYPTION_KEY", "password-recovery-tests-session-secret");
  });

  it("renvoie une erreur client claire pour un corps JSON mal formé", async () => {
    const response = await request(app)
      .post("/api/login")
      .set("Content-Type", "application/json")
      .send('{"email":"client@example.com"');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Corps JSON invalide." });
  });

  it("ne permet pas d'énumérer les comptes via mot de passe oublié", async () => {
    const tokenHash = "a".repeat(56);
    vi.stubEnv("FRONTEND_URL", "http://localhost:3000");
    generateLinkMock
      .mockResolvedValueOnce({
        data: { properties: { hashed_token: tokenHash, redirect_to: "http://localhost:3000" } },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: { code: "user_not_found", message: "Unknown user" } });
    sendRecoveryEmailMock.mockResolvedValue({ providerId: "message-1" });

    const existing = await request(app)
      .post("/api/forgot-password")
      .send({ email: "client@example.com" });
    const missing = await request(app)
      .post("/api/forgot-password")
      .send({ email: "absent@example.com" });

    expect(existing.status).toBe(200);
    expect(missing.status).toBe(200);
    expect(missing.body).toEqual(existing.body);
    expect(sendRecoveryEmailMock).toHaveBeenCalledTimes(1);
    expect(sendRecoveryEmailMock).toHaveBeenCalledWith(
      "client@example.com",
      expect.stringMatching(/^https:\/\/www\.aura-stream\.com\/#type=recovery&token_hash=v1\./),
      expect.objectContaining({ fromEmail: "admin@aura-stream.com" }),
    );
    const emailLink = new URL(sendRecoveryEmailMock.mock.calls[0][1]);
    expect(emailLink.href).not.toContain(tokenHash);
    expect(readPasswordRecoveryToken(new URLSearchParams(emailLink.hash.slice(1)).get("token_hash"))).toBe(tokenHash);
  });

  it("rejette les jetons de récupération trop grands ou contenant un retour à la ligne", async () => {
    const tooLarge = await request(app)
      .post("/api/reset-password")
      .send({ token_hash: `v1.${"a".repeat(4097)}`, password: "mot-de-passe-fort-2026" });
    const injected = await request(app)
      .post("/api/reset-password")
      .send({ token_hash: `v1.${"a".repeat(60)}\r\nInjected: value`, password: "mot-de-passe-fort-2026" });

    expect(tooLarge.status).toBe(400);
    expect(injected.status).toBe(400);
  });

  it("rejette un jeton de session ordinaire sur la route de réinitialisation", async () => {
    const response = await request(app)
      .post("/api/reset-password")
      .send({ token: accessTokenWithAmr("password"), password: "mot-de-passe-fort-2026" });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/invalide|expiré/i);
    expect(getUserMock).not.toHaveBeenCalled();
    expect(adminSignOutMock).not.toHaveBeenCalled();
  });

  it("refuse les anciens liens et les jetons modifiés sans appeler Supabase", async () => {
    const oldHash = "f".repeat(56);
    const issued = issuePasswordRecoveryToken(oldHash, Date.now())!;
    const changed = issued.slice(0, 10) + (issued[10] === "A" ? "B" : "A") + issued.slice(11);
    const credentials = [{ token: accessTokenWithAmr("recovery") }, { token_hash: oldHash }, { token_hash: changed }];
    for (const credential of credentials) {
      const response = await request(app).post("/api/reset-password")
        .set("X-Forwarded-For", "192.0.2.25").send({ ...credential, password: "mot-de-passe-fort-2026" });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("RECOVERY_LINK_INVALID");
    }
    expect(verifyOtpMock).not.toHaveBeenCalled();
    expect(axiosPutMock).not.toHaveBeenCalled();
  });

  it("consomme le lien sur validation du formulaire et refuse sa réutilisation", async () => {
    const tokenHash = "a".repeat(56);
    const token = accessTokenWithAmr("recovery");
    verifyOtpMock
      .mockResolvedValueOnce({ data: { session: { access_token: token }, user: { id: "user-1" } }, error: null })
      .mockResolvedValueOnce({ data: { session: null, user: null }, error: { code: "otp_expired", status: 403 } })
      .mockResolvedValueOnce({ data: { session: null, user: null }, error: { code: "unexpected_failure", status: 503 } });
    axiosPutMock.mockResolvedValue({ data: { id: "user-1" } });
    adminSignOutMock.mockResolvedValue({ error: null });
    const payload = { token_hash: issuePasswordRecoveryToken(tokenHash, Date.now()), password: "mot-de-passe-fort-2026" };

    const reset = () => request(app).post("/api/reset-password")
      .set("X-Forwarded-For", "192.0.2.24").send(payload);
    const success = await reset();
    expect(success.status).toBe(200);
    expect(success.headers["set-cookie"]).toEqual(expect.arrayContaining([expect.stringContaining(`${WEB_SESSION_COOKIE}=;`)]));
    const replay = await reset();
    expect(replay.status).toBe(400);
    expect(replay.body.code).toBe("RECOVERY_LINK_INVALID");
    expect((await reset()).status).toBe(503);
    expect(verifyOtpMock).toHaveBeenCalledWith({ type: "recovery", token_hash: tokenHash });
    expect(axiosPutMock).toHaveBeenCalledTimes(1);
    expect(axiosPutMock).toHaveBeenCalledWith(
      expect.stringContaining("/auth/v1/user"),
      { password: payload.password },
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: `Bearer ${token}` }) }),
    );
    expect(adminSignOutMock).toHaveBeenCalledWith(token, "global");
  });

  it("accepte juste avant 15 minutes et rejette à 15 minutes", async () => {
    const start = Date.now();
    const hash = "f".repeat(56);
    const issued = issuePasswordRecoveryToken(hash, start);
    expect(readPasswordRecoveryToken(issued, start + 899_999)).toBe(hash);
    expect(readPasswordRecoveryToken(issued, start + 900_000)).toBeNull();

    const response = await request(app)
      .post("/api/reset-password")
      .send({
        token_hash: issuePasswordRecoveryToken(hash, Date.now() - 900_000),
        password: "mot-de-passe-fort-2026",
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("RECOVERY_LINK_INVALID");
    expect(verifyOtpMock).not.toHaveBeenCalled();
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

  it("normalise le zéro national après +213 lors de l'inscription", async () => {
    signUpMock.mockImplementation(async ({ email, options }) => ({
      data: {
        user: {
          id: "user-phone",
          email,
          user_metadata: options.data,
          app_metadata: {},
        },
        session: null,
      },
      error: null,
    }));

    const response = await request(app)
      .post("/api/register")
      .send({
        email: "mobile@example.com",
        password: "mot-de-passe-fort-2026",
        first_name: "Client",
        last_name: "Aura",
        phone: "+213 05 57 82 88 12",
      });

    expect(response.status).toBe(201);
    expect(signUpMock).toHaveBeenCalledWith(expect.objectContaining({
      options: {
        data: expect.objectContaining({ phone: "+213557828812" }),
      },
    }));
    expect(response.body.user.user_metadata.phone).toBe("+213557828812");
  });

  it("conserve le questionnaire d'un nouveau compte à confirmer sans l'approuver", async () => {
    vi.stubEnv("PARTNER_PROGRAM_ENABLED","true");
    const answers={monthly_volume:"UNDER_5000",sales_channel:"WEB",profile:"INDEPENDENT",products:"Netflix",quick_contact:"@client"};
    const insert=vi.fn(async()=>({error:null}));
    partnerFrom.mockReturnValue({insert});
    signUpMock.mockResolvedValue({data:{session:null,user:{id:"new-customer",email:"new@example.invalid",identities:[{}]}},error:null});
    const res=await request(app).post("/api/register").send({email:"new@example.invalid",password:"local-fixture-password",partner_application:answers});
    expect(res.status).toBe(201);
    expect(res.body.authenticated).toBe(false);
    expect(insert).toHaveBeenCalledWith({user_id:"new-customer",answers});
    expect(partnerRpc).not.toHaveBeenCalled();
    signUpMock.mockResolvedValue({data:{session:null,user:{id:"masked-id",email:"existing@example.invalid",identities:[]}},error:null});
    const duplicate=await request(app).post("/api/register").send({email:"existing@example.invalid",password:"local-fixture-password",partner_application:answers});
    expect(duplicate.status).toBe(201);
    expect(insert).toHaveBeenCalledTimes(1);
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
      expect.stringMatching(/^aura_session_v2=[A-Za-z0-9_-]{43};/),
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
