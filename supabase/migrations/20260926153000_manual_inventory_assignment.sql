begin;

create or replace function public.assign_inventory_manually(
  p_inventory_id uuid,
  p_order_id text,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inventory public.inventory%rowtype;
  v_order public.orders%rowtype;
  v_needed int := 0;
  v_assigned int := 0;
  v_has_manual boolean := false;
begin
  select *
    into v_inventory
    from public.inventory
   where id = p_inventory_id
   for update;

  if not found
     or pg_catalog.lower(pg_catalog.btrim(coalesce(v_inventory.service, ''))) <> 'netflix'
     or coalesce(v_inventory.is_used, false)
     or v_inventory.assigned_order_id is not null then
    return pg_catalog.jsonb_build_object('result', 'inventory_not_available');
  end if;

  select *
    into v_order
    from public.orders
   where order_id = p_order_id
   for update;

  if not found
     or v_order.status <> 'pending'
     or v_order.payment_status <> 'paid' then
    return pg_catalog.jsonb_build_object('result', 'order_not_eligible');
  end if;

  select coalesce(
    sum(greatest(coalesce((elem->>'quantity')::int, 1), 1)),
    0
  )::int
    into v_needed
    from pg_catalog.jsonb_array_elements(coalesce(v_order.items, '[]'::jsonb)) elem
   where pg_catalog.lower(coalesce(elem->>'name', elem->>'service', '')) like '%netflix%';

  if v_needed < 1 then
    return pg_catalog.jsonb_build_object('result', 'order_not_eligible');
  end if;

  select pg_catalog.count(*)::int
    into v_assigned
    from public.inventory i
   where i.assigned_order_id = p_order_id
     and i.is_used = true
     and pg_catalog.lower(pg_catalog.btrim(i.service)) = 'netflix';

  if v_assigned >= v_needed then
    return pg_catalog.jsonb_build_object('result', 'order_already_fulfilled');
  end if;

  update public.inventory
     set is_used = true,
         assigned_order_id = p_order_id,
         assigned_user_id = v_order.assigned_email,
         assigned_at = pg_catalog.now()
   where id = p_inventory_id;

  select exists (
    select 1
      from pg_catalog.jsonb_array_elements(coalesce(v_order.items, '[]'::jsonb)) elem
     where pg_catalog.lower(coalesce(elem->>'name', elem->>'service', '')) like '%spotify%'
        or pg_catalog.lower(coalesce(elem->>'name', elem->>'service', '')) like '%crunchyroll%'
  )
    into v_has_manual;

  if v_has_manual then
    update public.orders
       set status = 'pending'
     where order_id = p_order_id;
  else
    update public.orders
       set status = 'active',
           expires_at = p_expires_at,
           activated_at = coalesce(activated_at, pg_catalog.now())
     where order_id = p_order_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'result', 'assigned',
    'order_id', p_order_id,
    'inventory_id', p_inventory_id,
    'status', case when v_has_manual then 'awaiting_manual_activation' else 'active' end
  );
end;
$$;

revoke all on function public.assign_inventory_manually(uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.assign_inventory_manually(uuid, text, timestamptz)
  to service_role;

commit;
