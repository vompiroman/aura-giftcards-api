-- Read-only. Replace the start with the scheduled UTC timestamp before running.
-- Replace the empty card_refunds input with verified order IDs and UTC refund dates.
-- Flip card_refunds_complete only after reconciling all eligible SlickPay orders.
with inputs as (
  select null::timestamptz as start_at, false as card_refunds_complete, now() as as_of
), card_refunds(order_id, refunded_at) as (
  select null::text, null::timestamptz where false
), config as (
  select *, start_at + interval '28 days' as end_at from inputs
), exposures as (
  select e.* from public.checkout_guest_login_ab_events e cross join config c
  where e.kind = 'guest_login_exposure' and e.occurred_at >= c.start_at and e.occurred_at < c.end_at
), milestones as (
  select e.journey_id, e.variant,
    exists (select 1 from public.checkout_funnel_events f where f.journey_id = e.journey_id
      and f.stage = 'customer_info' and f.recorded_at >= e.occurred_at and f.recorded_at < e.journey_expires_at) as customer_info,
    exists (select 1 from public.checkout_funnel_events f where f.journey_id = e.journey_id
      and f.stage = 'summary_view' and f.recorded_at >= e.occurred_at and f.recorded_at < e.journey_expires_at) as summary_view,
    coalesce((select bool_or(f.kind = 'guest_login_auth_error') from public.checkout_guest_login_ab_events f
      where f.journey_id = e.journey_id and f.occurred_at >= e.occurred_at and f.occurred_at < e.journey_expires_at), false) as auth_error,
    coalesce((select bool_or(f.kind = 'guest_login_checkout_error') from public.checkout_guest_login_ab_events f
      where f.journey_id = e.journey_id and f.occurred_at >= e.occurred_at and f.occurred_at < e.journey_expires_at), false) as checkout_error
  from exposures e cross join config c
  where e.journey_expires_at <= c.as_of
), paid as (
  select e.variant, e.journey_id, o.order_id, o.payment_confirmed_at,
    case when o.payment_confirmation_source = 'partner_wallet' then
      o.partner_wallet_refunded_at >= o.payment_confirmed_at
      and o.partner_wallet_refunded_at < o.payment_confirmed_at + interval '14 days'
    else exists (select 1 from card_refunds r where r.order_id = o.order_id
      and r.refunded_at >= o.payment_confirmed_at and r.refunded_at < o.payment_confirmed_at + interval '14 days') end as refunded
  from exposures e cross join config c
  join public.checkout_funnel_orders l on l.journey_id = e.journey_id
  join public.orders o on o.order_id = l.order_id
  where e.journey_expires_at <= c.as_of
    and o.payment_confirmation_source in ('slickpay_api', 'partner_wallet')
    and l.payment_prepared_at >= e.occurred_at and o.payment_confirmed_at >= l.payment_prepared_at
    and o.payment_confirmed_at < e.journey_expires_at
)
select v.variant,
  (select count(*) from exposures e where e.variant = v.variant) as exposed,
  (select count(*) from milestones m where m.variant = v.variant) as mature,
  (c.as_of >= c.end_at + interval '24 hours') as primary_closed,
  case when c.as_of >= c.end_at + interval '24 hours' then
    (select count(*) from milestones m where m.variant = v.variant and m.customer_info) end as customer_info,
  case when c.as_of >= c.end_at + interval '24 hours' then
    (select count(*) from milestones m where m.variant = v.variant and m.summary_view) end as summary_view,
  case when c.as_of >= c.end_at + interval '24 hours' then
    (select count(distinct p.journey_id) from paid p where p.variant = v.variant) end as paid_journeys,
  (select count(*) from milestones m where m.variant = v.variant and m.auth_error) as auth_errors,
  (select count(*) from milestones m where m.variant = v.variant and m.checkout_error) as checkout_errors,
  (select count(*) from paid p where p.variant = v.variant and p.payment_confirmed_at + interval '14 days' <= c.as_of) as mature_paid_orders,
  (c.card_refunds_complete and c.as_of >= c.end_at + interval '15 days') as refunds_closed,
  case when c.card_refunds_complete and c.as_of >= c.end_at + interval '15 days' then
    (select count(*) from paid p where p.variant = v.variant and p.refunded) end as refunded_orders
from (values ('A'), ('B')) v(variant) cross join config c
order by v.variant;
