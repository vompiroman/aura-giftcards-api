create or replace function public.delete_inactive_inventory_item(
  p_inventory_id uuid,
  p_confirm_disconnected boolean default false
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_inventory public.inventory%rowtype;
  v_order public.orders%rowtype;
  v_order_found boolean := false;
  v_assigned boolean;
begin
  select *
    into v_inventory
    from public.inventory
   where id = p_inventory_id
   for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  v_assigned := coalesce(v_inventory.is_used, false)
    or v_inventory.assigned_order_id is not null;

  if v_assigned and not p_confirm_disconnected then
    return jsonb_build_object('result', 'confirmation_required');
  end if;

  if v_inventory.assigned_order_id is not null then
    select *
      into v_order
      from public.orders
     where order_id = v_inventory.assigned_order_id
     for update;
    v_order_found := found;

    if v_order_found
       and lower(coalesce(v_order.status, '')) not in ('completed', 'cancelled')
       and (v_order.expires_at is null or v_order.expires_at > now()) then
      return jsonb_build_object('result', 'assigned_active');
    end if;

    if v_order_found
       and lower(coalesce(v_order.status, '')) not in ('completed', 'cancelled') then
      update public.orders
         set status = 'completed',
             completed_at = coalesce(completed_at, now())
       where order_id = v_order.order_id;
    end if;
  end if;

  delete from public.inventory where id = v_inventory.id;

  return jsonb_build_object(
    'result', 'deleted',
    'previous_order_id', v_inventory.assigned_order_id
  );
end;
$$;

revoke all on function public.delete_inactive_inventory_item(uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.delete_inactive_inventory_item(uuid, boolean)
  to service_role;
