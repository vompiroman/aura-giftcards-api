import { supabaseAdmin } from "./supabase";
import { notifyAdmin } from "./notifyAdmin";
import { sendMetaPurchase } from "./metaConversions";
import { appendAuditLog } from "./auditLog";
import { recordPaymentFailure, resetPaymentFailure } from "./paymentAlerts";
import { clientPromoHash } from "./promos";
import { expiresAtFromItems } from "./payments";

export interface PayableOrder {
  order_id: string;
  assigned_email?: string | null;
  status: string;
  payment_status: string;
  promo_code_id?: string | null;
  items: any;
  amount: number;
  marketing_consent?: boolean | null;
  meta_purchase_sent_at?: string | null;
}

export interface FulfillmentResult {
  payment_status: "paid";
  order_status: "pending" | "active" | "completed";
  expires_at?: string;
  waiting_for_stock?: boolean;
  awaiting_manual_activation?: boolean;
  promo_unavailable?: boolean;
  idempotent?: boolean;
}

export async function fulfillVerifiedPayment(
  order: PayableOrder,
  source: "slickpay_return" | "slickpay_webhook" | "slickpay_reconcile" | "admin_manual",
): Promise<FulfillmentResult> {
  if (["active", "completed"].includes(order.status) && order.payment_status === "paid") {
    return { payment_status: "paid", order_status: order.status as "active" | "completed", idempotent: true };
  }

  const wasAlreadyPaid = order.payment_status === "paid";
  if (!wasAlreadyPaid) {
    const { data: transitioned, error: transitionError } = await supabaseAdmin
      .from("orders")
      .update({ payment_status: "paid", status: "pending" })
      .eq("order_id", order.order_id)
      .in("payment_status", ["unpaid", "failed"])
      .in("status", ["pending", "cancelled"])
      .select("order_id");
    if (transitionError) throw transitionError;
    if (!transitioned?.length) {
      const { data: current, error: currentError } = await supabaseAdmin
        .from("orders")
        .select("status, payment_status")
        .eq("order_id", order.order_id)
        .single();
      if (currentError || current?.payment_status !== "paid") throw currentError || new Error("PAYMENT_TRANSITION_REJECTED");
      if (["active", "completed"].includes(current.status)) {
        return { payment_status: "paid", order_status: current.status, idempotent: true };
      }
    }
  }

  if (order.promo_code_id) {
    const { data: reserved, error: reserveError } = await supabaseAdmin.rpc("reserve_promo_redemption", {
      p_promo_code_id: order.promo_code_id,
      p_order_id: order.order_id,
      p_client_hash: clientPromoHash(String(order.assigned_email || "")),
    });
    if (reserveError || reserved !== true) {
      await notifyAdmin(`Paiement confirmé mais code promo indisponible pour ${order.order_id}.`, {
        level: "critical",
        orderId: order.order_id,
        dedupeKey: `promo-reservation-${order.order_id}`,
      });
      return { payment_status: "paid", order_status: "pending", promo_unavailable: true };
    }
  }

  if (!wasAlreadyPaid && order.marketing_consent === true && !order.meta_purchase_sent_at) {
    const metaSent = await sendMetaPurchase({
      orderId: order.order_id,
      amount: Number(order.amount),
      email: String(order.assigned_email || ""),
      items: order.items,
    });
    if (metaSent) {
      await supabaseAdmin
        .from("orders")
        .update({ meta_purchase_sent_at: new Date().toISOString() })
        .eq("order_id", order.order_id)
        .is("meta_purchase_sent_at", null);
    }
  }

  const expiresAt = expiresAtFromItems(Array.isArray(order.items) ? order.items : []);
  const { data: assignment, error: assignmentError } = await supabaseAdmin.rpc("assign_inventory_for_order", {
    p_order_id: order.order_id,
    p_expires_at: expiresAt,
  });

  if (assignmentError) {
    const waitingForStock = assignmentError.message?.includes("OUT_OF_STOCK");
    await notifyAdmin(
      waitingForStock
        ? `Paiement confirmé mais stock Netflix épuisé pour la commande ${order.order_id}.`
        : `Paiement confirmé mais attribution impossible pour ${order.order_id}.`,
      {
        level: waitingForStock ? "critical" : "warning",
        orderId: order.order_id,
        dedupeKey: `assignment-${order.order_id}`,
      },
    );
    void recordPaymentFailure(source === "slickpay_webhook" ? "webhook" : "blocked", order.order_id);
    if (waitingForStock) {
      return { payment_status: "paid", order_status: "pending", waiting_for_stock: true };
    }
    throw assignmentError;
  }

  resetPaymentFailure(source === "slickpay_webhook" ? "webhook" : "blocked", order.order_id);
  const assignmentStatus = String((assignment as any)?.status || "");
  const awaitingManualActivation = assignmentStatus === "awaiting_manual_activation";
  void appendAuditLog({
    action: "order_activation",
    targetType: "order",
    targetId: order.order_id,
    details: { source, awaiting_manual_activation: awaitingManualActivation },
  });
  return awaitingManualActivation
    ? { payment_status: "paid", order_status: "pending", awaiting_manual_activation: true }
    : { payment_status: "paid", order_status: "active", expires_at: expiresAt };
}
