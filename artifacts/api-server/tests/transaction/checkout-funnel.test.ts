import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it("deduplicates stages and reconciles only verified, linked orders on a closed cohort", async () => {
  const { PGlite } = await import(/* @vite-ignore */ pathToFileURL(process.env.PGLITE_ENTRY!).href);
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema cron;
      create function cron.schedule(text, text, text) returns bigint language sql as 'select 1::bigint';
      create table public.orders (order_id text primary key, payment_status text, payment_confirmed_at timestamptz);
      grant select on public.orders to service_role;
    `);
    await db.exec(await readFile(new URL("../../../../supabase/migrations/20261127160000_checkout_funnel.sql", import.meta.url), "utf8"));
    await db.exec(`
      insert into public.checkout_funnel_events values
        ('550e8400-e29b-41d4-a716-446655440000', 'netflix', 'cart_view', '2026-11-02 01:00Z'),
        ('550e8400-e29b-41d4-a716-446655440000', 'netflix', 'login_view', '2026-11-02 01:01Z'),
        ('550e8400-e29b-41d4-a716-446655440000', 'netflix', 'customer_info', '2026-11-02 01:02Z'),
        ('550e8400-e29b-41d4-a716-446655440000', 'netflix', 'summary_view', '2026-11-02 01:03Z'),
        ('550e8400-e29b-41d4-a716-446655440001', 'netflix', 'summary_view', '2026-11-02 01:03Z'),
        ('550e8400-e29b-41d4-a716-446655440002', 'netflix', 'cart_view', '2026-11-01 22:55Z'),
        ('550e8400-e29b-41d4-a716-446655440002', 'netflix', 'login_view', '2026-11-01 23:55Z')
      on conflict do nothing;
      insert into public.checkout_funnel_events values
        ('550e8400-e29b-41d4-a716-446655440000', 'netflix', 'cart_view', '2026-11-02 01:05Z')
      on conflict do nothing;
      insert into public.orders values
        ('matched', 'paid', '2026-11-02 01:04Z'), ('other', 'paid', '2026-11-02 04:00Z'),
        ('unpaid', 'unpaid', null), ('outside', 'paid', '2026-11-03 00:00Z');
      insert into public.checkout_funnel_orders values
        ('matched', '550e8400-e29b-41d4-a716-446655440000', array['netflix'], '2026-11-02 01:03Z'),
        ('unpaid', '550e8400-e29b-41d4-a716-446655440001', array['netflix'], '2026-11-02 01:03Z');
      set role service_role;
    `);
    const { rows } = await db.query("select public.checkout_funnel_report('2026-11-01 23:00Z', '2026-11-02 23:00Z') as result");
    expect(rows[0].result).toEqual({ all_paid_orders: 2, tracked_paid_orders: 1, stages: [
      { service: "netflix", stage: "cart_view", reached: 1, continued: 1 },
      { service: "netflix", stage: "customer_info", reached: 1, continued: 1 },
      { service: "netflix", stage: "login_view", reached: 1, continued: 1 },
      { service: "netflix", stage: "summary_view", reached: 2, continued: 1 },
    ] });
    await db.exec("set role anon");
    await expect(db.query("select * from public.checkout_funnel_events")).rejects.toThrow(/permission denied/i);
    await expect(db.query("select public.checkout_funnel_report(now(), now())")).rejects.toThrow(/permission denied/i);
  } finally {
    await db.close();
  }
});
