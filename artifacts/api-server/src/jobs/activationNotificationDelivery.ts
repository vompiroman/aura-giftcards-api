import { appendAuditLog } from "../lib/auditLog";
import { notifyOperations } from "../lib/notifyOperations";
import {
  adminOrderItems,
  markClientCredentialsNotified,
  parseOrderItems,
} from "../lib/orderItems";
import { supabaseAdmin } from "../lib/supabase";

export interface ActivationNotificationSummary {
  checked: number;
  sent: number;
  pending: number;
  errors: number;
}

function activationService(item: any): "spotify" | "crunchyroll" | null {
  const name = String(item?.name || item?.service || "").toLowerCase();
  if (name.includes("spotify")) return "spotify";
  if (name.includes("crunchyroll")) return "crunchyroll";
  return null;
}

export async function deliverActivationNotificationsForOrder(
  orderId: string,
  items: unknown,
): Promise<ActivationNotificationSummary> {
  const summary: ActivationNotificationSummary = { checked: 0, sent: 0, pending: 0, errors: 0 };
  const readableItems = adminOrderItems(items);
  let storedItems = parseOrderItems(items);
  let changed = false;

  for (const item of readableItems) {
    const service = activationService(item);
    const credentials = item?.client_credentials;
    if (!service || !credentials || item?.client_credentials_notification_sent_at) continue;
    summary.checked += 1;
    const sent = await notifyOperations(
      `Nouveau compte ${service} payé à activer. Les identifiants temporaires sont également disponibles dans le panneau administrateur sécurisé.`,
      { orderId, service, credentials },
    );
    if (!sent) {
      summary.pending += 1;
      summary.errors += 1;
      continue;
    }
    storedItems = markClientCredentialsNotified(storedItems, service);
    summary.sent += 1;
    changed = true;
  }

  if (!changed) return summary;
  const { data: updated, error: updateError } = await supabaseAdmin
    .from("orders")
    .update({ items: storedItems })
    .eq("order_id", orderId)
    .eq("payment_status", "paid")
    .eq("status", "pending")
    .select("order_id");
  if (updateError || !updated?.length) {
    summary.errors += 1;
    summary.pending += 1;
    return summary;
  }
  void appendAuditLog({
    action: "activation_credentials_discord_delivered",
    targetType: "order",
    targetId: orderId,
    details: { source: "payment_or_retry" },
  });
  return summary;
}

export async function deliverPendingActivationNotifications(limit = 100): Promise<ActivationNotificationSummary> {
  const summary: ActivationNotificationSummary = { checked: 0, sent: 0, pending: 0, errors: 0 };
  const { data: orders, error } = await supabaseAdmin
    .from("orders")
    .select("order_id, items")
    .eq("payment_status", "paid")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(Math.max(1, Math.min(limit, 100)));
  if (error) throw error;

  for (const order of orders || []) {
    const orderSummary = await deliverActivationNotificationsForOrder(order.order_id, order.items);
    summary.checked += orderSummary.checked;
    summary.sent += orderSummary.sent;
    summary.pending += orderSummary.pending;
    summary.errors += orderSummary.errors;
  }

  return summary;
}
