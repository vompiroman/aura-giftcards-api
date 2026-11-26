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

function activationService(item: any): "spotify" | "crunchyroll" | "snapchat" | null {
  const name = String(item?.name || item?.service || "").toLowerCase();
  if (name.includes("spotify")) return "spotify";
  if (name.includes("crunchyroll")) return "crunchyroll";
  if (name.includes("snapchat")) return "snapchat";
  return null;
}

export async function deliverActivationNotificationsForOrder(
  orderId: string,
  items: unknown,
  revision?: number,
): Promise<ActivationNotificationSummary> {
  const summary: ActivationNotificationSummary = { checked: 0, sent: 0, pending: 0, errors: 0 };
  if (revision === undefined) {
    if (!parseOrderItems(items).some(activationService)) return summary;
    const { data: current, error } = await supabaseAdmin
      .from("orders")
      .select("items, activation_revision")
      .eq("order_id", orderId)
      .eq("payment_status", "paid")
      .eq("status", "pending")
      .maybeSingle();
    if (error) throw error;
    if (!current) return summary;
    items = current.items;
    revision = current.activation_revision;
  }
  const readableItems = adminOrderItems(items);
  let storedItems = parseOrderItems(items);
  let changed = false;

  for (const item of readableItems) {
    const service = activationService(item);
    const credentials = item?.client_credentials;
    if (!service || (service === "snapchat" ? !item?.snapchat_username : !credentials) || item?.client_credentials_notification_sent_at) continue;
    summary.checked += 1;
    const sent = await notifyOperations(
      service === "snapchat"
        ? "Nouvelle commande Snapchat+ payée à activer. Ouvre le panneau administrateur."
        : `Nouveau compte ${service} payé à activer. Ouvre le panneau administrateur.`,
      { orderId, service },
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
    .eq("activation_revision", revision)
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
    .select("order_id, items, activation_revision")
    .eq("payment_status", "paid")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(Math.max(1, Math.min(limit, 100)));
  if (error) throw error;

  for (const order of orders || []) {
    const orderSummary = await deliverActivationNotificationsForOrder(order.order_id, order.items, order.activation_revision);
    summary.checked += orderSummary.checked;
    summary.sent += orderSummary.sent;
    summary.pending += orderSummary.pending;
    summary.errors += orderSummary.errors;
  }

  return summary;
}
