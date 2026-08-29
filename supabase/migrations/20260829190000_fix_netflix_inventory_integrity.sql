begin;

-- Netflix is now delivered through OTP, so the historical account password
-- is intentionally absent for newly stocked profiles.
alter table public.inventory
  alter column account_password drop not null;

update public.inventory
set is_used = false
where is_used is null;

alter table public.inventory
  alter column is_used set default false,
  alter column is_used set not null;

alter table public.inventory
  drop constraint if exists inventory_profile_name_check,
  drop constraint if exists inventory_profile_pin_check;

alter table public.inventory
  add constraint inventory_profile_name_check
    check (profile_name is null or btrim(profile_name) <> ''),
  add constraint inventory_profile_pin_check
    check (profile_pin is null or profile_pin ~ '^[0-9]{4,8}$');

create unique index if not exists inventory_account_profile_unique_idx
  on public.inventory (lower(account_email), lower(profile_name))
  where profile_name is not null;

commit;
