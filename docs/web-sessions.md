# Persistent browser sessions

Apply `supabase/migrations/20261003000926_durable_web_sessions.sql` before deploying the API. The table is protected with RLS and has no anon/authenticated grants; only the API service role accesses it.

The browser receives one random 32-byte HttpOnly cookie, `aura_session_v2`, scoped to `/api` with SameSite=Lax and Secure in production. Remembered cookies last 400 days; opting out creates a browser session cookie. Supabase access/refresh tokens are never returned in cookies or JSON. Existing token cookies migrate on `/session`, then their old paths are cleared.

The database stores only the SHA-256 cookie identifier. Auth tokens use AES-256-GCM with authenticated row ID. Key material comes from SESSION_ENCRYPTION_KEY when set, otherwise the existing INVENTORY_CREDENTIALS_KEY/CLIENT_CREDENTIALS_KEY, with a distinct session key derivation. Do not change key material without a planned session invalidation. No new paid Render service or disk is needed.

Before protected requests, the API reads the session and renews access tokens when less than 90 seconds remain. An atomic database lease serializes rotation across processes. A stable browser cookie still resolves the latest tokens after a lost response or Render restart. Auth/database failures return 503 without deleting the cookie or revoking the session. An expired lease can be recovered; its former owner cannot revoke or overwrite a newer lease.

Logout revokes the database record before clearing the cookie. Recovery password changes revoke all stored sessions for that user. Invalid/revoked Auth refresh tokens revoke the associated record. No request or audit log includes cookie values, tokens or ciphertext.

Validation covers expiry, independent engine instances sharing durable state, concurrent requests, lost responses, lease takeover, transient Auth/database failures, CSRF, cookie attributes, legacy migration and logout during refresh. Production verification must additionally check an actual cookie session across expiry and Render process replacement. Synthetic test rows must not include customer credentials.
