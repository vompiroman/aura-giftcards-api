begin;

alter table public.partner_accounts add column saved_basket jsonb not null default '[]'
  check (jsonb_typeof(saved_basket) = 'array');
create table public.partner_order_settings (
  order_id text primary key references public.orders(order_id) on delete cascade,
  client_reference text check (char_length(client_reference) <= 80),
  reminders boolean not null default false,
  language text not null default 'fr' check (language in ('fr','en','ar'))
);
alter table public.partner_order_settings enable row level security;
revoke all on public.partner_order_settings from public, anon, authenticated;
grant select, insert, update on public.partner_order_settings to service_role;

create index partner_orders_activity on public.orders(partner_user_id, created_at desc, order_id desc)
  where partner_user_id is not null;
create index partner_orders_expiring on public.orders(expires_at)
  where partner_user_id is not null and status = 'active' and payment_status = 'paid';

create table public.partner_reminder_deliveries (
  order_id text not null references public.orders(order_id) on delete cascade,
  expires_at timestamptz not null,
  days_before integer not null check (days_before in (2,7)),
  claim_id uuid not null,
  lease_until timestamptz not null,
  sent_at timestamptz,
  primary key (order_id, expires_at, days_before)
);
alter table public.partner_reminder_deliveries enable row level security;
revoke all on public.partner_reminder_deliveries from public, anon, authenticated;
grant select, insert, update on public.partner_reminder_deliveries to service_role;

create function public.partner_netflix_stock() returns jsonb
  language sql stable security invoker set search_path = ''
as $$
  select jsonb_build_object('profiles', count(*), 'accounts', count(distinct lower(trim(account_email))))
  from public.inventory
  where lower(service) = 'netflix' and not is_used and assigned_order_id is null;
$$;

create function public.partner_order_page(p_user uuid,p_service text,p_status text,p_offset integer)
returns table (order_id text, status text, payment_status text, items jsonb, amount numeric,
  created_at timestamptz, expires_at timestamptz, partner_client_reference text, partner_reminders boolean)
language sql stable security invoker set search_path = '' set timezone = 'UTC'
as $$
  select o.order_id, o.status, o.payment_status, o.items, o.amount, o.created_at::timestamptz, o.expires_at::timestamptz,
    settings.client_reference, coalesce(settings.reminders,false)
  from public.orders o
  left join public.partner_order_settings settings on settings.order_id=o.order_id
  where o.partner_user_id = p_user
    and (p_service is null or exists (
      select 1 from jsonb_array_elements(case when jsonb_typeof(o.items)='array' then o.items else '[]'::jsonb end) item
      where lower(coalesce(item->>'name',item->>'service','')) like p_service || '%'
    ))
    and case p_status
      when 'pending' then o.status='pending' and o.payment_status='paid'
      when 'unpaid' then o.payment_status='unpaid' and o.status <> 'cancelled'
      when 'active' then o.status='active' and o.payment_status='paid' and (o.expires_at is null or o.expires_at > now())
      when 'expiring' then o.status='active' and o.payment_status='paid' and o.expires_at > now()
        and o.expires_at <= now() + interval '7 days'
      when 'expired' then o.status='expired' or (o.status='active' and o.expires_at <= now())
      when 'cancelled' then o.status='cancelled'
      else true
    end
  order by o.created_at desc,o.order_id desc
  limit 21 offset greatest(p_offset,0);
$$;

create function public.save_partner_order_settings(p_user uuid,p_order text,p_reference text,p_reminders boolean,p_language text)
returns boolean language sql security invoker set search_path = ''
as $$
  with saved as (
    insert into public.partner_order_settings (order_id,client_reference,reminders,language)
      select o.order_id,p_reference,p_reminders,p_language from public.orders o
      where o.order_id=p_order and o.partner_user_id=p_user
    on conflict (order_id) do update set client_reference=excluded.client_reference,
      reminders=excluded.reminders,language=excluded.language
    returning order_id
  )
  select exists(select 1 from saved);
$$;

create function public.partner_monthly_summary(p_user uuid,p_from timestamptz,p_to timestamptz)
returns jsonb language sql stable security invoker set search_path = '' set timezone = 'UTC'
as $$
  with orders as (
    select count(*) as purchases, coalesce(sum(amount),0) as spent, coalesce(sum(discount_amount),0) as savings
    from public.orders where partner_user_id = p_user and payment_status = 'paid'
      and ((payment_confirmed_at >= p_from and payment_confirmed_at < p_to)
        or (payment_confirmed_at is null and created_at >= p_from and created_at < p_to))
  ), wallet as (
    select coalesce(sum(amount) filter (where kind='DEPOSIT'),0) as deposits,
      coalesce(sum(amount) filter (where kind='PURCHASE'),0) as wallet_purchases,
      coalesce(sum(amount) filter (where kind='REFUND'),0) as refunds
    from public.wallet_transactions where user_id=p_user and status='CONFIRMED'
      and confirmed_at >= p_from and confirmed_at < p_to
  )
  select to_jsonb(orders) || to_jsonb(wallet) from orders cross join wallet;
$$;

create index partner_paid_activity on public.orders(partner_user_id, payment_confirmed_at, order_id)
  where partner_user_id is not null and payment_status='paid';
create index partner_wallet_confirmed on public.wallet_transactions(user_id, confirmed_at, id)
  where status='CONFIRMED';

create function public.partner_monthly_entries(p_user uuid,p_from timestamptz,p_to timestamptz,p_offset integer)
returns table(entry_id text, occurred_at timestamptz, kind text, order_id text, amount numeric,
  discount numeric, balance_after numeric, client_reference text)
language sql stable security invoker set search_path = '' set timezone = 'UTC'
as $$
  select * from (
    select 'order:' || o.order_id as entry_id, coalesce(o.payment_confirmed_at,o.created_at::timestamptz) as occurred_at,
      'ORDER'::text as kind,o.order_id,o.amount,o.discount_amount as discount, null::numeric as balance_after,
      settings.client_reference
    from public.orders o left join public.partner_order_settings settings on settings.order_id=o.order_id
    where o.partner_user_id=p_user and o.payment_status='paid'
      and ((o.payment_confirmed_at >= p_from and o.payment_confirmed_at < p_to)
        or (o.payment_confirmed_at is null and o.created_at >= p_from and o.created_at < p_to))
    union all
    select w.id::text,w.confirmed_at,w.kind,w.order_id,w.amount,null,w.balance_after,null
    from public.wallet_transactions w where w.user_id=p_user and w.status='CONFIRMED'
      and w.confirmed_at >= p_from and w.confirmed_at < p_to
  ) entries order by occurred_at,entry_id limit 500 offset greatest(p_offset,0);
$$;

create function public.claim_partner_reminders(p_limit integer)
returns table (order_id text, expires_at timestamptz, days_before integer, claim_id uuid,
  email text, language text)
language sql security invoker set search_path = '' set timezone = 'UTC'
as $$
  with due as (
    select o.order_id, o.expires_at::timestamptz as expires_at, o.assigned_email, s.language,
      case when o.expires_at <= now() + interval '2 days' then 2 else 7 end as days_before
    from public.orders o
    join public.partner_accounts a on a.user_id = o.partner_user_id and a.partner_status='APPROVED'
    join public.partner_order_settings s on s.order_id=o.order_id and s.reminders
    where o.status='active' and o.payment_status='paid'
      and o.assigned_email is not null and o.expires_at > now() and o.expires_at <= now() + interval '7 days'
    order by o.expires_at, o.order_id
  ), ready as (
    select d.* from due d
    left join public.partner_reminder_deliveries r using(order_id,expires_at,days_before)
    where r.order_id is null or (r.sent_at is null and r.lease_until <= now())
    order by d.expires_at, d.order_id
    limit least(greatest(p_limit,1),25)
  ), claims as (
    insert into public.partner_reminder_deliveries as deliveries (order_id,expires_at,days_before,claim_id,lease_until)
      select r.order_id,r.expires_at,r.days_before,gen_random_uuid(),now()+interval '10 minutes' from ready r
    on conflict on constraint partner_reminder_deliveries_pkey do update
      set claim_id=excluded.claim_id, lease_until=excluded.lease_until
      where deliveries.sent_at is null and deliveries.lease_until <= now()
    returning deliveries.order_id,deliveries.expires_at,deliveries.days_before,deliveries.claim_id
  )
  select c.order_id,c.expires_at,c.days_before,c.claim_id,d.assigned_email,d.language
  from claims c join ready d using(order_id,expires_at,days_before);
$$;

revoke all on function public.partner_netflix_stock(), public.partner_order_page(uuid,text,text,integer),
  public.partner_monthly_summary(uuid,timestamptz,timestamptz), public.partner_monthly_entries(uuid,timestamptz,timestamptz,integer),
  public.claim_partner_reminders(integer), public.save_partner_order_settings(uuid,text,text,boolean,text)
  from public, anon, authenticated;
grant execute on function public.partner_netflix_stock(), public.partner_order_page(uuid,text,text,integer),
  public.partner_monthly_summary(uuid,timestamptz,timestamptz), public.partner_monthly_entries(uuid,timestamptz,timestamptz,integer),
  public.claim_partner_reminders(integer), public.save_partner_order_settings(uuid,text,text,boolean,text) to service_role;

commit;
