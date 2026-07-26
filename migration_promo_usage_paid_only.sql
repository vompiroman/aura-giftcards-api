begin;

create or replace function public.get_promo_usage(
  p_promo_code_id uuid,
  p_client_hash text
)
returns table(total_uses integer, client_uses integer)
language sql
security definer
set search_path = public
as $$
  select
    (select count(*)::integer
       from public.promo_redemptions r
       join public.orders o on o.order_id = r.order_id
      where r.promo_code_id = p_promo_code_id
        and o.payment_status = 'paid') as total_uses,
    (select count(*)::integer
       from public.promo_redemptions r
       join public.orders o on o.order_id = r.order_id
      where r.promo_code_id = p_promo_code_id
        and r.client_hash = p_client_hash
        and o.payment_status = 'paid') as client_uses;
$$;

revoke all on function public.get_promo_usage(uuid, text) from public, anon, authenticated;
grant execute on function public.get_promo_usage(uuid, text) to service_role;

commit;
