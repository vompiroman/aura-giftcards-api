import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it("counts each exposure once and leaves unreconciled refunds unknown", async () => {
  const { PGlite } = await import(/* @vite-ignore */ pathToFileURL(process.env.PGLITE_ENTRY!).href);
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema cron;
      create function cron.schedule(text, text, text) returns bigint language sql as 'select 1::bigint';
      create table public.checkout_funnel_events (journey_id uuid, stage text, service text, recorded_at timestamptz);
      create table public.checkout_funnel_orders (journey_id uuid, order_id text, payment_prepared_at timestamptz);
      create table public.orders (order_id text primary key, payment_confirmation_source text,
        payment_confirmed_at timestamptz, partner_wallet_refunded_at timestamptz);
    `);
    await db.exec(await readFile(new URL("../../../../supabase/migrations/20261128140000_checkout_guest_login_ab.sql", import.meta.url), "utf8"));
    const a = "050e8400-e29b-41d4-a716-446655440000", b = "f50e8400-e29b-41d4-a716-446655440000";
    await db.exec(`
      set role service_role;
      insert into public.checkout_guest_login_ab_events values
        ('${a}', 'guest_login_exposure', 'A', '2026-11-30 01:00Z', '2026-12-01 00:00Z'),
        ('${b}', 'guest_login_exposure', 'B', '2026-11-30 01:00Z', '2026-12-01 00:00Z'),
        ('${b}', 'guest_login_checkout_error', 'B', '2026-11-30 02:00Z', '2026-12-01 00:00Z');
      insert into public.checkout_guest_login_ab_events values
        ('${b}', 'guest_login_exposure', 'B', '2026-11-30 03:00Z', '2026-12-01 00:00Z')
        on conflict (journey_id,kind) do nothing;
      reset role;
      insert into public.checkout_funnel_events values
        ('${a}', 'customer_info', 'netflix', '2026-11-30 00:59Z'),
        ('${a}', 'customer_info', 'spotify', '2026-12-01 00:00Z'),
        ('${b}', 'customer_info', 'netflix', '2026-11-30 01:01Z'),
        ('${b}', 'customer_info', 'spotify', '2026-11-30 01:01Z'),
        ('${b}', 'summary_view', 'spotify', '2026-11-30 01:02Z');
      insert into public.checkout_funnel_orders values
        ('${b}', 'card', '2026-11-30 01:03Z'), ('${b}', 'wallet', '2026-11-30 01:03Z'),
        ('${b}', 'manual', '2026-11-30 01:03Z');
      insert into public.orders values
        ('card', 'slickpay_api', '2026-11-30 01:04Z', null),
        ('wallet', 'partner_wallet', '2026-11-30 01:04Z', '2026-12-01 00:00Z'),
        ('manual', 'admin_manual', '2026-11-30 01:04Z', null);
    `);
    const report = (await readFile(new URL("../../docs/checkout-guest-login-ab-report.sql", import.meta.url), "utf8"))
      .replace("null::timestamptz as start_at", "'2026-11-30 00:00Z'::timestamptz as start_at");
    const premature = await db.query(report.replace("now() as as_of", "'2026-12-01 01:00Z'::timestamptz as as_of"));
    expect(premature.rows[1]).toMatchObject({ exposed: 1, customer_info: null, refunds_closed: false, refunded_orders: null });
    const closed = report.replace("now() as as_of", "'2027-01-12 01:00Z'::timestamptz as as_of");
    const { rows } = await db.query(closed);
    expect(rows[0]).toMatchObject({ variant: "A", exposed: 1, mature: 1, customer_info: 0 });
    expect(rows[1]).toMatchObject({ variant: "B", exposed: 1, customer_info: 1, summary_view: 1,
      paid_journeys: 1, checkout_errors: 1, mature_paid_orders: 2, refunded_orders: null });
    const reconciled = await db.query(closed.replace("false as card_refunds_complete", "true as card_refunds_complete")
      .replace("select null::text, null::timestamptz where false", "values ('card', '2026-12-02 01:00Z'::timestamptz)"));
    expect(reconciled.rows[1]).toMatchObject({ refunds_closed: true, refunded_orders: 2 });
    await db.exec("set role anon");
    await expect(db.query("select * from public.checkout_guest_login_ab_events")).rejects.toThrow(/permission denied/i);
  } finally {
    await db.close();
  }
});
