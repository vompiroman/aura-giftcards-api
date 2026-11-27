import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureDatabase, openPaymentDatabase } from "./postgres";

const boundary = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("../../src/lib/supabase", () => ({
  supabase: boundary,
  supabaseAdmin: boundary,
  supabaseAuth: { auth: { getUser: boundary.getUser } },
}));
vi.mock("../../src/lib/notifyAdmin", () => ({ notifyAdmin: vi.fn() }));
vi.mock("../../src/lib/auditLog", () => ({ appendAuditLog: vi.fn() }));

import app from "../../src/app";

const customer = { id: randomUUID(), email: "customer@example.invalid" };
const partner = { id: randomUUID(), email: "partner@example.invalid" };
const customerSession = { Authorization: "Bearer fixture-customer" };
const partnerSession = { Authorization: "Bearer fixture-partner" };
const items = [{ name: "Netflix Premium 1 mois", quantity: 1 }];
const fixtureWebhook = { "x-webhook-secret": "local-payment-test" };
const invoices = new Map<string, { amount: number; paid: boolean; url: string }>();
const invoicesPath = "/api/v2/users/invoices";
let db: Awaited<ReturnType<typeof openPaymentDatabase>>;

describe("Paiement HTTP et PostgreSQL avec un fournisseur simulé", () => {
  beforeAll(async () => {
    db = await openPaymentDatabase(process.env.PGLITE_ENTRY!);
    const fixture = fixtureDatabase(db);
    boundary.from.mockImplementation(fixture.from);
    boundary.rpc.mockImplementation(fixture.rpc);
    for (const account of [customer, partner]) {
      await db.query("insert into auth.users(id,email,email_confirmed_at) values ($1,$2,now())", [account.id, account.email]);
    }
    for (const profile of ["Aura01", "Aura02"]) {
      await db.query("insert into public.inventory(service, account_email, profile_name, is_used) values ('Netflix','fixture@example.invalid',$1,false)", [profile]);
    }
    await db.query("insert into public.partner_accounts(user_id,partner_status) values ($1,'APPROVED')", [partner.id]);
    await db.exec("grant usage on schema public to service_role; set role service_role");
  }, 25_000);

  afterAll(async () => { await db?.close(); });

  beforeEach(() => {
    vi.stubEnv("PARTNER_PROGRAM_ENABLED", "true");
    vi.stubEnv("SLICKPAY_SANDBOX", "true");
    vi.stubEnv("SLICKPAY_PUBLIC_KEY", "fixture-only");
    vi.stubEnv("SLICKPAY_ACCOUNT_UUID", "");
    vi.stubEnv("SLICKPAY_WEBHOOK_URL", "https://shop.example.invalid/api/webhook");
    vi.stubEnv("WEBHOOK_SECRET", fixtureWebhook["x-webhook-secret"]);
    vi.stubEnv("FRONTEND_URL", "https://shop.example.invalid");
    vi.stubEnv("META_CAPI_ACCESS_TOKEN", "fixture-without-network");
    boundary.getUser.mockImplementation(async token => ({
      data: { user: token === "fixture-customer" ? customer : token === "fixture-partner" ? partner : null },
      error: null,
    }));
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, options?: RequestInit) => {
      const url = new URL(input);
      if (url.origin !== "https://devapi.slick-pay.com" || !url.pathname.startsWith(invoicesPath)) {
        throw new Error("The fixture blocks external network requests");
      }
      if (url.pathname === invoicesPath && options?.method === "POST") {
        const { amount } = JSON.parse(String(options.body));
        const id = randomUUID();
        const invoice = { amount, paid: false, url: `https://slick-pay.com/invoices/${id}` };
        invoices.set(id, invoice);
        return Response.json({ data: { id, url: invoice.url } });
      }
      const id = url.pathname.slice(invoicesPath.length + 1);
      const invoice = invoices.get(id);
      if (!invoice) return new Response("", { status: 404 });
      return Response.json({ data: { id, ...invoice, payment_status: invoice.paid ? "paid" : "pending" } });
    }));
  });
  afterEach(() => { invoices.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("publie la commande payée dans l’espace du bon client et attribue un seul profil", async () => {
    const journey = randomUUID();
    await db.query("insert into public.checkout_funnel_events (journey_id,service,stage) values ($1,'netflix','summary_view')", [journey]);
    const report = async () => (await db.query("select public.checkout_funnel_report(now()-interval '1 day',now()+interval '1 day') as result")).rows[0].result;
    const creation = await request(app).post("/api/create-order").set(customerSession).send({
      items, checkout_journey_id: journey,
      marketing_consent: true, marketing_consent_version: "2026-07-26",
    }).expect(201);
    const orderId = creation.body.order_id;
    expect(creation.body.amount).toBe(600);
    expect(await report()).toMatchObject({ all_paid_orders: 0, tracked_paid_orders: 0, stages: [
      { service: "netflix", stage: "summary_view", reached: 1, continued: 0 },
    ] });
    const invoice = await request(app).post("/api/create-invoice").set(customerSession).send({ order_id: orderId }).expect(200);
    const invoiceId = invoice.body.invoice_id;
    expect(invoices.get(invoiceId)?.amount).toBe(600);
    expect(await report()).toMatchObject({ all_paid_orders: 0, tracked_paid_orders: 0, stages: [
      { service: "netflix", stage: "payment_prepared", reached: 1, continued: 0 },
      { service: "netflix", stage: "summary_view", reached: 1, continued: 1 },
    ] });

    const before = await request(app).get("/api/my-orders").set(customerSession).expect(200);
    expect(before.body.orders).toEqual([]);
    invoices.get(invoiceId)!.paid = true;
    const [receipt, returned] = await Promise.all([
      request(app).post("/api/webhook").set(fixtureWebhook).send({ invoice_id: invoiceId }).expect(200),
      request(app).post("/api/verify-payment").set(customerSession).send({ order_id: orderId }).expect(200),
    ]);
    expect(receipt.body.received).toBe(true);
    expect(returned.body).toMatchObject({ payment_status: "paid" });
    const repeat = await request(app).post("/api/webhook").set(fixtureWebhook).send({ invoice_id: invoiceId }).expect(200);
    expect(repeat.body.idempotent).toBe(true);
    expect(await report()).toMatchObject({ all_paid_orders: 1, tracked_paid_orders: 1, stages: [
      { service: "netflix", stage: "payment_prepared", reached: 1, continued: 1 },
      { service: "netflix", stage: "summary_view", reached: 1, continued: 1 },
    ] });
    expect(vi.mocked(fetch).mock.calls.every(([url]) => new URL(url).origin === "https://devapi.slick-pay.com")).toBe(true);

    const customerOrders = await request(app).get("/api/my-orders").set(customerSession).expect(200);
    expect(customerOrders.body.orders).toHaveLength(1);
    expect(customerOrders.body.orders[0]).toMatchObject({ order_id: orderId, status: "active" });
    expect(customerOrders.body.orders[0].accounts).toHaveLength(1);
    const otherOrders = await request(app).get("/api/my-orders").set(partnerSession).expect(200);
    expect(otherOrders.body.orders).toEqual([]);
  });

  it("crédite une seule recharge et paie une seule commande après un double clic", async () => {
    const deposit = await request(app).post("/api/partner/wallet/deposits").set(partnerSession)
      .send({ amount: 3000, request_key: randomUUID() }).expect(201);
    const invoiceId = new URL(deposit.body.payment_url).pathname.split("/").at(-1)!;
    expect(invoices.get(invoiceId)?.amount).toBe(3000);
    invoices.get(invoiceId)!.paid = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      await request(app).post("/api/webhook").set(fixtureWebhook).send({ invoice_id: invoiceId }).expect(200);
    }

    const checkout = {
      items, payment_method: "wallet", checkout_key: randomUUID(), expected_total: 600, checkout_journey_id: randomUUID(),
    };
    await db.query("insert into public.checkout_funnel_events (journey_id,service,stage) values ($1,'netflix','summary_view')",
      [checkout.checkout_journey_id]);
    const first = await request(app).post("/api/create-order").set(partnerSession).send(checkout).expect(201);
    expect(first.body).toMatchObject({ payment_status: "paid", order_status: "active" });
    const same = await request(app).post("/api/create-order").set(partnerSession).send(checkout).expect(200);
    expect(same.body).toMatchObject({ order_id: first.body.order_id, replayed: true });
    const linked = await db.query("select journey_id from public.checkout_funnel_orders where order_id = $1", [first.body.order_id]);
    expect(linked.rows).toEqual([{ journey_id: checkout.checkout_journey_id }]);
    const report = await db.query("select public.checkout_funnel_report(now()-interval '1 day',now()+interval '1 day') as result");
    expect(report.rows[0].result).toMatchObject({ all_paid_orders: 2, tracked_paid_orders: 2 });

    const account = await db.query("select wallet_balance, has_unlocked_tiers, total_spent from public.partner_accounts where user_id = $1", [partner.id]);
    expect(account.rows[0]).toMatchObject({ wallet_balance: "2400.00", has_unlocked_tiers: true, total_spent: "600.00" });
    const ledger = await db.query("select kind, count(*)::int as entries from public.wallet_transactions where user_id = $1 group by kind order by kind", [partner.id]);
    expect(ledger.rows).toEqual([{ kind: "DEPOSIT", entries: 1 }, { kind: "PURCHASE", entries: 1 }]);
    const orders = await request(app).get("/api/my-orders").set(partnerSession).expect(200);
    expect(orders.body.orders).toHaveLength(1);
    expect(orders.body.orders[0].accounts).toHaveLength(1);
  });

  it("ignore la réservation technique de facture et annule toute insertion mesurée invalide", async () => {
    const draft = {
      order_id: "ORD-fixture-" + randomUUID(), assigned_email: customer.email, customer_user_id: customer.id,
      items, amount: 600, subtotal_amount: 600, discount_amount: 0,
    };
    await expect(db.query("select public.create_measured_checkout_order($1,$2,$3)",
      [JSON.stringify(draft), randomUUID(), ["invalid"]])).rejects.toThrow(/check constraint/i);
    const rolledBack = await db.query("select order_id from public.orders where order_id = $1", [draft.order_id]);
    expect(rolledBack.rows).toEqual([]);

    const orderId = (await request(app).post("/api/create-order").set(customerSession)
      .send({ items, checkout_journey_id: randomUUID() }).expect(201)).body.order_id;
    await db.query("update public.orders set slickpay_invoice_id = 'pending:fixture' where order_id = $1", [orderId]);
    const prepared = await db.query("select payment_prepared_at from public.checkout_funnel_orders where order_id = $1", [orderId]);
    expect(prepared.rows).toEqual([{ payment_prepared_at: null }]);
    const privacy = await db.query("select has_function_privilege('anon','public.create_measured_checkout_order(jsonb,uuid,text[])','EXECUTE') as anon");
    expect(privacy.rows).toEqual([{ anon: false }]);
  });
});
