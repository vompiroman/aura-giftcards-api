begin;

with raw_phones as (
  select
    o.id,
    pg_catalog.regexp_replace(u.raw_user_meta_data->>'phone', '[^0-9]', '', 'g') as digits
  from public.orders o
  join auth.users u on pg_catalog.lower(u.email) = pg_catalog.lower(o.assigned_email)
  where o.customer_whatsapp is null
    and u.raw_user_meta_data->>'phone' is not null
), normalized_phones as (
  select
    id,
    case
      when digits ~ '^213[5-7][0-9]{8}$' then '+' || digits
      when digits ~ '^0[5-7][0-9]{8}$' then '+213' || pg_catalog.substr(digits, 2)
      when digits ~ '^[5-7][0-9]{8}$' then '+213' || digits
      else null
    end as whatsapp
  from raw_phones
)
update public.orders o
set customer_whatsapp = n.whatsapp
from normalized_phones n
where o.id = n.id
  and n.whatsapp is not null;

commit;
