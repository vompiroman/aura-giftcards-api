create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;
create table auth.users(
  id uuid primary key, email text, email_confirmed_at timestamptz, created_at timestamptz default now()
);
create table public.orders (
 id uuid primary key default gen_random_uuid(), order_id text unique not null,
 assigned_email text, amount numeric not null, subtotal_amount numeric, discount_amount numeric,
 status text not null, payment_status text not null check(payment_status in ('paid','failed','unpaid')),
 items jsonb not null, promo_code_id uuid, renewal_order_id text, marketing_consent boolean,
 marketing_consent_at timestamptz, consent_version text, customer_whatsapp text,
 slickpay_invoice_id text unique, payment_last_checked_at timestamptz, payment_provider_status text,
 payment_provider_amount numeric, payment_check_count integer not null default 0,
 payment_confirmed_at timestamptz, payment_confirmation_source text,
 purchase_email_requested_at timestamptz, purchase_email_sent_at timestamptz, meta_purchase_sent_at timestamptz,
 purchase_email_attempts integer not null default 0,
 created_at timestamp without time zone not null default (now() at time zone 'UTC'),
 expires_at timestamp without time zone, completed_at timestamptz, activated_at timestamptz
);
create table public.inventory(id uuid primary key default gen_random_uuid(), assigned_order_id text, is_used boolean,
  service text, account_email text, profile_name text, profile_pin text,
  assigned_user_id text, assigned_at timestamptz, created_at timestamptz default now());
grant select,insert,update on public.orders to service_role;
grant insert,update on public.orders to authenticated;
grant select on public.inventory to service_role;
create function public.reserve_promo_redemption(uuid,text,text) returns boolean language sql as $$select false$$;
