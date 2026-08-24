begin;

alter table public.orders
  add column if not exists payment_last_checked_at timestamptz,
  add column if not exists payment_provider_status text,
  add column if not exists payment_provider_amount numeric,
  add column if not exists payment_check_count integer not null default 0,
  add column if not exists payment_confirmed_at timestamptz,
  add column if not exists payment_confirmation_source text;

alter table public.orders
  drop constraint if exists orders_payment_provider_status_check;
alter table public.orders
  add constraint orders_payment_provider_status_check
  check (
    payment_provider_status is null
    or payment_provider_status in ('paid', 'unpaid', 'failed', 'pending')
  );

alter table public.orders
  drop constraint if exists orders_payment_check_count_check;
alter table public.orders
  add constraint orders_payment_check_count_check
  check (payment_check_count >= 0);

create or replace function public.observe_slickpay_payment(
  p_order_id text,
  p_invoice_id text,
  p_provider_status text,
  p_verified_amount numeric
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_order public.orders%rowtype;
  v_provider_status text := pg_catalog.lower(pg_catalog.btrim(p_provider_status));
  v_transitioned boolean := false;
  v_result text;
  v_current_status text;
  v_current_payment_status text;
begin
  if v_provider_status not in ('paid', 'unpaid', 'failed', 'pending') then
    raise exception 'INVALID_PROVIDER_STATUS' using errcode = '22023';
  end if;

  select * into v_order
  from public.orders
  where order_id = p_order_id
  for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND: %', p_order_id using errcode = 'P0002';
  end if;

  if p_invoice_id is null
     or pg_catalog.btrim(p_invoice_id) = ''
     or v_order.slickpay_invoice_id is distinct from pg_catalog.btrim(p_invoice_id) then
    raise exception 'INVOICE_MISMATCH: %', p_order_id using errcode = 'P0001';
  end if;

  if v_provider_status = 'paid' and p_verified_amount is null then
    update public.orders
       set payment_last_checked_at = pg_catalog.now(),
           payment_provider_status = v_provider_status,
           payment_provider_amount = null,
           payment_check_count = payment_check_count + 1
     where order_id = p_order_id;
    return jsonb_build_object(
      'result', 'amount_missing',
      'transitioned', false,
      'payment_status', v_order.payment_status,
      'order_status', v_order.status
    );
  end if;

  if v_provider_status = 'paid'
     and pg_catalog.abs(v_order.amount::numeric - p_verified_amount) > 0.001 then
    update public.orders
       set payment_last_checked_at = pg_catalog.now(),
           payment_provider_status = v_provider_status,
           payment_provider_amount = p_verified_amount,
           payment_check_count = payment_check_count + 1
     where order_id = p_order_id;
    return jsonb_build_object(
      'result', 'amount_mismatch',
      'transitioned', false,
      'payment_status', v_order.payment_status,
      'order_status', v_order.status
    );
  end if;

  if v_provider_status = 'paid' then
    v_transitioned := v_order.payment_status <> 'paid';
    update public.orders
       set payment_last_checked_at = pg_catalog.now(),
           payment_provider_status = v_provider_status,
           payment_provider_amount = p_verified_amount,
           payment_check_count = payment_check_count + 1,
           payment_status = 'paid',
           status = case
             when payment_status <> 'paid' and status in ('pending', 'cancelled') then 'pending'
             else status
           end,
           payment_confirmed_at = coalesce(payment_confirmed_at, pg_catalog.now()),
           payment_confirmation_source = coalesce(payment_confirmation_source, 'slickpay_api')
     where order_id = p_order_id;
    v_result := case when v_transitioned then 'confirmed' else 'already_paid' end;
  elsif v_provider_status = 'failed' then
    update public.orders
       set payment_last_checked_at = pg_catalog.now(),
           payment_provider_status = v_provider_status,
           payment_provider_amount = p_verified_amount,
           payment_check_count = payment_check_count + 1,
           payment_status = case when payment_status = 'paid' then payment_status else 'failed' end,
           status = case
             when payment_status = 'paid' then status
             when status = 'pending' then 'cancelled'
             else status
           end
     where order_id = p_order_id;
    v_result := 'failed';
  else
    update public.orders
       set payment_last_checked_at = pg_catalog.now(),
           payment_provider_status = v_provider_status,
           payment_provider_amount = p_verified_amount,
           payment_check_count = payment_check_count + 1
     where order_id = p_order_id;
    v_result := v_provider_status;
  end if;

  select status, payment_status
    into v_current_status, v_current_payment_status
  from public.orders
  where order_id = p_order_id;

  return jsonb_build_object(
    'result', v_result,
    'transitioned', v_transitioned,
    'payment_status', v_current_payment_status,
    'order_status', v_current_status
  );
end;
$$;

revoke all on function public.observe_slickpay_payment(text, text, text, numeric)
  from public, anon, authenticated;
grant execute on function public.observe_slickpay_payment(text, text, text, numeric)
  to service_role;

commit;
