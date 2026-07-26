begin;

-- Stock allocation is already serialized by the existing
-- assign_inventory_for_order RPC: it locks the order row and selects
-- inventory rows with FOR UPDATE SKIP LOCKED before marking them used.
-- Keep all allocation calls behind that RPC; never allocate in a read-then-write
-- HTTP handler.

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  actor_user_id uuid,
  action text not null,
  target_type text,
  target_id text,
  details jsonb not null default '{}'::jsonb
);

create index if not exists audit_logs_created_at_idx on public.audit_logs (created_at desc);
create index if not exists audit_logs_target_idx on public.audit_logs (target_type, target_id);
alter table public.audit_logs enable row level security;
revoke all on public.audit_logs from public, anon, authenticated;
drop policy if exists audit_logs_admin_read on public.audit_logs;
create policy audit_logs_admin_read on public.audit_logs
  for select to authenticated
  using ((auth.jwt()->'app_metadata'->>'role') = 'admin');

alter table public.orders
  add column if not exists promo_code_id uuid,
  add column if not exists subtotal_amount numeric,
  add column if not exists discount_amount numeric default 0;

create table if not exists public.promo_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  code_prefix text not null,
  discount_type text not null check (discount_type in ('fixed', 'percentage')),
  discount_value numeric not null check (discount_value > 0),
  starts_at timestamptz,
  ends_at timestamptz,
  max_uses integer check (max_uses is null or max_uses > 0),
  max_uses_per_client integer check (max_uses_per_client is null or max_uses_per_client > 0),
  services text[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.promo_codes add column if not exists code_prefix text;

create table if not exists public.promo_redemptions (
  id uuid primary key default gen_random_uuid(),
  promo_code_id uuid not null references public.promo_codes(id) on delete cascade,
  order_id text not null unique references public.orders(order_id) on delete cascade,
  client_hash text not null,
  redeemed_at timestamptz not null default now(),
  unique (promo_code_id, order_id)
);

alter table public.promo_codes enable row level security;
alter table public.promo_redemptions enable row level security;
revoke all on public.promo_codes, public.promo_redemptions from public, anon, authenticated;
drop policy if exists promo_codes_admin_read on public.promo_codes;
create policy promo_codes_admin_read on public.promo_codes
  for select to authenticated
  using ((auth.jwt()->'app_metadata'->>'role') = 'admin');

create or replace function public.reserve_promo_redemption(
  p_promo_code_id uuid,
  p_order_id text,
  p_client_hash text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_promo promo_codes%rowtype;
  v_total integer;
  v_client integer;
begin
  select * into v_promo from public.promo_codes where id = p_promo_code_id and active = true for update;
  if not found then return false; end if;
  select count(*)::integer into v_total from public.promo_redemptions where promo_code_id = p_promo_code_id;
  select count(*)::integer into v_client from public.promo_redemptions
    where promo_code_id = p_promo_code_id and client_hash = p_client_hash;
  if v_promo.max_uses is not null and v_total >= v_promo.max_uses then return false; end if;
  if v_promo.max_uses_per_client is not null and v_client >= v_promo.max_uses_per_client then return false; end if;
  insert into public.promo_redemptions (promo_code_id, order_id, client_hash)
    values (p_promo_code_id, p_order_id, p_client_hash)
    on conflict (promo_code_id, order_id) do nothing;
  return true;
end;
$$;

revoke all on function public.reserve_promo_redemption(uuid, text, text) from public, anon, authenticated;
grant execute on function public.reserve_promo_redemption(uuid, text, text) to service_role;

commit;
