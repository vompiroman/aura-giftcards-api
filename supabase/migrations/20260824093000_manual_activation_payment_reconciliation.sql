begin;

alter table public.orders
  add column if not exists customer_whatsapp text;

alter table public.orders
  drop constraint if exists orders_customer_whatsapp_length_check;

alter table public.orders
  add constraint orders_customer_whatsapp_length_check
  check (customer_whatsapp is null or length(customer_whatsapp) between 12 and 16);

create index if not exists orders_payment_reconciliation_idx
  on public.orders (created_at)
  where slickpay_invoice_id is not null
    and payment_status in ('unpaid', 'failed')
    and status in ('pending', 'cancelled');

create or replace function public.assign_inventory_for_order(
  p_order_id text,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_order public.orders%rowtype;
  v_needed int;
  v_assigned_ids uuid[];
  v_result jsonb := '[]'::jsonb;
  v_has_manual boolean := false;
begin
  select * into v_order
  from public.orders
  where order_id = p_order_id
  for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND: %', p_order_id using errcode = 'P0002';
  end if;

  if v_order.status in ('active', 'completed') then
    return jsonb_build_object(
      'status', case when v_order.status = 'active' then 'already_active' else 'already_completed' end,
      'order_id', p_order_id,
      'assigned', coalesce(
        (select jsonb_agg(jsonb_build_object('service', i.service, 'inventory_id', i.id))
           from public.inventory i
          where i.assigned_order_id = p_order_id),
        '[]'::jsonb
      )
    );
  end if;

  if v_order.status = 'cancelled' then
    raise exception 'ORDER_CANCELLED: %', p_order_id using errcode = 'P0001';
  end if;

  if v_order.payment_status <> 'paid' then
    raise exception 'PAYMENT_NOT_CONFIRMED: %', p_order_id using errcode = 'P0001';
  end if;

  select exists (
    select 1
    from pg_catalog.jsonb_array_elements(coalesce(v_order.items, '[]'::jsonb)) elem
    where lower(coalesce(elem->>'name', elem->>'service', '')) like '%spotify%'
       or lower(coalesce(elem->>'name', elem->>'service', '')) like '%crunchyroll%'
  ) into v_has_manual;

  select coalesce(sum(greatest(coalesce((elem->>'quantity')::int, 1), 1)), 0)::int
    into v_needed
  from pg_catalog.jsonb_array_elements(coalesce(v_order.items, '[]'::jsonb)) elem
  where lower(coalesce(elem->>'name', elem->>'service', '')) like '%netflix%';

  if v_needed > 0 then
    v_assigned_ids := array(
      select id
      from public.inventory
      where lower(trim(service)) = 'netflix'
        and is_used = false
        and assigned_order_id is null
      order by created_at, id
      for update skip locked
      limit v_needed
    );

    if coalesce(array_length(v_assigned_ids, 1), 0) <> v_needed then
      raise exception 'OUT_OF_STOCK: service=netflix besoin=% dispo=%',
        v_needed,
        coalesce(array_length(v_assigned_ids, 1), 0)
        using errcode = 'P0003';
    end if;

    update public.inventory
       set is_used = true,
           assigned_order_id = p_order_id,
           assigned_user_id = v_order.assigned_email,
           assigned_at = now()
     where id = any(v_assigned_ids);

    v_result := jsonb_build_array(jsonb_build_object(
      'service', 'netflix',
      'count', v_needed,
      'inventory_ids', to_jsonb(v_assigned_ids)
    ));
  end if;

  if v_has_manual then
    update public.orders
       set status = 'pending'
     where order_id = p_order_id;
    return jsonb_build_object(
      'status', 'awaiting_manual_activation',
      'order_id', p_order_id,
      'assigned', v_result
    );
  end if;

  update public.orders
     set status = 'active',
         expires_at = p_expires_at,
         activated_at = coalesce(activated_at, now())
   where order_id = p_order_id;

  return jsonb_build_object(
    'status', 'assigned',
    'order_id', p_order_id,
    'assigned', v_result
  );
end;
$$;

revoke all on function public.assign_inventory_for_order(text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.assign_inventory_for_order(text, timestamptz)
  to service_role;

commit;
