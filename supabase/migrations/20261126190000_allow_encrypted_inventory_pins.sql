alter table public.inventory
  drop constraint if exists inventory_profile_pin_check;

alter table public.inventory
  add constraint inventory_profile_pin_check check (
    profile_pin is null
    or profile_pin ~ '^[0-9]{4,8}$'
    or (profile_pin like 'enc:v1:{%' and length(profile_pin) <= 256)
  );
