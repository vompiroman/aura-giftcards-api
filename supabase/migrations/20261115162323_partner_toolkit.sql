begin;

alter table public.partner_order_settings add column resale_price numeric(14,2) check (resale_price >= 0);

create table public.partner_support_tickets (
  id uuid primary key default gen_random_uuid(),
  order_id text not null references public.orders(order_id) on delete restrict,
  user_id uuid not null references public.partner_accounts(user_id) on delete restrict,
  message text not null check (char_length(message) between 10 and 1500),
  status text not null default 'OPEN' check (status in ('OPEN','IN_PROGRESS','RESOLVED')),
  reply text check (char_length(reply) <= 1500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index partner_ticket_open_per_order on public.partner_support_tickets(order_id) where status <> 'RESOLVED';
create index partner_ticket_queue on public.partner_support_tickets(status,created_at desc,id desc);
create index partner_ticket_history on public.partner_support_tickets(user_id,created_at desc,id desc);

create table public.partner_stock_alerts (
  user_id uuid primary key references public.partner_accounts(user_id) on delete cascade,
  subscription_id uuid not null default gen_random_uuid(),
  language text not null check (language in ('fr','en','ar')),
  subscribed_at timestamptz not null default now(),
  lease_until timestamptz,
  claim_id uuid
);
alter table public.partner_support_tickets enable row level security;
alter table public.partner_stock_alerts enable row level security;
revoke all on public.partner_support_tickets, public.partner_stock_alerts from public, anon, authenticated;
grant select, insert, update on public.partner_support_tickets to service_role;
grant select, insert, update, delete on public.partner_stock_alerts to service_role;

create function public.save_partner_resale(p_user uuid,p_order text,p_resale numeric)
returns boolean language sql security invoker set search_path = ''
as $$
  with changed as (
    insert into public.partner_order_settings(order_id,resale_price)
      select order_id,p_resale from public.orders
      where order_id=p_order and partner_user_id=p_user and payment_status='paid'
    on conflict (order_id) do update set resale_price=excluded.resale_price
    returning order_id
  ) select exists(select 1 from changed);
$$;

create function public.open_partner_ticket(p_user uuid,p_order text,p_message text)
returns uuid language sql security invoker set search_path = ''
as $$
  insert into public.partner_support_tickets(order_id,user_id,message)
    select order_id,p_user,p_message from public.orders where order_id=p_order and partner_user_id=p_user
  returning id;
$$;

create function public.partner_order_margin(p_user uuid,p_order text) returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select jsonb_build_object('cost',o.amount,'resale_price',s.resale_price,'gross_margin',s.resale_price-o.amount)
  from public.orders o left join public.partner_order_settings s using(order_id)
  where o.order_id=p_order and o.partner_user_id=p_user and o.payment_status='paid';
$$;

create function public.partner_toolkit(p_user uuid) returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select jsonb_build_object(
    'subscribed',exists(select 1 from public.partner_stock_alerts where user_id=p_user),
    'onboarding_complete',exists(select 1 from public.orders
      where partner_user_id=p_user and payment_status='paid' and status in ('active','expired','completed'))
  );
$$;

create function public.subscribe_partner_stock(p_user uuid,p_language text)
returns boolean language sql security invoker set search_path = ''
as $$
  with added as (
    insert into public.partner_stock_alerts(user_id,language)
    select p_user,p_language
    where (public.partner_netflix_stock()->>'profiles')::bigint = 0
    on conflict (user_id) do nothing returning user_id
  ) select exists(select 1 from added)
    or exists(select 1 from public.partner_stock_alerts where user_id=p_user);
$$;

create function public.claim_partner_stock_alerts(p_limit integer)
returns table(user_id uuid,subscription_id uuid,claim_id uuid,language text)
language sql security invoker set search_path = ''
as $$
  with eligible as (
    select s.user_id from public.partner_stock_alerts s
    join public.partner_accounts a on a.user_id=s.user_id and a.partner_status='APPROVED'
    where (s.lease_until is null or s.lease_until <= now())
      and (public.partner_netflix_stock()->>'profiles')::bigint > 0
    order by s.subscribed_at,s.user_id limit least(greatest(p_limit,1),25) for update of s skip locked
  )
  update public.partner_stock_alerts s set claim_id=gen_random_uuid(),lease_until=now()+interval '10 minutes'
  from eligible where s.user_id=eligible.user_id
  returning s.user_id,s.subscription_id,s.claim_id,s.language;
$$;

revoke all on function public.save_partner_resale(uuid,text,numeric),public.open_partner_ticket(uuid,text,text),
  public.partner_order_margin(uuid,text),public.partner_toolkit(uuid),public.subscribe_partner_stock(uuid,text),public.claim_partner_stock_alerts(integer)
  from public, anon, authenticated;
grant execute on function public.save_partner_resale(uuid,text,numeric),public.open_partner_ticket(uuid,text,text),
  public.partner_order_margin(uuid,text),public.partner_toolkit(uuid),public.subscribe_partner_stock(uuid,text),public.claim_partner_stock_alerts(integer)
  to service_role;

commit;
