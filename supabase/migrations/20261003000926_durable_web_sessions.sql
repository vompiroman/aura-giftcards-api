-- Only the API service role can access the opaque browser session records.
-- Browser cookies contain random identifiers; Auth tokens stay encrypted here.
create table public.web_sessions (
  id text primary key check (id ~ '^[a-f0-9]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  encrypted_tokens text not null,
  access_expires_at bigint not null,
  remember boolean not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  refresh_owner uuid,
  refresh_lease_until timestamptz,
  created_at timestamptz not null default now(),
  constraint web_sessions_refresh_lease_pair check ((refresh_owner is null) = (refresh_lease_until is null))
);
alter table public.web_sessions enable row level security;
revoke all on public.web_sessions from public, anon, authenticated;
grant select, insert, update, delete on public.web_sessions to service_role;
create index web_sessions_active_user on public.web_sessions(user_id) where revoked_at is null;
create index web_sessions_expiry on public.web_sessions(expires_at);
comment on table public.web_sessions is 'API-only persistent sessions; token ciphertext is bound to the SHA-256 cookie identifier.';
