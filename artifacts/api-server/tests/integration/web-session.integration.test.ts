import { describe, expect, it, vi } from "vitest";
import type { Session } from "@supabase/supabase-js";
import { createSessionCipher, createWebSessions, sessionHash, SessionUnavailable } from "../../src/lib/webSession";
import { memoryWebSessionStore } from "./helpers/web-session-store";

const cipher = createSessionCipher("test-key-material-for-sessions-at-least-32-characters");
const userId = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const { store, rows } = memoryWebSessionStore();
  let time = 1_900_000_000_000;
  let refreshNumber = 0;
  const refresh = vi.fn(async () => ({ error: null, data: { session: {
    access_token: `access-${++refreshNumber}`, refresh_token: `refresh-${refreshNumber}`,
    expires_at: Math.floor(time / 1000) + 3600, user: { id: userId },
  } as Session } }));
  const engine = () => createWebSessions({ store, cipher, refresh, now: () => time });
  const tokens = { access_token: "initial-access", refresh_token: "initial-refresh", expires_at: time / 1000 + 3600 };
  return { engine, store, rows, tokens, refresh, advance: (ms: number) => { time += ms; } };
}

describe("durable opaque browser sessions", () => {
  it("stores only a hash of the stable cookie and encrypts tokens bound to the row", async () => {
    const f = fixture(); const cookie = await f.engine().create(f.tokens, userId, true);
    expect(cookie).toHaveLength(43);
    const row = f.rows.get(sessionHash(cookie)!)!;
    expect(row.id).not.toContain(cookie);
    expect(row.encrypted_tokens).not.toContain(f.tokens.refresh_token);
    expect(cipher.decrypt(row.encrypted_tokens, row.id)).toEqual(f.tokens);
    expect(() => cipher.decrypt(row.encrypted_tokens, "different-session")).toThrow(SessionUnavailable);
  });

  it("survives access expiry, a server restart and a lost refresh response with the same cookie", async () => {
    const f = fixture(); const cookie = await f.engine().create(f.tokens, userId, true);
    f.advance(2 * 3600_000);
    const first = await f.engine().resolve(cookie);
    expect(first?.tokens.access_token).toBe("access-1");
    // The browser receives no new cookie, and discards the HTTP response entirely.
    const restarted = await f.engine().resolve(cookie);
    expect(restarted?.tokens.access_token).toBe("access-1");
    expect(f.refresh).toHaveBeenCalledTimes(1);
    f.advance(7 * 24 * 3600_000);
    expect((await f.engine().resolve(cookie))?.tokens.access_token).toBe("access-2");
    expect(f.refresh).toHaveBeenLastCalledWith("refresh-1");
  });

  it("serializes renewal across separate server processes and concurrent tabs", async () => {
    const f = fixture(); const cookie = await f.engine().create(f.tokens, userId, true);
    f.advance(3600_000);
    const results = await Promise.all(Array.from({ length: 8 }, () => f.engine().resolve(cookie)));
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(results.every(result => result?.tokens.access_token === "access-1")).toBe(true);
  });

  it("preserves the durable row on a transient Auth outage, then restores", async () => {
    const f = fixture(); const cookie = await f.engine().create(f.tokens, userId, true);
    f.advance(3600_000);
    f.refresh.mockResolvedValueOnce({ data: { session: null }, error: { status: 503 } } as any);
    await expect(f.engine().resolve(cookie)).rejects.toThrow(SessionUnavailable);
    expect(f.rows.get(sessionHash(cookie)!)?.revoked_at).toBeNull();
    expect((await f.engine().resolve(cookie))?.tokens.access_token).toBe("access-1");
  });

  it("does not mistake a lost lease for logout when an old server finishes late", async () => {
    const f = fixture(); const cookie = await f.engine().create(f.tokens, userId, true);
    f.advance(3600_000);
    const original = f.refresh.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.refresh.mockImplementationOnce(async () => { await gate; return original(); });
    const late = f.engine().resolve(cookie);
    await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
    f.advance(91_000);
    const takeover = await f.engine().resolve(cookie);
    release();
    expect(await late).toMatchObject({ tokens: takeover!.tokens });
    expect(f.rows.get(sessionHash(cookie)!)?.revoked_at).toBeNull();
  });

  it("logout wins against an in-flight refresh and remains revoked after restart", async () => {
    const f = fixture(); const cookie = await f.engine().create(f.tokens, userId, true);
    f.advance(3600_000);
    const original = f.refresh.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.refresh.mockImplementation(async () => { await gate; return original(); });
    const resolving = f.engine().resolve(cookie);
    await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
    await f.engine().revoke(cookie); release();
    expect(await resolving).toBeNull();
    expect(await f.engine().resolve(cookie)).toBeNull();
  });

  it("revokes a genuinely rejected Auth session without retrying it forever", async () => {
    const f = fixture(); const cookie = await f.engine().create(f.tokens, userId, true);
    f.advance(3600_000);
    f.refresh.mockResolvedValueOnce({ data: { session: null }, error: { status: 400 } } as any);
    expect(await f.engine().resolve(cookie)).toBeNull();
    expect(await f.engine().resolve(cookie)).toBeNull();
    expect(f.refresh).toHaveBeenCalledTimes(1);
  });

  it("recovers after a database write fails following successful Auth rotation", async () => {
    const f = fixture(); const cookie = await f.engine().create(f.tokens, userId, true);
    f.advance(3600_000);
    const commit = f.store.commit;
    let fails = true;
    f.store.commit = async (...args) => {
      if (fails) { fails = false; throw new SessionUnavailable(); }
      return commit(...args);
    };
    await expect(f.engine().resolve(cookie)).rejects.toThrow(SessionUnavailable);
    expect(f.rows.get(sessionHash(cookie)!)?.revoked_at).toBeNull();
    expect((await f.engine().resolve(cookie))?.tokens.access_token).toBe("access-2");
  });

  it("revokes all browser sessions after password recovery, but not another user's session", async () => {
    const f = fixture(); const engine = f.engine();
    const first = await engine.create(f.tokens, userId, true);
    const second = await engine.create(f.tokens, userId, false);
    const other = await engine.create(f.tokens, "22222222-2222-4222-8222-222222222222", true);
    await engine.revokeUser(userId);
    expect(await engine.resolve(first)).toBeNull();
    expect(await engine.resolve(second)).toBeNull();
    expect(await engine.resolve(other)).not.toBeNull();
    expect(await engine.resolve("tampered-cookie")).toBeNull();
  });
});
