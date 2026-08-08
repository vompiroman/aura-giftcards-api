-- Prevent concurrent requests from creating an unlimited number of unpaid
-- orders for the same customer. The advisory lock is scoped to the current
-- transaction and keyed by normalized customer email.
begin;

create or replace function public.enforce_pending_unpaid_order_limit()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_pending integer;
begin
  if new.status = 'pending' and new.payment_status = 'unpaid' then
    perform pg_advisory_xact_lock(
      hashtextextended(lower(coalesce(new.assigned_email, '')), 0)
    );

    delete from public.orders
    where lower(assigned_email) = lower(new.assigned_email)
      and status = 'pending'
      and payment_status = 'unpaid'
      and created_at < now() - interval '30 minutes';

    select count(*)
      into current_pending
      from public.orders
     where lower(assigned_email) = lower(new.assigned_email)
       and status = 'pending'
       and payment_status = 'unpaid';

    if current_pending >= 3 then
      raise exception using
        errcode = 'P0001',
        message = 'PENDING_ORDER_LIMIT';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_pending_unpaid_order_limit() from public, anon, authenticated;
grant execute on function public.enforce_pending_unpaid_order_limit() to service_role;

drop trigger if exists orders_pending_unpaid_limit_trigger on public.orders;
create trigger orders_pending_unpaid_limit_trigger
before insert on public.orders
for each row
execute function public.enforce_pending_unpaid_order_limit();

commit;
