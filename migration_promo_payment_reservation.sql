begin;

-- Promo usage is consumed only after payment is confirmed. Existing checkout
-- reservations from the first promo rollout are ignored unless their order is
-- paid, so abandoned carts cannot exhaust a code.
create or replace function public.reserve_promo_redemption(
  p_promo_code_id uuid,
  p_order_id text,
  p_client_hash text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_promo promo_codes%rowtype;
  v_total integer;
  v_client integer;
  v_payment_status text;
begin
  select payment_status into v_payment_status
    from public.orders
   where order_id = p_order_id
   for update;
  if v_payment_status is distinct from 'paid' then return false; end if;

  select * into v_promo
    from public.promo_codes
   where id = p_promo_code_id and active = true
   for update;
  if not found then return false; end if;

  select count(*)::integer into v_total
    from public.promo_redemptions r
    join public.orders o on o.order_id = r.order_id
   where r.promo_code_id = p_promo_code_id and o.payment_status = 'paid';
  select count(*)::integer into v_client
    from public.promo_redemptions r
    join public.orders o on o.order_id = r.order_id
   where r.promo_code_id = p_promo_code_id
     and r.client_hash = p_client_hash
     and o.payment_status = 'paid';

  if v_promo.max_uses is not null and v_total >= v_promo.max_uses then return false; end if;
  if v_promo.max_uses_per_client is not null and v_client >= v_promo.max_uses_per_client then return false; end if;

  insert into public.promo_redemptions (promo_code_id, order_id, client_hash)
    values (p_promo_code_id, p_order_id, p_client_hash)
    on conflict (promo_code_id, order_id) do nothing;
  return true;
end;
$$;

revoke all on function public.reserve_promo_redemption(uuid, text, text) from public, anon, authenticated;
grant execute on function public.reserve_promo_redemption(uuid, text, text) to service_role;

commit;
