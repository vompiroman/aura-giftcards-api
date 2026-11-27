begin;

create table public.checkout_funnel_events (
  journey_id uuid not null,
  service text not null check (service in ('netflix', 'spotify', 'crunchyroll', 'snapchat')),
  stage text not null check (stage in ('product_view', 'add_to_cart', 'cart_view', 'login_view', 'customer_info', 'summary_view')),
  recorded_at timestamptz not null default now(),
  primary key (journey_id, service, stage)
);
create index checkout_funnel_events_time on public.checkout_funnel_events (recorded_at);

create table public.checkout_funnel_orders (
  order_id text primary key,
  journey_id uuid not null,
  services text[] not null check (
    cardinality(services) between 1 and 4
    and services <@ array['netflix', 'spotify', 'crunchyroll', 'snapchat']::text[]
  ),
  recorded_at timestamptz not null default now()
);
create index checkout_funnel_orders_journey on public.checkout_funnel_orders (journey_id);
create index checkout_funnel_orders_time on public.checkout_funnel_orders (recorded_at);

alter table public.checkout_funnel_events enable row level security;
alter table public.checkout_funnel_orders enable row level security;
revoke all on public.checkout_funnel_events, public.checkout_funnel_orders from public, anon, authenticated;
grant select, insert on public.checkout_funnel_events, public.checkout_funnel_orders to service_role;

create function public.checkout_funnel_report(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql stable security invoker set search_path = ''
as $$
  with recent as (
    select journey_id, service, stage, recorded_at
    from public.checkout_funnel_events
    where recorded_at >= p_from - interval '24 hours' and recorded_at < p_to + interval '24 hours'
  ), starts as (
    select journey_id, service, min(recorded_at) as started_at
    from recent
    group by journey_id, service
    having min(recorded_at) >= p_from and min(recorded_at) < p_to
  ), milestones as (
    select e.journey_id, e.service, s.started_at,
      min(e.recorded_at) filter (where e.stage = 'product_view') as product_at,
      min(e.recorded_at) filter (where e.stage = 'add_to_cart') as added_at,
      min(e.recorded_at) filter (where e.stage = 'cart_view') as cart_at,
      min(e.recorded_at) filter (where e.stage = 'login_view') as login_at,
      min(e.recorded_at) filter (where e.stage = 'customer_info') as customer_at,
      min(e.recorded_at) filter (where e.stage = 'summary_view') as summary_at
    from starts s join recent e using (journey_id, service)
    where e.recorded_at < s.started_at + interval '24 hours'
    group by e.journey_id, e.service, s.started_at
  ), stages as (
    select m.service, step.stage, count(*) as reached, count(*) filter (where step.progressed) as continued
    from milestones m
    cross join lateral (values
      ('product_view', m.product_at, m.added_at >= m.product_at),
      ('add_to_cart', m.added_at, m.cart_at >= m.added_at),
      ('cart_view', m.cart_at, (m.login_at >= m.cart_at or m.customer_at >= m.cart_at)),
      ('login_view', m.login_at, m.customer_at >= m.login_at),
      ('customer_info', m.customer_at, m.summary_at >= m.customer_at),
      ('summary_view', m.summary_at, exists (
        select 1 from public.checkout_funnel_orders l join public.orders o on o.order_id = l.order_id
        where l.journey_id = m.journey_id and m.service = any(l.services)
          and o.payment_status = 'paid'
          and o.payment_confirmed_at >= m.started_at
          and o.payment_confirmed_at < m.started_at + interval '24 hours'
      ))
    ) as step(stage, reached_at, progressed)
    where step.reached_at is not null
    group by m.service, step.stage
  ), paid_in_period as (
    select count(*) as all_orders, count(l.order_id) as tracked_orders
    from public.orders o left join public.checkout_funnel_orders l on l.order_id = o.order_id
    where o.payment_status = 'paid' and o.payment_confirmed_at >= p_from and o.payment_confirmed_at < p_to
  )
  select jsonb_build_object(
    'stages', coalesce((select jsonb_agg(to_jsonb(s) order by s.service, s.stage) from stages s), '[]'::jsonb),
    'all_paid_orders', p.all_orders,
    'tracked_paid_orders', p.tracked_orders
  ) from paid_in_period p;
$$;

revoke all on function public.checkout_funnel_report(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.checkout_funnel_report(timestamptz, timestamptz) to service_role;

select cron.schedule('aura-checkout-funnel-retention', '23 3 * * *', $job$
  delete from public.checkout_funnel_events where recorded_at < now() - interval '45 days';
  delete from public.checkout_funnel_orders where recorded_at < now() - interval '45 days';
$job$);

commit;
