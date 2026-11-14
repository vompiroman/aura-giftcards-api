create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;
create table auth.users(id uuid primary key);
create table public.orders (
 id uuid primary key default gen_random_uuid(), order_id text unique not null,
 assigned_email text, amount numeric not null, subtotal_amount numeric, discount_amount numeric,
 status text not null, payment_status text not null check(payment_status in ('paid','failed','unpaid')),
 items jsonb not null, promo_code_id uuid, renewal_order_id text, marketing_consent boolean,
 marketing_consent_at timestamptz, consent_version text, customer_whatsapp text,
 slickpay_invoice_id text unique, payment_last_checked_at timestamptz, payment_provider_status text,
 payment_provider_amount numeric, payment_check_count integer not null default 0,
 payment_confirmed_at timestamptz, payment_confirmation_source text
);
create table public.inventory(id uuid primary key default gen_random_uuid(), assigned_order_id text, is_used boolean);
grant select,insert,update on public.orders to service_role;
grant insert,update on public.orders to authenticated;
grant select on public.inventory to service_role;
create function public.reserve_promo_redemption(uuid,text,text) returns boolean language sql as $$select false$$;

