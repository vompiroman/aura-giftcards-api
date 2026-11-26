create table public.netflix_login_requests (
  mailbox_key text primary key check (mailbox_key ~ '^[a-f0-9]{64}$'),
  request_id uuid not null unique default gen_random_uuid(),
  order_id text not null references public.orders(order_id) on delete cascade,
  inventory_id uuid not null references public.inventory(id) on delete cascade,
  customer_user_id uuid not null,
  started_at timestamptz not null,
  expires_at timestamptz not null
);

alter table public.netflix_login_requests enable row level security;
revoke all on table public.netflix_login_requests from public, anon, authenticated;
grant select, insert, update, delete on table public.netflix_login_requests to service_role;

create function public.begin_netflix_login_request(
  p_mailbox_key text, p_order_id text, p_inventory_id uuid, p_customer_user_id uuid
) returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  current_request public.netflix_login_requests%rowtype;
  started timestamptz := clock_timestamp();
begin
  if not exists (
    select 1 from public.orders o join public.inventory i on i.assigned_order_id = o.order_id
    where o.order_id = p_order_id and o.customer_user_id = p_customer_user_id
      and o.payment_status = 'paid' and o.status not in ('completed','cancelled')
      and (o.expires_at is null or o.expires_at > clock_timestamp() at time zone 'UTC')
      and i.id = p_inventory_id and i.is_used
  ) then return null; end if;

  insert into public.netflix_login_requests(mailbox_key, order_id, inventory_id, customer_user_id, started_at, expires_at)
    values (p_mailbox_key, p_order_id, p_inventory_id, p_customer_user_id, started, started + interval '3 minutes')
  on conflict (mailbox_key) do update
    set request_id = excluded.request_id, order_id = excluded.order_id,
        inventory_id = excluded.inventory_id, customer_user_id = excluded.customer_user_id,
        started_at = excluded.started_at, expires_at = excluded.expires_at
    where netflix_login_requests.expires_at <= started;

  select * into current_request
  from public.netflix_login_requests
  where mailbox_key = p_mailbox_key and order_id = p_order_id
    and inventory_id = p_inventory_id and customer_user_id = p_customer_user_id
    and expires_at > started;

  if not found then return null; end if;
  return jsonb_build_object('request_id', current_request.request_id, 'expires_at', current_request.expires_at);
end;
$$;

revoke execute on function public.begin_netflix_login_request(text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.begin_netflix_login_request(text, text, uuid, uuid) to service_role;

create function public.finish_netflix_login_request(p_request_id uuid, p_user uuid)
returns boolean language sql security invoker set search_path = '' as $$
  with consumed as (
    delete from public.netflix_login_requests n
    using public.orders o, public.inventory i
    where n.request_id = p_request_id and n.customer_user_id = p_user and n.expires_at > clock_timestamp()
      and o.order_id = n.order_id and o.customer_user_id = p_user
      and o.payment_status = 'paid' and o.status not in ('completed','cancelled')
      and (o.expires_at is null or o.expires_at > clock_timestamp() at time zone 'UTC')
      and i.id = n.inventory_id and i.is_used and i.assigned_order_id = o.order_id
    returning 1
  )
  select exists (select 1 from consumed);
$$;

revoke execute on function public.finish_netflix_login_request(uuid, uuid) from public, anon, authenticated;
grant execute on function public.finish_netflix_login_request(uuid, uuid) to service_role;
