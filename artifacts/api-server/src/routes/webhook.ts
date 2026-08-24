import { Router, Request } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { supabaseAdmin as supabase } from "../lib/supabase";
import { notifyAdmin } from "../lib/notifyAdmin";
import { recordPaymentFailure } from "../lib/paymentAlerts";
import { fetchSlickPayInvoice } from "../lib/slickpay";
import { fulfillVerifiedPayment } from "../lib/paymentFulfillment";

const router = Router();

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false, default: false },
  message: { error: "Too many requests." },
});

function validSecret(received: unknown): boolean {
  const expected = process.env.WEBHOOK_SECRET || "";
  if (typeof received !== "string" || !received || !expected) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

router.post("/webhook", webhookLimiter, async (req, res) => {
  try {
    const receivedSecret = req.headers["x-webhook-secret"] ?? req.body?.webhook_signature;
    if (!validSecret(receivedSecret)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const invoiceId = String(req.body?.invoice_id ?? req.body?.id ?? "");
    const orderIdParam = String(req.body?.order_id ?? "");
    const rawStatus = String(
      req.body?.status
      ?? req.body?.payment_status
      ?? req.body?.completed
      ?? req.body?.data?.status
      ?? req.body?.data?.payment_status
      ?? req.body?.data?.completed
      ?? "",
    ).toLowerCase();
    
    if (!invoiceId || invoiceId.length > 160) return res.status(400).json({ error: "invoice_id manquant" });

    const isPaid = ["completed", "paid", "success", "successful", "1", "true"].includes(rawStatus);
    const isFailed = ["failed", "cancelled", "canceled", "0"].includes(rawStatus);

    const query = supabase
      .from("orders")
      .select("order_id, assigned_email, status, payment_status, promo_code_id, items, amount, slickpay_invoice_id, marketing_consent, meta_purchase_sent_at")
      .eq("slickpay_invoice_id", invoiceId);

    const { data: order, error: fetchErr } = await query.single();

    if (fetchErr || !order) {
      console.warn("Webhook: invoice inconnue");
      return res.status(200).json({ received: true });
    }

    if (orderIdParam && orderIdParam !== order.order_id) {
      return res.status(400).json({ error: "Références incohérentes" });
    }

    if (order.status === "active" || order.status === "completed") {
      return res.status(200).json({ received: true, idempotent: true });
    }

    const verified = await fetchSlickPayInvoice(invoiceId, 10_000);

    if (isFailed) {
      if (verified.state !== "failed" || order.payment_status === "paid") {
        return res.status(200).json({ received: true, ignored: true });
      }
      const { error: cancelError } = await supabase
        .from("orders")
        .update({ status: "cancelled", payment_status: "failed" })
        .eq("order_id", order.order_id)
        .eq("status", "pending")
        .eq("payment_status", "unpaid");
      if (cancelError) throw cancelError;
      return res.status(200).json({ received: true });
    }

    if (isPaid) {
      if (verified.state !== "paid") {
        return res.status(200).json({ received: true, verified: false });
      }
      if (verified.amount === null) {
        await notifyAdmin("Montant SlickPay absent de la vérification. Activation bloquée.", {
          level: "critical",
          orderId: order.order_id,
          dedupeKey: `amount-missing-${order.order_id}`,
        });
        return res.status(200).json({ received: true, amount_unavailable: true });
      }
      if (Math.abs(verified.amount - Number(order.amount)) > 0.001) {
        await notifyAdmin("Montant SlickPay différent du montant de commande. Activation bloquée.", {
          level: "critical",
          orderId: order.order_id,
          dedupeKey: `amount-mismatch-${order.order_id}`,
        });
        return res.status(200).json({ received: true, amount_mismatch: true });
      }

      const result = await fulfillVerifiedPayment(order, "slickpay_webhook");
      return res.status(200).json({
        received: true,
        activated: result.order_status === "active",
        needs_manual: result.order_status === "pending",
        ...result,
      });
    }

    return res.status(200).json({ received: true, ignored: rawStatus });
  } catch (err) {
    console.error("Webhook payment processing failed.");
    void recordPaymentFailure("webhook", String(req.body?.order_id || "unknown"));
    await notifyAdmin("Erreur inattendue dans le webhook de paiement.", {
      level: "warning",
    });
    return res.status(500).json({ error: "Erreur interne" });
  }
});

export default router;
