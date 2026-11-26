alter table public.orders add column customer_user_id uuid;

update public.orders
set customer_user_id = partner_user_id
where partner_user_id is not null;

-- Subscription history can outlive an auth account. Keep the original UUID
-- if the account is deleted, so a reused e-mail never inherits old orders.
with owners as (
  select o.order_id, (pg_catalog.array_agg(u.id))[1] as user_id
  from public.orders o
  join auth.users u on pg_catalog.lower(pg_catalog.btrim(u.email)) =
    pg_catalog.lower(pg_catalog.btrim(o.assigned_email))
  where o.customer_user_id is null
    and u.email_confirmed_at is not null
    and u.created_at <= o.created_at at time zone 'UTC'
  group by o.order_id
  having count(*) = 1
)
update public.orders o
set customer_user_id = owners.user_id
from owners
where o.order_id = owners.order_id and o.customer_user_id is null;

create index orders_by_customer_identity on public.orders(customer_user_id,created_at desc)
where customer_user_id is not null;

create function public.set_order_customer_identity() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('role', true) in ('anon','authenticated') then
    if (tg_op = 'INSERT' and new.customer_user_id is not null)
      or (tg_op = 'UPDATE' and new.customer_user_id is distinct from old.customer_user_id) then
      raise exception 'ORDER_OWNER_REQUIRES_SERVER' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' then return new; end if;
  if new.partner_user_id is not null then
    new.customer_user_id := new.partner_user_id;
  elsif new.customer_user_id is null then
    -- Bridge writes from the API version preceding the UUID field.
    select (pg_catalog.array_agg(u.id))[1] into new.customer_user_id
    from auth.users u
    where pg_catalog.lower(pg_catalog.btrim(u.email)) = pg_catalog.lower(pg_catalog.btrim(new.assigned_email))
      and u.email_confirmed_at is not null
    having count(*) = 1;
  end if;
  return new;
end;
$$;

revoke execute on function public.set_order_customer_identity() from public, anon, authenticated;

create trigger order_customer_identity
before insert or update of customer_user_id on public.orders
for each row execute function public.set_order_customer_identity();

-- Use the same immutable owner check during atomic renewal fulfillment.
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
       or pg_catalog.lower(coalesce(elem->>'name', elem->>'service', '')) like '%snapchat%'
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
       or v_order.customer_user_id is null
       or v_renewed_order.customer_user_id is distinct from v_order.customer_user_id
       or v_renewed_order.payment_status <> 'paid'
       or v_renewed_order.status not in ('active', 'completed')
       or (v_needed < 1 and not v_has_manual) then
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
