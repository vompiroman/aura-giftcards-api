create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create schema if not exists aura_internal;
revoke all on schema aura_internal from public, anon, authenticated;

create table aura_internal.operation_requests (
  request_id bigint primary key,
  requested_at timestamptz not null default now()
);

create function aura_internal.schedule_operations(p_force boolean default false)
returns bigint language plpgsql security invoker set search_path = '' set timezone = 'UTC'
as $$
declare
  has_stock boolean;
  secret_value text;
  dispatched bigint;
begin
  delete from public.netflix_login_requests where expires_at < now() - interval '1 day';
  delete from aura_internal.operation_requests where requested_at < now() - interval '7 days';
  select exists(select 1 from public.inventory
    where lower(btrim(service)) = 'netflix' and not is_used and assigned_order_id is null) into has_stock;

  if not p_force
    and not exists (
      select 1 from public.orders o
      where (o.status = 'pending' and o.payment_status in ('unpaid','failed')
        and (o.slickpay_invoice_id is not null or o.created_at < now() - interval '30 minutes'))
        or (o.status = 'pending' and o.payment_status = 'paid' and (
          (has_stock and (
            select count(*) from public.inventory i
            where i.assigned_order_id = o.order_id and i.is_used and lower(btrim(i.service)) = 'netflix'
          ) < (
            select coalesce(sum(greatest(1, coalesce((item.value->>'quantity')::integer, 1))), 0)
            from jsonb_array_elements(
              case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end
            ) as item(value)
            where coalesce(item.value->>'name', item.value->>'service', '') ilike '%netflix%'
              and (item.value->>'quantity' is null or item.value->>'quantity' ~ '^[0-9]{1,4}$')
          ))
          or exists (
            select 1 from jsonb_array_elements(
              case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end
            ) as item(value)
            where item.value->>'client_credentials_notification_sent_at' is null
              and (item.value ? 'client_credentials_encrypted' or item.value ? 'client_credentials'
                   or item.value ? 'snapchat_username')
          )
        ))
        or (o.payment_status = 'paid' and o.purchase_email_requested_at is not null
          and o.purchase_email_sent_at is null and o.purchase_email_attempts < 6)
    )
    and not exists (
      select 1 from public.wallet_transactions w where w.kind = 'DEPOSIT' and w.status = 'PENDING'
        and (w.provider_invoice_id is not null or w.created_at <= now() - interval '2 minutes')
    )
    and not (has_stock and exists (
      select 1 from public.partner_stock_alerts s join public.partner_accounts a using (user_id)
      where a.partner_status = 'APPROVED' and (s.lease_until is null or s.lease_until <= now())
    ))
    and not exists (
      select 1 from public.orders o
      join public.partner_order_settings settings on settings.order_id = o.order_id and settings.reminders
      join public.partner_accounts a on a.user_id = o.partner_user_id and a.partner_status = 'APPROVED'
      left join public.partner_reminder_deliveries r on r.order_id = o.order_id and r.expires_at = o.expires_at
        and r.days_before = case when o.expires_at <= now() + interval '2 days' then 2 else 7 end
      where o.status = 'active' and o.payment_status = 'paid' and o.expires_at > now()
        and o.expires_at <= now() + interval '7 days'
        and (r.order_id is null or (r.sent_at is null and r.lease_until <= now()))
    ) then
    return null;
  end if;

  select decrypted_secret into secret_value
  from vault.decrypted_secrets where name = 'aura_operations_cron_secret';
  if not found then return null; end if;

  select net.http_post(
    url := 'https://aura-giftcards-api.onrender.com/api/cron/operations',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret_value),
    timeout_milliseconds := 120000
  ) into dispatched;
  insert into aura_internal.operation_requests(request_id) values(dispatched);
  return dispatched;
end;
$$;

revoke execute on function aura_internal.schedule_operations(boolean) from public, anon, authenticated;

select cron.schedule('aura-pending-operations', '*/20 * * * *', $job$
  select aura_internal.schedule_operations();
$job$);
