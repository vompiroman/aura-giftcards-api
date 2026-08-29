import { supabaseAdmin as supabase } from "../lib/supabase";
import { fulfillVerifiedPayment, type PayableOrder } from "../lib/paymentFulfillment";

const WAITING_ORDER_LIMIT = 100;
const ORDER_COLUMNS = "order_id, assigned_email, amount, status, payment_status, promo_code_id, items, marketing_consent, meta_purchase_sent_at, created_at";

interface StockFulfillmentLogger {
  warn?: (details: unknown, message?: string) => void;
}

export interface StockFulfillmentSummary {
  checked: number;
  fulfilled: number;
  awaiting_manual_activation: number;
  waiting_for_stock: number;
  errors: number;
}

function netflixQuantity(items: unknown): number {
  if (!Array.isArray(items)) return 0;
  return items.reduce((total, item: any) => {
    const name = String(item?.name || item?.service || "").trim().toLowerCase();
    if (!name.includes("netflix")) return total;
    const quantity = Number(item?.quantity);
    return total + (Number.isInteger(quantity) && quantity > 0 ? quantity : 1);
  }, 0);
}

async function assignedNetflixQuantity(orderId: string): Promise<number> {
  const { count, error } = await supabase
    .from("inventory")
    .select("id", { count: "exact", head: true })
    .eq("assigned_order_id", orderId)
    .eq("is_used", true)
    .ilike("service", "%netflix%");
  if (error) throw error;
  return count || 0;
}

export async function fulfillPaidOrdersWaitingForStock(
  log: StockFulfillmentLogger = console,
): Promise<StockFulfillmentSummary> {
  const summary: StockFulfillmentSummary = {
    checked: 0,
    fulfilled: 0,
    awaiting_manual_activation: 0,
    waiting_for_stock: 0,
    errors: 0,
  };

  const { data, error } = await supabase
    .from("orders")
    .select(ORDER_COLUMNS)
    .eq("status", "pending")
    .eq("payment_status", "paid")
    .order("created_at", { ascending: true })
    .limit(WAITING_ORDER_LIMIT);
  if (error) throw error;

  for (const order of (data || []) as Array<PayableOrder & { created_at: string }>) {
    const required = netflixQuantity(order.items);
    if (required === 0) continue;

    try {
      const assigned = await assignedNetflixQuantity(order.order_id);
      if (assigned >= required) continue;
      summary.checked += 1;

      const result = await fulfillVerifiedPayment(order, "slickpay_reconcile", {
        paymentTransitioned: false,
      });
      if (result.waiting_for_stock) {
        summary.waiting_for_stock += 1;
        // Preserve FIFO fairness: do not give a later order stock that is
        // insufficient for the oldest paid order still waiting.
        break;
      }
      if (result.awaiting_manual_activation) {
        summary.awaiting_manual_activation += 1;
      } else if (result.order_status === "active") {
        summary.fulfilled += 1;
      }
    } catch (error) {
      summary.errors += 1;
      log.warn?.({ orderId: order.order_id, errorName: (error as Error)?.name }, "Waiting stock fulfillment failed");
    }
  }

  return summary;
}
