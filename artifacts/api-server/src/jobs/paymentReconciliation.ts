import { supabaseAdmin as supabase } from "../lib/supabase";
import { notifyAdmin } from "../lib/notifyAdmin";
import { fetchSlickPayInvoice } from "../lib/slickpay";
import { fulfillVerifiedPayment, type PayableOrder } from "../lib/paymentFulfillment";
import { observeSlickPayPayment } from "../lib/slickpayObservation";
import { expireUnpaidSlickPayOrder } from "../lib/slickpayExpiration";
import { appendAuditLog } from "../lib/auditLog";

const UNPAID_ORDER_RETENTION_MS = 12 * 60 * 60 * 1000;
const PAYMENT_CANDIDATE_LIMIT = 100;

export interface PaymentReconciliationSummary {
  checked: number;
  confirmed: number;
  pending: number;
  expired: number;
  errors: number;
  error_codes?: Record<string, number>;
  skipped?: boolean;
}

interface ReconciliationLogger {
  warn?: (details: unknown, message?: string) => void;
  error?: (details: unknown, message?: string) => void;
}

let reconciliationRunning = false;

type ReconciliationOrder = PayableOrder & {
  created_at: string;
  slickpay_invoice_id: string | null;
};

const ORDER_COLUMNS = "order_id, assigned_email, amount, status, payment_status, promo_code_id, renewal_order_id, slickpay_invoice_id, items, marketing_consent, meta_purchase_sent_at, created_at";

async function loadPaymentCandidates(expirationCutoff: string): Promise<{
  recent: ReconciliationOrder[];
  stale: ReconciliationOrder[];
}> {
  const baseRecent = supabase
    .from("orders")
    .select(ORDER_COLUMNS)
    .in("status", ["pending", "cancelled"])
    .in("payment_status", ["unpaid", "failed"])
    .not("slickpay_invoice_id", "is", null)
    .gt("created_at", expirationCutoff)
    .order("created_at", { ascending: true })
    .limit(PAYMENT_CANDIDATE_LIMIT);
  const baseStale = supabase
    .from("orders")
    .select(ORDER_COLUMNS)
    .in("status", ["pending", "cancelled"])
    .in("payment_status", ["unpaid", "failed"])
    .lte("created_at", expirationCutoff)
    .order("created_at", { ascending: true })
    .limit(PAYMENT_CANDIDATE_LIMIT);

  const [recentResult, staleResult] = await Promise.all([baseRecent, baseStale]);
  if (recentResult.error || staleResult.error) {
    throw recentResult.error || staleResult.error;
  }
  return {
    recent: (recentResult.data || []) as ReconciliationOrder[],
    stale: (staleResult.data || []) as ReconciliationOrder[],
  };
}

async function recordExpiration(
  order: ReconciliationOrder,
  expirationCutoff: string,
  summary: PaymentReconciliationSummary,
): Promise<void> {
  const expiration = await expireUnpaidSlickPayOrder(
    order.order_id,
    order.slickpay_invoice_id,
    expirationCutoff,
  );
  if (expiration.result === "deleted") {
    summary.expired += 1;
    await appendAuditLog({
      action: "order_auto_expiration",
      targetType: "order",
      targetId: order.order_id,
      details: {
        reason: "unpaid_after_12h",
        provider_status: expiration.provider_status || "unknown",
      },
    });
    return;
  }
  if (["not_found", "protected_paid"].includes(expiration.result)) return;
  if (["too_new", "ineligible"].includes(expiration.result)) {
    summary.pending += 1;
    return;
  }

  summary.errors += 1;
  await notifyAdmin("Suppression automatique d'une commande impayée bloquée par une protection de sécurité.", {
    level: "warning",
    orderId: order.order_id,
    dedupeKey: `payment-expiration-${order.order_id}-${expiration.result}`,
  });
}

async function processPaymentCandidate(
  order: ReconciliationOrder,
  stale: boolean,
  expirationCutoff: string,
  summary: PaymentReconciliationSummary,
  log: ReconciliationLogger,
): Promise<void> {
  summary.checked += 1;
  const invoiceId = order.slickpay_invoice_id;

  // Une commande sans facture externe est un panier abandonné. Une fois les
  // 12 heures écoulées, la fonction SQL la supprime atomiquement uniquement
  // si elle est toujours impayée et sans stock attribué.
  if (!invoiceId) {
    if (stale) await recordExpiration(order, expirationCutoff, summary);
    else summary.pending += 1;
    return;
  }

  if (invoiceId.startsWith("pending:")) {
    if (stale) await recordExpiration(order, expirationCutoff, summary);
    else summary.pending += 1;
    return;
  }

  const provider = await fetchSlickPayInvoice(invoiceId, 10_000);
  const observation = await observeSlickPayPayment(order.order_id, invoiceId, provider);
  if (["amount_missing", "amount_mismatch"].includes(observation.result)) {
    summary.errors += 1;
    const code = observation.result === "amount_missing" ? "SLICKPAY_AMOUNT_MISSING" : "SLICKPAY_AMOUNT_MISMATCH";
    summary.error_codes ||= {};
    summary.error_codes[code] = (summary.error_codes[code] || 0) + 1;
    const fields: Record<string, string> = {};
    const inspect = (value: unknown, path = "response", depth = 0): void => {
      if (depth > 4 || Object.keys(fields).length >= 60) return;
      fields[path] = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      if (path.endsWith(".amount") && typeof value === "string" && value.length <= 40) {
        // Show separators without recording the financial value or other payload data.
        fields[path] += `:${value.replace(/[0-9]/g, "#").replace(/[^#.,\s]/g, "?")}`;
      }
      if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value).slice(0, 25)) {
          if (/^[a-z_0-9]{1,40}$/i.test(key)) inspect(child, `${path}.${key}`, depth + 1);
        }
      }
    };
    inspect(provider.payload);
    log.warn?.({ orderId: order.order_id, code, providerFields: fields }, "SlickPay amount verification blocked");
    await notifyAdmin("Paiement SlickPay détecté mais montant absent ou incohérent pendant le rattrapage.", {
      level: "critical",
      orderId: order.order_id,
      dedupeKey: `reconcile-amount-${order.order_id}`,
    });
    return;
  }
  if (provider.state === "paid") {
    await fulfillVerifiedPayment(order, "slickpay_reconcile", {
      paymentTransitioned: observation.transitioned,
    });
    summary.confirmed += 1;
    return;
  }
  if (stale) {
    await recordExpiration(order, expirationCutoff, summary);
    return;
  }
  summary.pending += 1;
}

export async function runPaymentReconciliation(
  log: ReconciliationLogger = console,
): Promise<PaymentReconciliationSummary> {
  if (reconciliationRunning) {
    return { checked: 0, confirmed: 0, pending: 0, expired: 0, errors: 0, skipped: true };
  }

  reconciliationRunning = true;
  try {
    const expirationCutoff = new Date(Date.now() - UNPAID_ORDER_RETENTION_MS).toISOString();
    let candidates;
    try {
      candidates = await loadPaymentCandidates(expirationCutoff);
    } catch (error) {
      log.error?.({ code: (error as any)?.code }, "Payment reconciliation query failed");
      throw new Error("PAYMENT_RECONCILIATION_QUERY_FAILED");
    }

    const summary: PaymentReconciliationSummary = { checked: 0, confirmed: 0, pending: 0, expired: 0, errors: 0 };
    for (const [orders, stale] of [[candidates.recent, false], [candidates.stale, true]] as const) {
      for (const order of orders) {
        try {
          await processPaymentCandidate(order, stale, expirationCutoff, summary, log);
        } catch (error) {
          summary.errors += 1;
          // Expose only known codes, never response bodies, credentials or
          // arbitrary exception text in the authenticated cron response.
          const message = error instanceof Error ? error.message : "";
          const dbCode = String((error as { code?: unknown })?.code || "");
          const code = /^SLICKPAY_[A-Z0-9_]+$/.test(message)
            ? message
            : /^[0-9A-Z]{5}$/.test(dbCode) ? `DATABASE_${dbCode}` : "PAYMENT_RECONCILIATION_ITEM_FAILED";
          summary.error_codes ||= {};
          summary.error_codes[code] = (summary.error_codes[code] || 0) + 1;
          log.warn?.({ orderId: order.order_id, code }, "Payment reconciliation item failed");
        }
      }
    }
    return summary;
  } finally {
    reconciliationRunning = false;
  }
}

export function schedulePaymentReconciliationInterval(): void {
  if (process.env.NODE_ENV === "test") return;
  if (process.env.USE_EXTERNAL_CRON === "true") {
    console.info("[payments] External reconciliation cron enabled; in-process safety interval also active.");
  }

  const run = () => {
    runPaymentReconciliation().then((summary) => {
      if (summary.confirmed > 0 || summary.expired > 0 || summary.errors > 0) {
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
