begin;

alter table public.orders
  add column if not exists renewal_order_id text;

alter table public.orders
  drop constraint if exists orders_renewal_order_id_fkey,
  drop constraint if exists orders_renewal_order_not_self_check;

alter table public.orders
  add constraint orders_renewal_order_id_fkey
    foreign key (renewal_order_id)
    references public.orders(order_id)
    on delete set null,
  add constraint orders_renewal_order_not_self_check
    check (renewal_order_id is null or renewal_order_id <> order_id);

create index if not exists orders_renewal_order_id_idx
  on public.orders (renewal_order_id)
  where renewal_order_id is not null;

create or replace function public.assign_inventory_for_order(
  p_order_id text,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_renewed_order public.orders%rowtype;
  v_needed int;
  v_remaining int;
  v_current_ids uuid[] := '{}'::uuid[];
  v_reused_ids uuid[] := '{}'::uuid[];
  v_available_ids uuid[] := '{}'::uuid[];
  v_assignment_ids uuid[] := '{}'::uuid[];
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
    return pg_catalog.jsonb_build_object(
      'status', case when v_order.status = 'active' then 'already_active' else 'already_completed' end,
      'order_id', p_order_id,
      'assigned', coalesce(
        (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('service', i.service, 'inventory_id', i.id))
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
    where pg_catalog.lower(coalesce(elem->>'name', elem->>'service', '')) like '%spotify%'
       or pg_catalog.lower(coalesce(elem->>'name', elem->>'service', '')) like '%crunchyroll%'
  ) into v_has_manual;

  select coalesce(
    pg_catalog.sum(greatest(coalesce((elem->>'quantity')::int, 1), 1)),
    0
  )::int
    into v_needed
  from pg_catalog.jsonb_array_elements(coalesce(v_order.items, '[]'::jsonb)) elem
  where pg_catalog.lower(coalesce(elem->>'name', elem->>'service', '')) like '%netflix%';

  if v_order.renewal_order_id is not null then
    select * into v_renewed_order
    from public.orders
    where order_id = v_order.renewal_order_id
    for update;

    if not found
       or v_renewed_order.order_id = v_order.order_id
       or pg_catalog.lower(pg_catalog.btrim(coalesce(v_renewed_order.assigned_email, '')))
          <> pg_catalog.lower(pg_catalog.btrim(coalesce(v_order.assigned_email, '')))
       or v_renewed_order.payment_status <> 'paid'
       or v_renewed_order.status not in ('active', 'completed')
       or v_needed < 1 then
      raise exception 'RENEWAL_ORDER_INVALID: %', v_order.renewal_order_id using errcode = 'P0001';
    end if;
  end if;

  if v_needed > 0 then
    v_current_ids := array(
      select i.id
      from public.inventory i
      where pg_catalog.lower(pg_catalog.btrim(i.service)) = 'netflix'
        and i.is_used = true
        and i.assigned_order_id = p_order_id
      order by i.created_at, i.id
      for update
    );

    if coalesce(pg_catalog.array_length(v_current_ids, 1), 0) > v_needed then
      raise exception 'TOO_MANY_ASSIGNMENTS: service=netflix besoin=% attribue=%',
        v_needed,
        coalesce(pg_catalog.array_length(v_current_ids, 1), 0)
        using errcode = 'P0001';
    end if;

    v_remaining := v_needed - coalesce(pg_catalog.array_length(v_current_ids, 1), 0);

    if v_remaining > 0 and v_order.renewal_order_id is not null then
      v_reused_ids := array(
        select i.id
        from public.inventory i
        where pg_catalog.lower(pg_catalog.btrim(i.service)) = 'netflix'
          and i.is_used = true
          and i.assigned_order_id = v_order.renewal_order_id
        order by i.created_at, i.id
        for update
        limit v_remaining
      );
      v_remaining := v_remaining - coalesce(pg_catalog.array_length(v_reused_ids, 1), 0);
    end if;

    if v_remaining > 0 then
      v_available_ids := array(
        select i.id
        from public.inventory i
        where pg_catalog.lower(pg_catalog.btrim(i.service)) = 'netflix'
          and i.is_used = false
          and i.assigned_order_id is null
        order by i.created_at, i.id
        for update skip locked
        limit v_remaining
      );
      v_remaining := v_remaining - coalesce(pg_catalog.array_length(v_available_ids, 1), 0);
    end if;

    if v_remaining <> 0 then
      raise exception 'OUT_OF_STOCK: service=netflix besoin=% manque=%',
        v_needed,
        v_remaining
        using errcode = 'P0003';
    end if;

    v_assignment_ids := v_current_ids || v_reused_ids || v_available_ids;

    if coalesce(pg_catalog.array_length(v_reused_ids, 1), 0)
       + coalesce(pg_catalog.array_length(v_available_ids, 1), 0) > 0 then
      update public.inventory
         set is_used = true,
             assigned_order_id = p_order_id,
             assigned_user_id = v_order.assigned_email,
             assigned_at = pg_catalog.now()
       where id = any(v_reused_ids || v_available_ids);
    end if;

    v_result := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'service', 'netflix',
      'count', v_needed,
      'inventory_ids', pg_catalog.to_jsonb(v_assignment_ids),
      'reused_inventory_ids', pg_catalog.to_jsonb(v_reused_ids)
    ));
  end if;

  if v_order.renewal_order_id is not null then
    update public.orders
       set status = 'completed',
           completed_at = coalesce(completed_at, pg_catalog.now())
     where order_id = v_order.renewal_order_id;
  end if;

  if v_has_manual then
    update public.orders
       set status = 'pending',
           expires_at = case when renewal_order_id is not null then p_expires_at else expires_at end
     where order_id = p_order_id;
    return pg_catalog.jsonb_build_object(
      'status', 'awaiting_manual_activation',
      'order_id', p_order_id,
      'renewed_from_order_id', v_order.renewal_order_id,
      'assigned', v_result
    );
  end if;

  update public.orders
     set status = 'active',
         expires_at = p_expires_at,
         activated_at = coalesce(activated_at, pg_catalog.now())
   where order_id = p_order_id;

  return pg_catalog.jsonb_build_object(
    'status', 'assigned',
    'order_id', p_order_id,
    'renewed_from_order_id', v_order.renewal_order_id,
    'assigned', v_result
  );
end;
$$;

revoke all on function public.assign_inventory_for_order(text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.assign_inventory_for_order(text, timestamptz)
  to service_role;

commit;
