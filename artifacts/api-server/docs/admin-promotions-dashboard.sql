-- Applied to the Aura Stream Supabase project on 2026-07-30.
-- Keep this file as the reproducible schema reference for the admin dashboard.

alter table public.promo_codes add column if not exists created_by uuid;
create index if not exists promo_codes_created_by_idx
  on public.promo_codes (created_by) where created_by is not null;
create index if not exists orders_assigned_email_created_idx
  on public.orders (assigned_email, created_at desc) where assigned_email is not null;
create index if not exists orders_paid_created_idx
  on public.orders (created_at desc) where payment_status = 'paid';
create index if not exists orders_paid_promo_code_idx
  on public.orders (promo_code_id, created_at desc) where payment_status = 'paid' and promo_code_id is not null;
create index if not exists inventory_service_available_idx
  on public.inventory (service) where is_used = false;
create index if not exists promo_redemptions_promo_client_idx
  on public.promo_redemptions (promo_code_id, client_hash);
create index if not exists orders_customer_id_idx
  on public.orders (customer_id) where customer_id is not null;
create index if not exists orders_gift_card_id_idx
  on public.orders (gift_card_id) where gift_card_id is not null;

-- The browser never accesses operational tables through the Supabase data API.
-- It uses the authenticated backend only; RLS stays enabled as a second barrier.
revoke all on table public.clients, public.customers, public.email_accounts,
  public.gift_cards, public.inventory, public.orders, public.promo_codes,
  public.promo_redemptions, public.audit_logs from anon, authenticated;

create or replace function public.get_promo_usage(p_promo_code_id uuid, p_client_hash text)
returns table(total_uses bigint, client_uses bigint)
language sql stable security invoker set search_path = public as $$
  select count(*) filter (where o.payment_status = 'paid')::bigint,
         count(*) filter (where o.payment_status = 'paid' and r.client_hash = p_client_hash)::bigint
  from public.promo_redemptions r
  join public.orders o on o.order_id = r.order_id
  where r.promo_code_id = p_promo_code_id;
$$;

-- The payment confirmation path calls this once an order has transitioned to
-- paid. Row locks make the usage limits safe when confirmations arrive at the
-- same time, and the unique constraint makes webhook retries idempotent.
create or replace function public.reserve_promo_redemption(
  p_promo_code_id uuid,
  p_order_id text,
  p_client_hash text
)
returns boolean
language plpgsql
security invoker
set search_path = public as $$
declare
  v_promo public.promo_codes%rowtype;
  v_total integer;
  v_client integer;
  v_payment_status text;
begin
  select payment_status into v_payment_status
  from public.orders
  where order_id = p_order_id
  for update;

  if v_payment_status is distinct from 'paid' then return false; end if;

  select * into v_promo
  from public.promo_codes
  where id = p_promo_code_id and active = true
  for update;

  if not found then return false; end if;
  if v_promo.starts_at is not null and v_promo.starts_at > now() then return false; end if;
  if v_promo.ends_at is not null and v_promo.ends_at < now() then return false; end if;

  select count(*)::integer into v_total
  from public.promo_redemptions r
  join public.orders o on o.order_id = r.order_id
  where r.promo_code_id = p_promo_code_id and o.payment_status = 'paid';

  select count(*)::integer into v_client
  from public.promo_redemptions r
  join public.orders o on o.order_id = r.order_id
  where r.promo_code_id = p_promo_code_id
    and r.client_hash = p_client_hash
    and o.payment_status = 'paid';

  if v_promo.max_uses is not null and v_total >= v_promo.max_uses then return false; end if;
  if v_promo.max_uses_per_client is not null and v_client >= v_promo.max_uses_per_client then return false; end if;

  insert into public.promo_redemptions (promo_code_id, order_id, client_hash)
  values (p_promo_code_id, p_order_id, p_client_hash)
  on conflict (promo_code_id, order_id) do nothing;
  return true;
end;
$$;

create or replace function public.get_admin_promo_stats()
returns table(promo_code_id uuid, sales_count bigint, revenue_amount numeric, gross_revenue numeric, discount_total numeric, last_used_at timestamptz)
language sql stable security invoker set search_path = public as $$
  select p.id, count(o.id)::bigint, coalesce(sum(o.amount), 0)::numeric,
         coalesce(sum(coalesce(o.subtotal_amount, o.amount)), 0)::numeric,
         coalesce(sum(coalesce(o.discount_amount, 0)), 0)::numeric,
         max(o.created_at) at time zone 'UTC'
  from public.promo_codes p
  left join public.orders o on o.promo_code_id = p.id and o.payment_status = 'paid'
  group by p.id;
$$;

create or replace function public.get_admin_dashboard_metrics(p_days integer default 30)
returns jsonb language sql stable security invoker set search_path = public as $$
  with config as (select greatest(7, least(coalesce(p_days, 30), 365))::integer as days),
  summary as (
    select jsonb_build_object(
      'revenue_total', coalesce(sum(amount) filter (where payment_status = 'paid'), 0),
      'revenue_period', coalesce(sum(amount) filter (where payment_status = 'paid' and created_at >= (now() at time zone 'UTC') - make_interval(days => (select days from config))), 0),
      'revenue_today', coalesce(sum(amount) filter (where payment_status = 'paid' and created_at::date = (now() at time zone 'UTC')::date), 0),
      'paid_orders_total', count(*) filter (where payment_status = 'paid'),
      'paid_orders_period', count(*) filter (where payment_status = 'paid' and created_at >= (now() at time zone 'UTC') - make_interval(days => (select days from config))),
      'average_order', coalesce(round(avg(amount) filter (where payment_status = 'paid')::numeric, 2), 0),
      'unpaid_orders', count(*) filter (where payment_status = 'unpaid'),
      'failed_payments', count(*) filter (where payment_status = 'failed'),
      'activation_pending', count(*) filter (where payment_status = 'paid' and status = 'pending')
    ) as value from public.orders
  ),
  days as (select generate_series(((now() at time zone 'UTC')::date - ((select days from config) - 1)), (now() at time zone 'UTC')::date, interval '1 day')::date as day),
  daily_rows as (select d.day, coalesce(sum(o.amount), 0) as revenue, count(o.id) as sales from days d left join public.orders o on o.created_at::date = d.day and o.payment_status = 'paid' group by d.day order by d.day),
  services(service) as (values ('netflix'::text), ('spotify'::text), ('crunchyroll'::text)),
  stock_rows as (select s.service, count(i.id)::bigint as total, count(i.id) filter (where i.is_used = false)::bigint as available, count(i.id) filter (where i.is_used = true)::bigint as assigned from services s left join public.inventory i on lower(i.service) = s.service group by s.service)
  select jsonb_build_object(
    'summary', (select value from summary),
    'revenue_by_day', coalesce((select jsonb_agg(jsonb_build_object('date', day, 'revenue', revenue, 'sales', sales) order by day) from daily_rows), '[]'::jsonb),
    'stock', coalesce((select jsonb_agg(jsonb_build_object('service', service, 'total', total, 'available', available, 'assigned', assigned) order by service) from stock_rows), '[]'::jsonb)
  );
$$;

-- Server-side code invokes these functions with the service-role key only.
revoke all on function public.get_promo_usage(uuid, text) from public, anon, authenticated;
revoke all on function public.reserve_promo_redemption(uuid, text, text) from public, anon, authenticated;
revoke all on function public.get_admin_promo_stats() from public, anon, authenticated;
revoke all on function public.get_admin_dashboard_metrics(integer) from public, anon, authenticated;
grant execute on function public.get_promo_usage(uuid, text) to service_role;
grant execute on function public.reserve_promo_redemption(uuid, text, text) to service_role;
grant execute on function public.get_admin_promo_stats() to service_role;
grant execute on function public.get_admin_dashboard_metrics(integer) to service_role;
