begin;

create table public.partner_tiers (
  tier text primary key,
  threshold numeric(14,2) not null unique check (threshold >= 0),
  discount_percent integer not null check (discount_percent between 0 and 100)
);
insert into public.partner_tiers values ('STARTER',0,0), ('BRONZE',2000,5), ('SILVER',5000,10), ('GOLD',10000,15);

create table public.partner_accounts (
  user_id uuid primary key references auth.users(id) on delete restrict,
  partner_status text not null default 'NONE' check (partner_status in ('NONE','PENDING','APPROVED','REJECTED')),
  wallet_balance numeric(14,2) not null default 0 check (wallet_balance >= 0),
  has_unlocked_tiers boolean not null default false,
  total_spent numeric(14,2) not null default 0 check (total_spent >= 0),
  partner_tier text not null default 'LOCKED' check (partner_tier in ('LOCKED','STARTER','BRONZE','SILVER','GOLD')),
  check (has_unlocked_tiers = (partner_tier <> 'LOCKED')),
  created_at timestamptz not null default now()
);

create table public.partner_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.partner_accounts(user_id) on delete restrict,
  email text not null,
  monthly_volume text not null check (monthly_volume in ('UNDER_5000','5000_15000','15000_50000','OVER_50000')),
  sales_channel text not null check (sales_channel in ('WEB','MESSAGING','SOCIAL','PHYSICAL','OTHER')),
  profile text not null check (profile in ('INDEPENDENT','BUSINESS','CREATOR')),
  products text not null check (char_length(btrim(products)) between 1 and 250),
  quick_contact text not null check (char_length(btrim(quick_contact)) between 3 and 120),
  additional_info text check (char_length(additional_info) <= 1000),
  status text not null check (status in ('PENDING','APPROVED','REJECTED')),
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  admin_note text check (char_length(admin_note) <= 1000)
);
create unique index partner_applications_one_pending on public.partner_applications(user_id) where status = 'PENDING';
create index partner_applications_user_history on public.partner_applications(user_id, submitted_at desc);
create index partner_applications_admin_queue on public.partner_applications(status, submitted_at desc, id);

-- Registration with email confirmation has no authenticated browser session.
-- Keep only the answers, keyed to a newly created Auth user, until login.
create table public.partner_signup_drafts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  answers jsonb not null check (jsonb_typeof(answers)='object'),
  created_at timestamptz not null default now()
);
alter table public.partner_signup_drafts enable row level security;
revoke all on public.partner_signup_drafts from public, anon, authenticated;
grant select,insert,delete on public.partner_signup_drafts to service_role;

alter table public.orders
  add column partner_user_id uuid references public.partner_accounts(user_id) on delete restrict,
  add column partner_checkout_key uuid,
  add column partner_wallet_paid boolean not null default false,
  add column partner_discount_percent integer not null default 0 check (partner_discount_percent between 0 and 100),
  add column partner_wallet_refunded_at timestamptz;
alter table public.orders add constraint orders_partner_wallet_shape check (
  (not partner_wallet_paid or (partner_user_id is not null and partner_checkout_key is not null and slickpay_invoice_id is null))
  and (partner_wallet_refunded_at is null or (partner_wallet_paid and status='cancelled' and payment_status='failed'))
);
create unique index partner_order_checkout_once on public.orders(partner_user_id, partner_checkout_key)
  where partner_checkout_key is not null;
create index partner_orders_by_user on public.orders(partner_user_id) where partner_user_id is not null;

create table public.wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.partner_accounts(user_id) on delete restrict,
  kind text not null check (kind in ('DEPOSIT','PURCHASE','REFUND')),
  status text not null check (status in ('PENDING','CONFIRMED','FAILED')),
  amount numeric(14,2) not null check (amount > 0),
  balance_after numeric(14,2) check (balance_after >= 0),
  currency text not null default 'DZD' check (currency = 'DZD'),
  order_id text references public.orders(order_id) on delete restrict,
  request_key uuid,
  provider_invoice_id text unique,
  payment_url text,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  check ((kind = 'DEPOSIT') = (order_id is null)),
  check ((status = 'CONFIRMED') = (balance_after is not null and confirmed_at is not null)),
  check (kind = 'DEPOSIT' or (status = 'CONFIRMED' and provider_invoice_id is null and request_key is null))
);
create index wallet_history on public.wallet_transactions(user_id, created_at desc, id desc);
create unique index wallet_order_once on public.wallet_transactions(kind, order_id) where order_id is not null;
create unique index wallet_deposit_once on public.wallet_transactions(user_id, request_key) where request_key is not null;
create index wallet_pending_provider_checks on public.wallet_transactions(checked_at nulls first, created_at)
  where kind = 'DEPOSIT' and status <> 'CONFIRMED' and provider_invoice_id is not null;

create table public.partner_order_spend (
  order_id text primary key references public.orders(order_id) on delete restrict,
  user_id uuid not null references public.partner_accounts(user_id) on delete restrict,
  amount numeric(14,2) not null check (amount >= 0),
  reversed_at timestamptz
);
create index partner_order_spend_user on public.partner_order_spend(user_id);

alter table public.partner_tiers enable row level security;
alter table public.partner_accounts enable row level security;
alter table public.partner_applications enable row level security;
alter table public.wallet_transactions enable row level security;
alter table public.partner_order_spend enable row level security;
revoke all on public.partner_tiers, public.partner_accounts, public.partner_applications,
  public.wallet_transactions, public.partner_order_spend from public, anon, authenticated;
grant select on public.partner_tiers to service_role;
grant select, insert, update on public.partner_accounts, public.partner_applications, public.wallet_transactions,
  public.partner_order_spend to service_role;

create function public.partner_min_unlock_deposit() returns integer
language sql immutable security invoker set search_path = '' as $$ select 3000 $$;

create function public.partner_tier_for(p_unlocked boolean, p_spent numeric)
returns text language sql stable security invoker set search_path = '' as $$
  select case when p_unlocked then
    (select tier from public.partner_tiers where threshold <= p_spent order by threshold desc limit 1)
    else 'LOCKED' end
$$;

create function public.submit_partner_application(p_user uuid, p_email text, p_answers jsonb, p_auto boolean)
returns text language plpgsql security invoker set search_path = '' as $$
declare
  v_status text;
begin
  insert into public.partner_accounts(user_id) values(p_user) on conflict do nothing;
  select partner_status into v_status from public.partner_accounts where user_id = p_user for update;
  if v_status in ('PENDING','APPROVED') then raise exception 'PARTNER_ALREADY_APPLIED'; end if;
  v_status := case when p_auto then 'APPROVED' else 'PENDING' end;
  insert into public.partner_applications(user_id,email,monthly_volume,sales_channel,profile,products,
      quick_contact,additional_info,status,reviewed_at)
  values(p_user,p_email,p_answers->>'monthly_volume',p_answers->>'sales_channel',p_answers->>'profile',
    btrim(p_answers->>'products'),btrim(p_answers->>'quick_contact'),nullif(btrim(p_answers->>'additional_info'),''),
    v_status,case when p_auto then now() end);
  update public.partner_accounts set partner_status = v_status where user_id = p_user;
  delete from public.partner_signup_drafts where user_id = p_user;
  return v_status;
end $$;

create function public.review_partner_application(p_id uuid, p_admin uuid, p_status text, p_note text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_user uuid;
begin
  if p_status is null or p_status not in ('APPROVED','REJECTED') then raise exception 'PARTNER_INVALID_DECISION'; end if;
  select user_id into v_user from public.partner_applications where id = p_id;
  if not found then return false; end if;
  perform 1 from public.partner_accounts where user_id = v_user for update;
  update public.partner_applications set status = p_status, reviewed_by = p_admin, reviewed_at = now(),
    admin_note = nullif(btrim(p_note),'') where id = p_id and status = 'PENDING';
  if not found then return false; end if;
  update public.partner_accounts set partner_status = p_status where user_id = v_user;
  return true;
end $$;

-- Create one pending deposit per client request key. An upstream invoice may only
-- be attached to this row by a server process holding its creation claim.
create function public.begin_wallet_deposit(p_user uuid, p_key uuid, p_amount numeric)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_account public.partner_accounts%rowtype; v_tx public.wallet_transactions%rowtype;
begin
  if p_key is null or p_amount is null or p_amount < 1 or p_amount > 100000 or round(p_amount,2) <> p_amount then
    raise exception 'WALLET_INVALID_DEPOSIT';
  end if;
  select * into v_account from public.partner_accounts where user_id = p_user for update;
  if v_account.partner_status is distinct from 'APPROVED' then raise exception 'PARTNER_NOT_APPROVED'; end if;
  select * into v_tx from public.wallet_transactions where user_id=p_user and request_key=p_key;
  if found then
    if v_tx.amount <> p_amount then raise exception 'WALLET_REQUEST_CONFLICT'; end if;
    return jsonb_build_object('id',v_tx.id,'status',v_tx.status,'payment_url',v_tx.payment_url,'create_invoice',false);
  end if;
  if (select count(*) from public.wallet_transactions where user_id=p_user and kind='DEPOSIT'
      and status='PENDING' and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'WALLET_DEPOSIT_LIMIT';
  end if;
  insert into public.wallet_transactions(user_id,kind,status,amount,request_key)
  values(p_user,'DEPOSIT','PENDING',p_amount,p_key) returning * into v_tx;
  return jsonb_build_object('id',v_tx.id,'status',v_tx.status,'create_invoice',true);
end $$;

create function public.observe_wallet_deposit(p_id uuid, p_invoice text, p_provider_state text, p_amount numeric)
returns text language plpgsql security invoker set search_path = '' as $$
declare v_tx public.wallet_transactions%rowtype; v_balance numeric;
begin
  select * into v_tx from public.wallet_transactions where id=p_id and kind='DEPOSIT' for update;
  if not found or v_tx.provider_invoice_id is null or v_tx.provider_invoice_id is distinct from p_invoice then
    raise exception 'WALLET_INVOICE_MISMATCH';
  end if;
  if v_tx.status='CONFIRMED' then return 'CONFIRMED'; end if;
  update public.wallet_transactions set checked_at=now() where id=p_id;
  if p_provider_state='failed' then
    update public.wallet_transactions set status='FAILED' where id=p_id;
    return 'FAILED';
  end if;
  if p_provider_state is distinct from 'paid' then return v_tx.status; end if;
  if p_amount is distinct from v_tx.amount then return 'AMOUNT_MISMATCH'; end if;
  -- The entire credit and the immutable unlock occur in this transaction.
  update public.partner_accounts
    set wallet_balance=wallet_balance+v_tx.amount,
        has_unlocked_tiers=has_unlocked_tiers or v_tx.amount >= public.partner_min_unlock_deposit(),
        partner_tier=public.partner_tier_for(has_unlocked_tiers or v_tx.amount >= public.partner_min_unlock_deposit(), total_spent)
    where user_id=v_tx.user_id returning wallet_balance into v_balance;
  update public.wallet_transactions set status='CONFIRMED', confirmed_at=now(), balance_after=v_balance where id=p_id;
  return 'CONFIRMED';
end $$;

-- The paid transition, including ordinary SlickPay and retry paths, credits
-- spend once in the same transaction and never counts wallet deposits.
create function public.record_partner_order_spend() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.partner_user_id is null or new.payment_status is distinct from 'paid' then return new; end if;
  insert into public.partner_order_spend(order_id,user_id,amount) values(new.order_id,new.partner_user_id,new.amount)
    on conflict (order_id) do nothing;
  if found then
    update public.partner_accounts
      set total_spent=total_spent+new.amount,
          partner_tier=public.partner_tier_for(has_unlocked_tiers,total_spent+new.amount)
      where user_id=new.partner_user_id;
  end if;
  return new;
end $$;
create trigger orders_record_partner_spend after insert or update of payment_status on public.orders
  for each row execute function public.record_partner_order_spend();

-- The invoker is the existing trusted backend; only it supplies the subtotal
-- derived from the catalog and the validated promo / renewal metadata.
create function public.create_partner_order(p_user uuid, p_key uuid, p_order jsonb, p_wallet boolean,
  p_expected numeric, p_promo_client_hash text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_account public.partner_accounts%rowtype;
  v_existing public.orders%rowtype;
  v_row public.orders%rowtype := jsonb_populate_record(null::public.orders,p_order);
  v_percent integer;
  v_partner_discount numeric;
  v_balance numeric;
begin
  if p_key is null or p_expected is null then raise exception 'PARTNER_QUOTE_REQUIRED'; end if;
  select * into v_account from public.partner_accounts where user_id=p_user for update;
  if v_account.partner_status is distinct from 'APPROVED' then raise exception 'PARTNER_NOT_APPROVED'; end if;
  select * into v_existing from public.orders where partner_user_id=p_user and partner_checkout_key=p_key;
  if found then
    if v_existing.partner_wallet_paid is distinct from p_wallet or v_existing.amount is distinct from p_expected
      or v_existing.subtotal_amount is distinct from v_row.subtotal_amount
      or v_existing.renewal_order_id is distinct from v_row.renewal_order_id
      or (select jsonb_agg(jsonb_build_array(i->>'name',i->>'quantity',i->>'snapchat_username')) from jsonb_array_elements(v_existing.items::jsonb) i)
         is distinct from
         (select jsonb_agg(jsonb_build_array(i->>'name',i->>'quantity',i->>'snapchat_username')) from jsonb_array_elements(v_row.items::jsonb) i)
      then raise exception 'PARTNER_REQUEST_CONFLICT'; end if;
    return jsonb_build_object('order_id',v_existing.order_id,'amount',v_existing.amount,
      'subtotal',v_existing.subtotal_amount,'discount',v_existing.discount_amount,
      'payment_status',v_existing.payment_status,'order_status',v_existing.status,'replayed',true);
  end if;
  if v_row.subtotal_amount is null or v_row.subtotal_amount <= 0 or v_row.discount_amount is null
     or v_row.discount_amount < 0 or v_row.discount_amount > v_row.subtotal_amount then
    raise exception 'PARTNER_INVALID_SUBTOTAL';
  end if;
  select coalesce(max(discount_percent),0) into v_percent
    from public.partner_tiers where tier=public.partner_tier_for(v_account.has_unlocked_tiers,v_account.total_spent);
  v_partner_discount := round(v_row.subtotal_amount::numeric*v_percent/100,2);
  -- Existing offers and partner prices do not stack. Use the greater reduction.
  if v_partner_discount > 0 and v_partner_discount >= v_row.discount_amount then
    v_row.discount_amount := v_partner_discount;
    v_row.promo_code_id := null;
  else
    v_percent := 0;
  end if;
  v_row.amount := v_row.subtotal_amount-v_row.discount_amount;
  if v_row.amount is distinct from p_expected then raise exception 'PARTNER_QUOTE_CHANGED'; end if;
  if not p_wallet and v_row.amount = 0 then raise exception 'PARTNER_USE_WALLET'; end if;
  if p_wallet and v_account.wallet_balance < v_row.amount then raise exception 'WALLET_INSUFFICIENT_BALANCE'; end if;

  insert into public.orders(order_id,assigned_email,items,amount,subtotal_amount,discount_amount,promo_code_id,
      renewal_order_id,status,payment_status,marketing_consent,marketing_consent_at,consent_version,customer_whatsapp,
      partner_user_id,partner_checkout_key,partner_wallet_paid,partner_discount_percent,payment_confirmed_at,
      payment_confirmation_source)
  values(v_row.order_id,v_row.assigned_email,v_row.items,v_row.amount,v_row.subtotal_amount,v_row.discount_amount,
    v_row.promo_code_id,v_row.renewal_order_id,'pending',case when p_wallet then 'paid' else 'unpaid' end,
    v_row.marketing_consent,v_row.marketing_consent_at,v_row.consent_version,v_row.customer_whatsapp,
    p_user,p_key,p_wallet,v_percent,case when p_wallet then now() end,case when p_wallet then 'partner_wallet' end);

  if p_wallet then
    if v_row.promo_code_id is not null and not coalesce(public.reserve_promo_redemption(
      v_row.promo_code_id,v_row.order_id,p_promo_client_hash),false) then raise exception 'PARTNER_PROMO_UNAVAILABLE'; end if;
    if v_row.amount > 0 then
      update public.partner_accounts set wallet_balance=wallet_balance-v_row.amount where user_id=p_user
        returning wallet_balance into v_balance;
      insert into public.wallet_transactions(user_id,kind,status,amount,balance_after,order_id,confirmed_at)
        values(p_user,'PURCHASE','CONFIRMED',v_row.amount,v_balance,v_row.order_id,now());
    end if;
  end if;
  return jsonb_build_object('order_id',v_row.order_id,'amount',v_row.amount,'subtotal',v_row.subtotal_amount,
    'discount',v_row.discount_amount,'payment_status',case when p_wallet then 'paid' else 'unpaid' end,
    'order_status','pending','replayed',false);
end $$;

-- Refund remaining paid orders that have not been handed to the customer.
-- The unpaid status uses the existing failed/cancelled lifecycle; the dedicated
-- timestamp and ledger distinguish this operation from provider payment failure.
create function public.refund_partner_wallet_order(p_order text) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare v_order public.orders%rowtype; v_balance numeric;
begin
  select * into v_order from public.orders where order_id=p_order for update;
  if not found or not v_order.partner_wallet_paid then raise exception 'WALLET_REFUND_NOT_ELIGIBLE'; end if;
  if v_order.partner_wallet_refunded_at is not null then return false; end if;
  if v_order.payment_status<>'paid' or v_order.status<>'pending'
    or exists(select 1 from public.inventory where assigned_order_id=p_order and is_used=true)
    then raise exception 'WALLET_REFUND_NOT_ELIGIBLE'; end if;
  update public.orders set status='cancelled',payment_status='failed',partner_wallet_refunded_at=now() where order_id=p_order;
  update public.partner_order_spend set reversed_at=now() where order_id=p_order and reversed_at is null;
  if not found then raise exception 'WALLET_SPEND_NOT_FOUND'; end if;
  update public.partner_accounts
    set wallet_balance=wallet_balance+v_order.amount, total_spent=total_spent-v_order.amount,
        partner_tier=public.partner_tier_for(has_unlocked_tiers,total_spent-v_order.amount)
    where user_id=v_order.partner_user_id returning wallet_balance into v_balance;
  if v_order.amount>0 then
    insert into public.wallet_transactions(user_id,kind,status,amount,balance_after,order_id,confirmed_at)
    values(v_order.partner_user_id,'REFUND','CONFIRMED',v_order.amount,v_balance,p_order,now());
  end if;
  return true;
end $$;

create function public.guard_refunded_wallet_order() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if current_user in ('anon','authenticated') then
    if new.partner_user_id is not null or new.partner_checkout_key is not null
       or new.partner_wallet_paid or new.partner_discount_percent <> 0
       or new.partner_wallet_refunded_at is not null then
      raise exception 'PARTNER_ORDER_REQUIRES_SERVER' using errcode='42501';
    end if;
    if tg_op='UPDATE' then
      if old.partner_user_id is not null then raise exception 'PARTNER_ORDER_REQUIRES_SERVER' using errcode='42501'; end if;
    end if;
  end if;
  if tg_op='INSERT' then return new; end if;
  if old.partner_wallet_refunded_at is not null and (
    new.status is distinct from 'cancelled' or new.payment_status is distinct from 'failed'
    or new.partner_wallet_refunded_at is distinct from old.partner_wallet_refunded_at
  ) then raise exception 'WALLET_ORDER_REFUNDED'; end if;
  return new;
end $$;
create trigger orders_guard_refunded_wallet before insert or update on public.orders
  for each row execute function public.guard_refunded_wallet_order();

revoke all on function public.partner_min_unlock_deposit(), public.partner_tier_for(boolean,numeric),
  public.submit_partner_application(uuid,text,jsonb,boolean), public.review_partner_application(uuid,uuid,text,text),
  public.begin_wallet_deposit(uuid,uuid,numeric), public.observe_wallet_deposit(uuid,text,text,numeric),
  public.record_partner_order_spend(), public.create_partner_order(uuid,uuid,jsonb,boolean,numeric,text),
  public.refund_partner_wallet_order(text), public.guard_refunded_wallet_order() from public, anon, authenticated;
grant execute on function public.partner_min_unlock_deposit(), public.partner_tier_for(boolean,numeric),
  public.submit_partner_application(uuid,text,jsonb,boolean), public.review_partner_application(uuid,uuid,text,text),
  public.begin_wallet_deposit(uuid,uuid,numeric), public.observe_wallet_deposit(uuid,text,text,numeric),
  public.record_partner_order_spend(), public.create_partner_order(uuid,uuid,jsonb,boolean,numeric,text),
  public.refund_partner_wallet_order(text), public.guard_refunded_wallet_order() to service_role;

commit;
