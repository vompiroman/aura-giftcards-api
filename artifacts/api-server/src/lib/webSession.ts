import crypto from "node:crypto";
import type { Session } from "@supabase/supabase-js";
import { isTemporaryAuthError } from "./authAvailability";

export const WEB_SESSION_COOKIE = "aura_session_v2";
export const WEB_SESSION_LIFETIME_MS = 400 * 24 * 60 * 60 * 1000;
export type SessionTokens = Pick<Session, "access_token" | "refresh_token"> & { expires_at: number };
export type WebSessionRow = {
  id: string; user_id: string; encrypted_tokens: string; access_expires_at: number;
  remember: boolean; expires_at: string; revoked_at: string | null;
  refresh_owner: string | null; refresh_lease_until: string | null;
};
export interface WebSessionStore {
  create(row: WebSessionRow): Promise<void>;
  read(id: string): Promise<WebSessionRow | null>;
  claim(id: string, owner: string, now: string, until: string): Promise<WebSessionRow | null>;
  commit(id: string, owner: string, tokens: string, expiry: number): Promise<boolean>;
  release(id: string, owner: string): Promise<void>;
  revoke(id: string, owner?: string): Promise<void>;
  revokeUser(userId: string): Promise<void>;
}

export class SessionUnavailable extends Error {
  constructor() { super("Service de connexion momentanément indisponible."); }
}

export function sessionHash(cookie: unknown): string | null {
  if (typeof cookie !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(cookie)) return null;
  return crypto.createHash("sha256").update(cookie).digest("hex");
}

// Separate cryptographic purpose from inventory credentials, even when the
// existing deployment secret is used as key material.
export function createSessionCipher(secret: string) {
  if (secret.length < 32) throw new SessionUnavailable();
  const key = crypto.createHash("sha256").update(`aura-web-session-v2:${secret}`).digest();
  return {
    encrypt(tokens: SessionTokens, id: string): string {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(id));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
      return ["v2", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
    },
    decrypt(value: string, id: string): SessionTokens {
      try {
        const [version, iv, tag, ciphertext] = value.split(".");
        if (version !== "v2") throw new Error();
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
        decipher.setAAD(Buffer.from(id));
        decipher.setAuthTag(Buffer.from(tag, "base64url"));
        const tokens = JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8"));
        if (!tokens.access_token || !tokens.refresh_token || !Number.isFinite(tokens.expires_at)) throw new Error();
        return tokens;
      } catch { throw new SessionUnavailable(); }
    },
  };
}

export function createWebSessions({ store, cipher, refresh, now = Date.now,
  sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) }: {
  store: WebSessionStore; cipher: ReturnType<typeof createSessionCipher>;
  refresh: (token: string) => Promise<{ data: { session: Session | null }; error: { status?: number } | null }>;
  now?: () => number; sleep?: (ms: number) => Promise<void>;
}) {
  async function create(session: SessionTokens, userId: string, remember: boolean) {
    const cookie = crypto.randomBytes(32).toString("base64url");
    const id = sessionHash(cookie)!;
    await store.create({ id, user_id: userId, remember,
      encrypted_tokens: cipher.encrypt(session, id), access_expires_at: session.expires_at,
      expires_at: new Date(now() + WEB_SESSION_LIFETIME_MS).toISOString(), revoked_at: null,
      refresh_owner: null, refresh_lease_until: null });
    return cookie;
  }

  async function resolve(cookie: unknown, forceRefresh = false): Promise<{ tokens: SessionTokens; row: WebSessionRow } | null> {
    const id = sessionHash(cookie);
    if (!id) return null;
    // The lease is in the database, so restart/deployment/multiple processes
    // cannot race rotating refresh tokens. No cookie change is needed.
    for (let attempt = 0; attempt < 100; attempt++) {
      const row = await store.read(id);
      if (!row || row.revoked_at || Date.parse(row.expires_at) <= now()) return null;
      if (!forceRefresh && row.access_expires_at > Math.floor(now() / 1000) + 90) {
        return { row, tokens: cipher.decrypt(row.encrypted_tokens, id) };
      }
      const owner = crypto.randomUUID();
      const claimed = await store.claim(id, owner, new Date(now()).toISOString(), new Date(now() + 90_000).toISOString());
      if (!claimed) { await sleep(100); continue; }
      try {
        // Another process may have refreshed between our read and claim.
        if (claimed.access_expires_at !== row.access_expires_at || claimed.encrypted_tokens !== row.encrypted_tokens) {
          forceRefresh = false;
          continue;
        }
        const previous = cipher.decrypt(claimed.encrypted_tokens, id);
        const { data, error } = await refresh(previous.refresh_token);
        if (error) {
          if (isTemporaryAuthError(error)) throw new SessionUnavailable();
          await store.revoke(id, owner);
          const current = await store.read(id);
          if (!current || current.revoked_at) return null;
          forceRefresh = false;
          continue; // A different lease has already recovered this session.
        }
        const session = data.session;
        if (!session?.access_token || !session.refresh_token || !session.expires_at) throw new SessionUnavailable();
        if (session.user?.id !== row.user_id) throw new SessionUnavailable();
        const next: SessionTokens = { access_token: session.access_token, refresh_token: session.refresh_token, expires_at: session.expires_at };
        const committed = await store.commit(id, owner, cipher.encrypt(next, id), next.expires_at);
        if (!committed) {
          const current = await store.read(id);
          if (!current || current.revoked_at) return null; // Logout won the race.
          forceRefresh = false;
          continue; // Lease takeover is not evidence of logout.
        }
        return { row: { ...row, access_expires_at: next.expires_at }, tokens: next };
      } finally { await store.release(id, owner); }
    }
    throw new SessionUnavailable();
  }

  return { create, resolve,
    async revoke(cookie: unknown) { const id = sessionHash(cookie); if (id) await store.revoke(id); },
    revokeUser: (userId: string) => store.revokeUser(userId),
  };
}
