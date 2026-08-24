import { supabaseAdmin as supabase } from "../lib/supabase";
import { notifyAdmin } from "../lib/notifyAdmin";
import { fetchSlickPayInvoice } from "../lib/slickpay";
import { fulfillVerifiedPayment, type PayableOrder } from "../lib/paymentFulfillment";

export interface PaymentReconciliationSummary {
  checked: number;
  confirmed: number;
  pending: number;
  errors: number;
  skipped?: boolean;
}

interface ReconciliationLogger {
  warn?: (details: unknown, message?: string) => void;
  error?: (details: unknown, message?: string) => void;
}

let reconciliationRunning = false;

export async function runPaymentReconciliation(
  log: ReconciliationLogger = console,
): Promise<PaymentReconciliationSummary> {
  if (reconciliationRunning) {
    return { checked: 0, confirmed: 0, pending: 0, errors: 0, skipped: true };
  }

  reconciliationRunning = true;
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: orders, error } = await supabase
      .from("orders")
      .select("order_id, assigned_email, amount, status, payment_status, promo_code_id, slickpay_invoice_id, items, marketing_consent, meta_purchase_sent_at")
      .in("status", ["pending", "cancelled"])
      .in("payment_status", ["unpaid", "failed"])
      .not("slickpay_invoice_id", "is", null)
      .gte("created_at", cutoff)
      .order("created_at", { ascending: true })
      .limit(100);
    if (error) {
      log.error?.({ code: error.code }, "Payment reconciliation query failed");
      throw new Error("PAYMENT_RECONCILIATION_QUERY_FAILED");
    }

    const summary: PaymentReconciliationSummary = { checked: 0, confirmed: 0, pending: 0, errors: 0 };
    for (const order of orders || []) {
      summary.checked += 1;
      try {
        const provider = await fetchSlickPayInvoice(String(order.slickpay_invoice_id), 10_000);
        if (provider.state !== "paid") {
          summary.pending += 1;
          continue;
        }
        if (provider.amount === null || Math.abs(provider.amount - Number(order.amount)) > 0.001) {
          summary.errors += 1;
          await notifyAdmin("Paiement SlickPay détecté mais montant absent ou incohérent pendant le rattrapage.", {
            level: "critical",
            orderId: order.order_id,
            dedupeKey: `reconcile-amount-${order.order_id}`,
          });
          continue;
        }
        await fulfillVerifiedPayment(order as PayableOrder, "slickpay_reconcile");
        summary.confirmed += 1;
      } catch (error) {
        summary.errors += 1;
        log.warn?.({ orderId: order.order_id, errorName: (error as Error)?.name }, "Payment reconciliation item failed");
      }
    }
    return summary;
  } finally {
    reconciliationRunning = false;
  }
}

export function schedulePaymentReconciliationInterval(): void {
  if (process.env.NODE_ENV === "test") return;

  const run = () => {
    runPaymentReconciliation().then((summary) => {
      if (summary.confirmed > 0 || summary.errors > 0) {
        console.info("[payments] Reconciliation completed.", summary);
      }
    }).catch((error) => {
      console.error("[payments] Reconciliation cycle failed.", { errorName: error?.name });
    });
  };

  const startupTimer = setTimeout(run, 15_000);
  startupTimer.unref();
  const interval = setInterval(run, 5 * 60 * 1000);
  interval.unref();
  console.info("[payments] SlickPay reconciliation scheduled every five minutes.");
}
