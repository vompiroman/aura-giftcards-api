import { supabaseAdmin, createAuthClient } from "./supabase";
import { createSessionCipher, createWebSessions, SessionUnavailable, type WebSessionStore } from "./webSession";

const table = "web_sessions";
function checked<T>({ data, error }: { data: T; error: unknown }): T {
  if (error) throw new SessionUnavailable();
  return data;
}

export const webSessionStore: WebSessionStore = {
  async create(row) { checked(await supabaseAdmin.from(table).insert(row)); },
  async read(id) { return checked(await supabaseAdmin.from(table).select("*").eq("id", id).maybeSingle()); },
  async claim(id, owner, now, until) {
    return checked(await supabaseAdmin.from(table).update({ refresh_owner: owner, refresh_lease_until: until })
      .eq("id", id).is("revoked_at", null).gt("expires_at", now)
      .or(`refresh_lease_until.is.null,refresh_lease_until.lt.${now}`).select("*").maybeSingle());
  },
  async commit(id, owner, tokens, expiry) {
    const rows = checked(await supabaseAdmin.from(table).update({ encrypted_tokens: tokens, access_expires_at: expiry,
      refresh_owner: null, refresh_lease_until: null }).eq("id", id).eq("refresh_owner", owner)
      .is("revoked_at", null).select("id"));
    return Boolean(rows?.length);
  },
  async release(id, owner) {
    checked(await supabaseAdmin.from(table).update({ refresh_owner: null, refresh_lease_until: null }).eq("id", id).eq("refresh_owner", owner));
  },
  async revoke(id, owner) {
    let query = supabaseAdmin.from(table).update({ revoked_at: new Date().toISOString(), encrypted_tokens: "" }).eq("id", id);
    if (owner) query = query.eq("refresh_owner", owner);
    checked(await query);
  },
  async revokeUser(userId) {
    checked(await supabaseAdmin.from(table).update({ revoked_at: new Date().toISOString(), encrypted_tokens: "" }).eq("user_id", userId).is("revoked_at", null));
  },
};

let engine: ReturnType<typeof createWebSessions> | undefined;
export function webSessions() {
  return engine ||= createWebSessions({ store: webSessionStore,
    cipher: createSessionCipher(process.env.SESSION_ENCRYPTION_KEY || process.env.INVENTORY_CREDENTIALS_KEY || process.env.CLIENT_CREDENTIALS_KEY || ""),
    refresh: token => createAuthClient().auth.refreshSession({ refresh_token: token }),
  });
}
