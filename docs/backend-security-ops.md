# Backend security operations

## Required migrations

Run these in Supabase SQL Editor, in order, before deploying code that reads
the new columns/tables:

1. `migration_meta_marketing_consent.sql`
2. `migration_security_ops.sql`
3. `migration_promo_payment_reservation.sql`

Confirm each transaction succeeds before the next one. The stock allocator
remains the only allocation path; it locks the order and inventory rows inside
one database transaction.

## Render variables

Keep the existing payment and webhook secrets. Add these optional controls:

```text
PAYMENT_ALERT_THRESHOLD=3
PAYMENT_ALERT_COOLDOWN_MS=300000
```

`DISCORD_ADMIN_WEBHOOK_URL` receives security, payment, stock and reminder
alerts. `DISCORD_WEBHOOK_URL` remains the operational channel for Spotify and
Crunchyroll activation requests.

The repeated-payment failure counter is intentionally bounded in-memory state:
it deduplicates bursts per Render instance and resets on restart. For
cross-instance durability, add a persistent `payment_alert_state` table/RPC
before claiming globally-once alert delivery; this patch does not claim that
property.

## Limits

- login: 10 attempts / 15 minutes
- invoice creation: 15 / minute
- payment verification: 20 / minute
- client credential submission: 6 / 10 minutes
- authenticated order reads: 60 / minute
- credential/Netflix OTP reads: 30 / 10 minutes

All limits return a generic `429` response and do not reveal whether an
account or order exists.

## Audit and promotions

Audit rows are private and contain only allowlisted metadata; passwords,
streaming credentials, bearer tokens and cookies are removed recursively.
Promotion codes are stored as SHA-256 hashes, with server-side date, service,
discount and usage checks. The checkout amount is recalculated on the server.
