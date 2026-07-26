-- Apply this migration in Supabase before deploying the backend version that
-- reads and writes these columns. It is additive and preserves existing orders
-- as non-consenting.
begin;

alter table public.orders
  add column if not exists marketing_consent boolean not null default false,
  add column if not exists marketing_consent_at timestamptz,
  add column if not exists consent_version text,
  add column if not exists meta_purchase_sent_at timestamptz;

alter table public.orders
  drop constraint if exists orders_marketing_consent_details_check;

alter table public.orders
  add constraint orders_marketing_consent_details_check
  check (
    (marketing_consent = true and marketing_consent_at is not null and consent_version is not null)
    or
    (marketing_consent = false and marketing_consent_at is null and consent_version is null)
  );

create index if not exists orders_meta_purchase_pending_idx
  on public.orders (created_at)
  where payment_status = 'paid'
    and marketing_consent = true
    and meta_purchase_sent_at is null;

commit;
