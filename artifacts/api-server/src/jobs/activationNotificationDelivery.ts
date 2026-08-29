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
    const readableItems = adminOrderItems(order.items);
    let storedItems = parseOrderItems(order.items);
    let changed = false;

    for (const item of readableItems) {
      const service = activationService(item);
      const credentials = item?.client_credentials;
      if (!service || !credentials || item?.client_credentials_notification_sent_at) continue;
      summary.checked += 1;
      const sent = await notifyOperations(
        `Rattrapage automatique : nouveau compte ${service} à activer. Les identifiants temporaires sont également disponibles dans le panneau administrateur sécurisé.`,
        { orderId: order.order_id, service, credentials },
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

    if (!changed) continue;
    const { data: updated, error: updateError } = await supabaseAdmin
      .from("orders")
      .update({ items: storedItems })
      .eq("order_id", order.order_id)
      .eq("payment_status", "paid")
      .eq("status", "pending")
      .select("order_id");
    if (updateError || !updated?.length) {
      summary.errors += 1;
      summary.pending += 1;
      continue;
    }
    void appendAuditLog({
      action: "activation_credentials_discord_delivered",
      targetType: "order",
      targetId: order.order_id,
      details: { source: "retry_job" },
    });
  }

  return summary;
}
