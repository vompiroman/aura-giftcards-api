begin;

create table public.checkout_guest_login_ab_events (
  journey_id uuid not null,
  kind text not null check (kind in ('guest_login_exposure', 'guest_login_auth_error', 'guest_login_checkout_error')),
  variant text not null check (variant in ('A', 'B')),
  occurred_at timestamptz not null,
  journey_expires_at timestamptz not null,
  primary key (journey_id, kind),
  check (occurred_at < journey_expires_at and journey_expires_at <= occurred_at + interval '24 hours')
);

create index checkout_guest_login_ab_time
  on public.checkout_guest_login_ab_events (occurred_at);

alter table public.checkout_guest_login_ab_events enable row level security;
revoke all on public.checkout_guest_login_ab_events from public, anon, authenticated;
grant select, insert on public.checkout_guest_login_ab_events to service_role;

select cron.schedule('aura-checkout-guest-login-ab-retention', '28 3 * * *', $job$
  delete from public.checkout_guest_login_ab_events where occurred_at < now() - interval '45 days';
$job$);

commit;
