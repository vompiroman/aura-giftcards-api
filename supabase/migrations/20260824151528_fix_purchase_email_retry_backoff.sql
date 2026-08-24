begin;

create or replace function public.claim_purchase_email_jobs(p_limit integer default 10)
returns table (
  job_order_id text,
  customer_email text,
  total_amount numeric,
  subtotal_amount numeric,
  discount_amount numeric,
  order_items jsonb,
  ordered_at timestamptz,
  paid_at timestamptz,
  claim_token uuid,
  delivery_attempt integer
)
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
begin
  return query
  with candidates as (
    select o.id
      from public.orders o
     where o.payment_status = 'paid'
       and o.purchase_email_requested_at is not null
       and o.purchase_email_sent_at is null
       and o.purchase_email_attempts < 6
       and (
         o.purchase_email_claimed_at is null
         or o.purchase_email_claimed_at < pg_catalog.now() - interval '15 minutes'
       )
       and (
         o.purchase_email_last_error_at is null
         or o.purchase_email_last_error_at <= pg_catalog.now()
            - pg_catalog.make_interval(
                secs => least(3600, 60 * (2 ^ least(o.purchase_email_attempts, 6)))::integer
              )
       )
     order by o.purchase_email_requested_at asc
     for update skip locked
     limit greatest(1, least(coalesce(p_limit, 10), 25))
  ), claimed as (
    update public.orders o
       set purchase_email_claim_token = extensions.gen_random_uuid(),
           purchase_email_claimed_at = pg_catalog.now(),
           purchase_email_attempts = o.purchase_email_attempts + 1
      from candidates c
     where o.id = c.id
     returning o.*
  )
  select c.order_id,
         c.assigned_email,
         c.amount::numeric,
         coalesce(c.subtotal_amount, c.amount)::numeric,
         coalesce(c.discount_amount, 0)::numeric,
         coalesce(c.items, '[]'::jsonb),
         c.created_at at time zone 'UTC',
         coalesce(c.payment_confirmed_at, c.purchase_email_requested_at),
         c.purchase_email_claim_token,
         c.purchase_email_attempts
    from claimed c;
end;
$$;

create or replace function public.complete_purchase_email_job(
  p_order_id text,
  p_claim_token uuid,
  p_provider_id text
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_updated integer;
begin
  update public.orders
     set purchase_email_sent_at = pg_catalog.now(),
         purchase_email_provider_id = pg_catalog.left(nullif(pg_catalog.btrim(p_provider_id), ''), 200),
         purchase_email_claim_token = null,
         purchase_email_claimed_at = null,
         purchase_email_last_error_at = null,
         purchase_email_last_error_code = null
   where order_id = p_order_id
     and purchase_email_claim_token = p_claim_token
     and purchase_email_sent_at is null;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

create or replace function public.release_purchase_email_job(
  p_order_id text,
  p_claim_token uuid,
  p_error_code text
)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_attempts integer;
begin
  update public.orders
     set purchase_email_claim_token = null,
         purchase_email_claimed_at = null,
         purchase_email_last_error_at = pg_catalog.now(),
         purchase_email_last_error_code = pg_catalog.left(
           coalesce(nullif(pg_catalog.btrim(p_error_code), ''), 'UNKNOWN'),
           100
         )
   where order_id = p_order_id
     and purchase_email_claim_token = p_claim_token
     and purchase_email_sent_at is null
   returning purchase_email_attempts into v_attempts;
  return v_attempts;
end;
$$;

revoke all on function public.claim_purchase_email_jobs(integer)
  from public, anon, authenticated;
revoke all on function public.complete_purchase_email_job(text, uuid, text)
  from public, anon, authenticated;
revoke all on function public.release_purchase_email_job(text, uuid, text)
  from public, anon, authenticated;

grant execute on function public.claim_purchase_email_jobs(integer) to service_role;
grant execute on function public.complete_purchase_email_job(text, uuid, text) to service_role;
grant execute on function public.release_purchase_email_job(text, uuid, text) to service_role;

commit;
