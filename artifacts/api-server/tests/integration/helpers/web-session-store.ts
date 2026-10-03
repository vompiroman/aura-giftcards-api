import type { WebSessionRow, WebSessionStore } from "../../../src/lib/webSession";

// Persists across engine instances, modelling separate Render processes.
export function memoryWebSessionStore() {
  const rows = new Map<string, WebSessionRow>();
  const store: WebSessionStore = {
    async create(row) { rows.set(row.id, { ...row }); },
    async read(id) { const row = rows.get(id); return row ? { ...row } : null; },
    async claim(id, owner, now, until) {
      const row = rows.get(id);
      if (!row || row.revoked_at || row.expires_at <= now || (row.refresh_lease_until && row.refresh_lease_until >= now)) return null;
      row.refresh_owner = owner; row.refresh_lease_until = until;
      return { ...row };
    },
    async commit(id, owner, tokens, expiry) {
      const row = rows.get(id);
      if (!row || row.revoked_at || row.refresh_owner !== owner) return false;
      Object.assign(row, { encrypted_tokens: tokens, access_expires_at: expiry, refresh_owner: null, refresh_lease_until: null });
      return true;
    },
    async release(id, owner) {
      const row = rows.get(id);
      if (row?.refresh_owner === owner) Object.assign(row, { refresh_owner: null, refresh_lease_until: null });
    },
    async revoke(id, owner) { const row = rows.get(id); if (row && (!owner || row.refresh_owner === owner)) { row.revoked_at = new Date().toISOString(); row.encrypted_tokens = ""; } },
    async revokeUser(userId) { for (const row of rows.values()) if (row.user_id === userId) await store.revoke(row.id); },
  };
  return { store, rows };
}
