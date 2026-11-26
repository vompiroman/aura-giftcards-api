alter table public.orders
  add column activation_revision integer not null default 0;

create function public.bump_order_activation_revision() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.items is distinct from old.items
    or new.status is distinct from old.status
    or new.payment_status is distinct from old.payment_status
  then
    new.activation_revision := old.activation_revision + 1;
  else
    new.activation_revision := old.activation_revision;
  end if;
  return new;
end;
$$;

revoke execute on function public.bump_order_activation_revision() from public, anon, authenticated;

create trigger order_activation_revision
before update on public.orders
for each row execute function public.bump_order_activation_revision();
