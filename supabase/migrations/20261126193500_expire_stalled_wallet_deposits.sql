create function public.expire_stalled_wallet_deposits(p_user uuid default null)
returns integer language sql security invoker set search_path = '' as $$
  with expired as (
    update public.wallet_transactions
    set status = 'FAILED', checked_at = now()
    where kind = 'DEPOSIT' and status = 'PENDING'
      and provider_invoice_id is null
      and created_at <= now() - interval '2 minutes'
      and (p_user is null or user_id = p_user)
    returning 1
  )
  select count(*)::integer from expired;
$$;

revoke execute on function public.expire_stalled_wallet_deposits(uuid) from public, anon, authenticated;
grant execute on function public.expire_stalled_wallet_deposits(uuid) to service_role;

create or replace function public.begin_wallet_deposit(p_user uuid, p_key uuid, p_amount numeric)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_account public.partner_accounts%rowtype; v_tx public.wallet_transactions%rowtype;
begin
  if p_key is null or p_amount is null or p_amount < 1 or p_amount > 100000 or round(p_amount,2) <> p_amount then
    raise exception 'WALLET_INVALID_DEPOSIT';
  end if;
  select * into v_account from public.partner_accounts where user_id = p_user for update;
  if v_account.partner_status is distinct from 'APPROVED' then raise exception 'PARTNER_NOT_APPROVED'; end if;

  -- A provider link is only shared with the customer after it is saved.
  -- Reuse an invoice if present, or expire a stuck reservation once the
  -- original provider request can no longer still be active.
  perform public.expire_stalled_wallet_deposits(p_user);
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
end;
$$;
