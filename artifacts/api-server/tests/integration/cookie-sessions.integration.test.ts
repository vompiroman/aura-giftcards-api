import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { WebSessionRow } from "../../src/lib/webSession";
import { sessionHash } from "../../src/lib/webSession";

const state = vi.hoisted(() => ({ signIn: vi.fn(), getUser: vi.fn(), refresh: vi.fn(), signOut: vi.fn(),
  rows: null as unknown as Map<string, WebSessionRow>, failDatabase: false,
}));
vi.mock("../../src/lib/supabase", () => ({
  createAuthClient: () => ({ auth: { refreshSession: state.refresh } }),
  supabase: { auth: { getUser: state.getUser } },
  supabaseAdmin: { auth: { admin: { signOut: state.signOut } } },
  supabaseAuth: { auth: { signInWithPassword: state.signIn, signUp: vi.fn(), getUser: state.getUser } },
}));
vi.mock("../../src/lib/webSessionStore", async () => {
  const { createSessionCipher, createWebSessions, SessionUnavailable } = await import("../../src/lib/webSession");
  const { memoryWebSessionStore } = await import("./helpers/web-session-store");
  const { store, rows } = memoryWebSessionStore(); state.rows = rows;
  const read = store.read;
  store.read = async id => { if (state.failDatabase) throw new SessionUnavailable(); return read(id); };
  const engine = createWebSessions({ store, cipher: createSessionCipher("cookie-tests-session-cipher-key-32-characters"),
    refresh: async token => state.refresh({ refresh_token: token }) });
  return { webSessions: () => engine };
});
import app from "../../src/app";

const user = { id: "user-cookie-1", email: "client@example.com", user_metadata: {}, app_metadata: {} };
const expiry = () => Math.floor(Date.now() / 1000) + 3600;
function cookies(response: request.Response): string[] {
  const header = response.headers["set-cookie"]; return Array.isArray(header) ? header : header ? [header] : [];
}
function sessionCookie(response: request.Response): string {
  return cookies(response).find(value => value.startsWith("aura_session_v2="))!.split(";")[0];
}
const origin = "https://www.aura-stream.com";
async function login(remember?: boolean) {
  return request(app).post("/api/login").set("Origin", origin)
    .send({ email: user.email, password: "mot-de-passe-fort-2026", ...(remember === undefined ? {} : { remember }) });
}

describe("rebuilt persistent cookie sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks(); state.rows.clear(); state.failDatabase = false;
    state.signIn.mockResolvedValue({ data: { user, session: {
      access_token: "initial-access", refresh_token: "initial-refresh-long-enough", expires_at: expiry(), user,
    } }, error: null });
    state.getUser.mockResolvedValue({ data: { user }, error: null });
    state.refresh.mockResolvedValue({ data: { user, session: {
      access_token: "rotated-access", refresh_token: "rotated-refresh-long-enough", expires_at: expiry(), user,
    } }, error: null });
    state.signOut.mockResolvedValue({ error: null });
  });

  it("sets one small HttpOnly cookie without exposing Auth tokens in cookies or JSON", async () => {
    const response = await login(); expect(response.status).toBe(200);
    const active = cookies(response).filter(value => !value.includes("Expires=Thu, 01 Jan 1970"));
    expect(active).toHaveLength(1);
    expect(active[0]).toMatch(/^aura_session_v2=[A-Za-z0-9_-]{43};/);
    expect(active[0]).toContain("HttpOnly"); expect(active[0]).toContain("SameSite=Lax");
    expect(active[0]).toContain("Path=/api"); expect(active[0]).toContain("Max-Age=34560000");
    expect(JSON.stringify(response.body)).not.toContain("initial-access");
    expect(cookies(response).join(" ")).not.toContain("initial-refresh-long-enough");
    expect([...state.rows.values()][0].encrypted_tokens).not.toContain("initial-access");
  });

  it("respects an explicit session-cookie choice on a shared device", async () => {
    const response = await login(false);
    expect(cookies(response).find(value => value.startsWith("aura_session_v2="))).not.toContain("Max-Age");
  });

  it("authenticates protected requests directly without a browser refresh request", async () => {
    const cookie = sessionCookie(await login());
    state.rows.get(sessionHash(cookie.split("=")[1])!)!.access_expires_at = 0;
    const response = await request(app).get("/api/me").set("Cookie", cookie);
    expect(response.status).toBe(200); expect(response.body.user.id).toBe(user.id);
    expect(state.refresh).toHaveBeenCalledWith({ refresh_token: "initial-refresh-long-enough" });
    expect(state.getUser).toHaveBeenCalledWith("rotated-access");
    expect(cookies(response)).toEqual([], "Token rotation needs no replacement browser cookie");
    const reopened = await request(app).post("/api/session").set("Origin", origin).set("Cookie", cookie).send({});
    expect(reopened.body.authenticated).toBe(true); expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(cookies(reopened)).toEqual([]);
  });

  it("revokes a durable cookie on logout and cannot recover with a replay", async () => {
    const cookie = sessionCookie(await login());
    await request(app).post("/api/logout").set("Origin", origin).set("Cookie", cookie).expect(204);
    const response = await request(app).post("/api/session").set("Origin", origin).set("Cookie", cookie).send({});
    expect(response.body).toEqual({ authenticated: false, user: null });
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it.each([503, 429, undefined])("preserves the cookie during an Auth outage (%s)", async status => {
    const cookie = sessionCookie(await login());
    state.rows.get(sessionHash(cookie.split("=")[1])!)!.access_expires_at = 0;
    state.refresh.mockResolvedValueOnce({ data: { session: null, user: null }, error: { status } });
    const failed = await request(app).post("/api/session").set("Origin", origin).set("Cookie", cookie).send({});
    expect(failed.status).toBe(503); expect(cookies(failed)).toEqual([]);
    const restored = await request(app).post("/api/session").set("Origin", origin).set("Cookie", cookie).send({});
    expect(restored.body.authenticated).toBe(true);
  });

  it("keeps database outages separate from an anonymous or revoked session", async () => {
    const cookie = sessionCookie(await login()); state.failDatabase = true;
    const response = await request(app).post("/api/session").set("Origin", origin).set("Cookie", cookie).send({});
    expect(response.status).toBe(503); expect(cookies(response)).toEqual([]);
    state.failDatabase = false;
    const restored = await request(app).post("/api/session").set("Origin", origin).set("Cookie", cookie).send({});
    expect(restored.body.authenticated).toBe(true);
  });

  it("upgrades old refresh cookies once and retires old cookie paths", async () => {
    const migrated = await request(app).post("/api/session").set("Origin", origin)
      .set("Cookie", "aura_refresh=legacy-refresh-long-enough; aura_remember=1").send({});
    expect(migrated.status).toBe(200); expect(migrated.body.authenticated).toBe(true);
    expect(cookies(migrated).filter(value => /Expires=Thu, 01 Jan 1970/.test(value))).toHaveLength(6);
    const restored = await request(app).post("/api/session").set("Origin", origin)
      .set("Cookie", sessionCookie(migrated)).send({});
    expect(restored.body.authenticated).toBe(true); expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not contact Auth or the session store for an anonymous visitor", async () => {
    const response = await request(app).post("/api/session").set("Origin", origin).send({});
    expect(response.body).toEqual({ authenticated: false, user: null });
    expect(state.getUser).not.toHaveBeenCalled(); expect(state.refresh).not.toHaveBeenCalled();
  });

  it("requires an allowed Origin for mutating requests using the new cookie", async () => {
    const cookie = sessionCookie(await login());
    await request(app).post("/api/logout").set("Cookie", cookie).expect(403);
    await request(app).post("/api/logout").set("Origin", "https://example.invalid").set("Cookie", cookie).expect(403);
    const restored = await request(app).post("/api/session").set("Origin", origin).set("Cookie", cookie).send({});
    expect(restored.body.authenticated).toBe(true);
  });
});