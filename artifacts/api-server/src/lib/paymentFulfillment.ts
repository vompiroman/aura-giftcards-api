import { supabaseAdmin } from "./supabase";
import { notifyAdmin } from "./notifyAdmin";
import { appendAuditLog } from "./auditLog";
import { recordPaymentFailure, resetPaymentFailure } from "./paymentAlerts";
import { clientPromoHash } from "./promos";
import { expiresAtFromItems } from "./payments";
import { deliverActivationNotificationsForOrder } from "../jobs/activationNotificationDelivery";
import { sameOrderOwner } from "./orderOwnership";

export interface PayableOrder {
  order_id: string;
  assigned_email?: string | null;
  customer_user_id?: string | null;
  status: string;
  payment_status: string;
  promo_code_id?: string | null;
  renewal_order_id?: string | null;
  items: any;
  amount: number;
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
  source: "slickpay_return" | "slickpay_webhook" | "slickpay_reconcile" | "partner_wallet",
  options: { paymentTransitioned: boolean },
): Promise<FulfillmentResult> {
  if (["active", "completed"].includes(order.status) && order.payment_status === "paid") {
    return { payment_status: "paid", order_status: order.status as "active" | "completed", idempotent: true };
  }

  if (typeof options.paymentTransitioned !== "boolean") {
    throw new Error("SLICKPAY_OBSERVATION_REQUIRED");
  }

  // Le paiement a déjà été confirmé par l'observation SlickPay ou le débit
  // atomique du portefeuille. Il n'existe pas de confirmation manuelle.

  if (order.promo_code_id && source !== "partner_wallet") {
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

  // Notify operations only once the payment has been confirmed. Credentials
  // stay in the encrypted order and the retry job handles delivery failures.
  void deliverActivationNotificationsForOrder(order.order_id, order.items).catch((error) => {
    console.warn("[activation] Immediate credential delivery failed.", { errorName: error?.name });
  });

  let renewalBaseDate: string | Date = new Date();
  if (order.renewal_order_id) {
    const { data: renewedOrder, error: renewedOrderError } = await supabaseAdmin
      .from("orders")
      .select("order_id, customer_user_id, payment_status, status, expires_at")
      .eq("order_id", order.renewal_order_id)
      .maybeSingle();
    if (
      renewedOrderError
      || !renewedOrder
      || !sameOrderOwner(order, renewedOrder)
      || renewedOrder.payment_status !== "paid"
      || !["active", "completed"].includes(String(renewedOrder.status))
    ) {
      throw new Error("RENEWAL_ORDER_INVALID");
    }
    renewalBaseDate = renewedOrder.expires_at || renewalBaseDate;
  }

  const expiresAt = expiresAtFromItems(
    Array.isArray(order.items) ? order.items : [],
    renewalBaseDate,
  );
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
