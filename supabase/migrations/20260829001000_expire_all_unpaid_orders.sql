begin;

-- Expire atomically both abandoned carts (no SlickPay invoice) and invoices
-- that the provider still reports as unpaid/failed/pending. The caller owns
-- the retention window and currently supplies a 12-hour cutoff.
create or replace function public.expire_unpaid_slickpay_order(
  p_order_id text,
  p_invoice_id text,
  p_cutoff timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_order public.orders%rowtype;
  v_invoice_id text := nullif(pg_catalog.btrim(p_invoice_id), '');
  v_is_local_order boolean;
begin
  if p_cutoff is null then
    raise exception 'CUTOFF_REQUIRED' using errcode = '22023';
  end if;

  select * into v_order
  from public.orders
  where order_id = p_order_id
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- IS DISTINCT FROM safely compares nullable invoice identifiers. An order
  -- without an invoice is eligible only when it still has no invoice while
  -- holding the row lock.
  if v_order.slickpay_invoice_id is distinct from v_invoice_id then
    return jsonb_build_object('result', 'invoice_mismatch');
  end if;

  if v_order.created_at > p_cutoff then
    return jsonb_build_object('result', 'too_new');
  end if;

  if v_order.payment_status = 'paid'
     or v_order.status in ('active', 'completed') then
    return jsonb_build_object('result', 'protected_paid');
  end if;

  if v_order.payment_status not in ('unpaid', 'failed')
     or v_order.status not in ('pending', 'cancelled') then
    return jsonb_build_object('result', 'ineligible');
  end if;

  v_is_local_order := v_invoice_id is null or v_invoice_id like 'pending:%';
  if not v_is_local_order and (
    v_order.payment_provider_status is null
    or v_order.payment_provider_status not in ('unpaid', 'failed', 'pending')
    or v_order.payment_last_checked_at is null
    or v_order.payment_last_checked_at < pg_catalog.now() - interval '5 minutes'
  ) then
    return jsonb_build_object('result', 'stale_observation');
  end if;

  if exists (
    select 1
    from public.inventory
    where assigned_order_id = p_order_id
  ) then
    return jsonb_build_object('result', 'protected_inventory');
  end if;

  delete from public.orders
  where order_id = p_order_id;

  return jsonb_build_object(
    'result', 'deleted',
    'provider_status', coalesce(
      v_order.payment_provider_status,
      case when v_invoice_id is null then 'no_invoice' else 'local_claim' end
    )
  );
end;
$$;

revoke all on function public.expire_unpaid_slickpay_order(text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.expire_unpaid_slickpay_order(text, text, timestamptz)
  to service_role;

commit;
