-- SlickPay must be verified server-side before inventory can be assigned.
alter table public.orders
  add column if not exists payment_status text;

update public.orders
set payment_status = case
  when status in ('active', 'completed') then 'paid'
  when status = 'cancelled' then 'failed'
  else coalesce(payment_status, 'unpaid')
end
where payment_status is null
   or (status in ('active', 'completed') and payment_status <> 'paid');

alter table public.orders
  alter column payment_status set default 'unpaid',
  alter column payment_status set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_payment_status_check'
  ) then
    alter table public.orders
      add constraint orders_payment_status_check
      check (payment_status in ('unpaid', 'paid', 'failed'));
  end if;
end
$$;

create unique index if not exists orders_slickpay_invoice_id_uidx
  on public.orders (slickpay_invoice_id)
  where slickpay_invoice_id is not null;

create or replace function public.assign_inventory_for_order(
  p_order_id text,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order orders%rowtype;
  v_service text;
  v_needed int;
  v_assigned_ids uuid[];
  v_result jsonb := '[]'::jsonb;
begin
  select * into v_order
  from public.orders
  where order_id = p_order_id
  for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND: %', p_order_id using errcode = 'P0002';
  end if;

  if v_order.status = 'active' then
    return jsonb_build_object(
      'status', 'already_active',
      'order_id', p_order_id,
      'assigned', coalesce(
        (
          select jsonb_agg(jsonb_build_object('service', i.service, 'inventory_id', i.id))
          from public.inventory i
          where i.assigned_order_id = p_order_id
        ),
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

  for v_service, v_needed in
    select
      lower(regexp_replace(trim(elem->>'name'), '\s.*$', '')) as service,
      sum(greatest(coalesce((elem->>'quantity')::int, 1), 1))::int
    from jsonb_array_elements(v_order.items) as elem
    group by 1
  loop
    v_assigned_ids := array(
      select id
      from public.inventory
      where lower(trim(service)) = v_service
        and is_used = false
        and assigned_order_id is null
      order by created_at, id
      for update skip locked
      limit v_needed
    );

    if coalesce(array_length(v_assigned_ids, 1), 0) <> v_needed then
      raise exception 'OUT_OF_STOCK: service=% besoin=% dispo=%',
        v_service,
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

    v_result := v_result || jsonb_build_array(
      jsonb_build_object(
        'service', v_service,
        'count', v_needed,
        'inventory_ids', to_jsonb(v_assigned_ids)
      )
    );
  end loop;

  update public.orders
  set status = 'active',
      expires_at = p_expires_at,
      activated_at = now()
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
