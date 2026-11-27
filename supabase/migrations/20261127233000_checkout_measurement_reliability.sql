begin;

alter table public.checkout_funnel_orders add column payment_prepared_at timestamptz;
grant update (payment_prepared_at) on public.checkout_funnel_orders to service_role;

create function public.capture_checkout_payment_prepared()
returns trigger language plpgsql security invoker set search_path = ''
as $$
begin
  update public.checkout_funnel_orders
  set payment_prepared_at = now()
  where order_id = new.order_id and payment_prepared_at is null;
  return new;
end;
$$;
revoke all on function public.capture_checkout_payment_prepared() from public, anon, authenticated;
grant execute on function public.capture_checkout_payment_prepared() to service_role;

create trigger capture_checkout_payment_prepared
after update of slickpay_invoice_id on public.orders
for each row when (
  new.slickpay_invoice_id is not null
  and left(new.slickpay_invoice_id, 8) <> 'pending:'
  and old.slickpay_invoice_id is distinct from new.slickpay_invoice_id
)
execute function public.capture_checkout_payment_prepared();

create function public.create_measured_checkout_order(p_order jsonb, p_journey uuid, p_services text[])
returns text language plpgsql security invoker set search_path = ''
as $$
declare
  draft public.orders%rowtype := jsonb_populate_record(null::public.orders, p_order);
begin
  insert into public.orders (
    order_id, assigned_email, customer_user_id, items, amount, subtotal_amount,
    discount_amount, promo_code_id, renewal_order_id, status, payment_status,
    marketing_consent, customer_whatsapp
  ) values (
    draft.order_id, draft.assigned_email, draft.customer_user_id, draft.items, draft.amount, draft.subtotal_amount,
    draft.discount_amount, draft.promo_code_id, draft.renewal_order_id, 'pending', 'unpaid',
    false, draft.customer_whatsapp
  );
  insert into public.checkout_funnel_orders (order_id, journey_id, services)
  values (draft.order_id, p_journey, p_services);
  return draft.order_id;
end;
$$;

create function public.create_measured_partner_order(
  p_user uuid, p_key uuid, p_order jsonb, p_wallet boolean, p_expected numeric,
  p_promo_client_hash text, p_journey uuid, p_services text[]
) returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  result jsonb := public.create_partner_order(p_user, p_key, p_order, p_wallet, p_expected, p_promo_client_hash);
begin
  if result->>'replayed' = 'false' then
    insert into public.checkout_funnel_orders (order_id, journey_id, services, payment_prepared_at)
    values (result->>'order_id', p_journey, p_services, case when p_wallet then now() end);
  end if;
  return result;
end;
$$;

revoke all on function public.create_measured_checkout_order(jsonb,uuid,text[]),
  public.create_measured_partner_order(uuid,uuid,jsonb,boolean,numeric,text,uuid,text[])
from public, anon, authenticated;
grant execute on function public.create_measured_checkout_order(jsonb,uuid,text[]),
  public.create_measured_partner_order(uuid,uuid,jsonb,boolean,numeric,text,uuid,text[])
to service_role;

create or replace function public.checkout_funnel_report(p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable security invoker set search_path = ''
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
    left join lateral (
      select min(l.payment_prepared_at) as prepared_at,
        bool_or(o.payment_confirmation_source in ('slickpay_api', 'partner_wallet')
          and o.payment_confirmed_at >= l.payment_prepared_at
          and o.payment_confirmed_at < m.started_at + interval '24 hours') as confirmed
      from public.checkout_funnel_orders l
      join public.orders o on o.order_id = l.order_id
      where l.journey_id = m.journey_id and m.service = any(l.services)
        and l.payment_prepared_at >= m.started_at
        and l.payment_prepared_at < m.started_at + interval '24 hours'
    ) as payment on true
    cross join lateral (values
      ('product_view', m.product_at, m.added_at >= m.product_at),
      ('add_to_cart', m.added_at, m.cart_at >= m.added_at),
      ('cart_view', m.cart_at, (m.login_at >= m.cart_at or m.customer_at >= m.cart_at)),
      ('login_view', m.login_at, m.customer_at >= m.login_at),
      ('customer_info', m.customer_at, m.summary_at >= m.customer_at),
      ('summary_view', m.summary_at, payment.prepared_at >= m.summary_at),
      ('payment_prepared', payment.prepared_at, payment.confirmed)
    ) as step(stage, reached_at, progressed)
    where step.reached_at is not null
    group by m.service, step.stage
  ), paid_in_period as (
    select count(*) as all_orders, count(l.order_id) as tracked_orders
    from public.orders o left join public.checkout_funnel_orders l on l.order_id = o.order_id
    where o.payment_confirmation_source in ('slickpay_api', 'partner_wallet')
      and o.payment_confirmed_at >= p_from and o.payment_confirmed_at < p_to
  )
  select jsonb_build_object(
    'stages', coalesce((select jsonb_agg(to_jsonb(s) order by s.service, s.stage) from stages s), '[]'::jsonb),
    'all_paid_orders', p.all_orders,
    'tracked_paid_orders', p.tracked_orders
  ) from paid_in_period p;
$$;

commit;
