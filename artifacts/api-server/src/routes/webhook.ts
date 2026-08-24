import { Router, Request } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { supabaseAdmin as supabase } from "../lib/supabase";
import { notifyAdmin } from "../lib/notifyAdmin";
import { recordPaymentFailure } from "../lib/paymentAlerts";
import { fetchSlickPayInvoice } from "../lib/slickpay";
import { fulfillVerifiedPayment } from "../lib/paymentFulfillment";
import { observeSlickPayPayment } from "../lib/slickpayObservation";

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

function webhookScalar(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  return "";
}

function webhookMetadata(body: any): Record<string, unknown> {
  const raw = body?.webhook_meta_data ?? body?.meta_data ?? body?.data?.webhook_meta_data;
  if (Array.isArray(raw)) {
    return raw.find((entry) => entry && typeof entry === "object") || {};
  }
  return raw && typeof raw === "object" ? raw : {};
}

router.post("/webhook", webhookLimiter, async (req, res) => {
  try {
    const receivedSecret = req.headers["x-webhook-secret"]
      ?? req.headers["x-slickpay-signature"]
      ?? req.body?.webhook_signature
      ?? req.body?.signature;
    if (!validSecret(receivedSecret)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const metadata = webhookMetadata(req.body);
    const invoiceObject = req.body?.invoice && typeof req.body.invoice === "object" ? req.body.invoice : null;
    const invoiceId = webhookScalar(
      req.body?.invoice_id
      ?? req.body?.id
      ?? invoiceObject?.id
      ?? req.body?.invoice
      ?? req.body?.data?.invoice_id
      ?? req.body?.data?.id
      ?? metadata.invoice_id,
    );
    const orderIdParam = webhookScalar(req.body?.order_id ?? req.body?.data?.order_id ?? metadata.order_id);
    
    if (!invoiceId || invoiceId.length > 160) return res.status(400).json({ error: "invoice_id manquant" });

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
    const observation = await observeSlickPayPayment(order.order_id, invoiceId, verified);

    if (observation.result === "amount_missing") {
      await notifyAdmin("Montant SlickPay absent de la vérification. Activation bloquée.", {
        level: "critical",
        orderId: order.order_id,
        dedupeKey: `amount-missing-${order.order_id}`,
      });
      return res.status(200).json({ received: true, amount_unavailable: true });
    }
    if (observation.result === "amount_mismatch") {
      await notifyAdmin("Montant SlickPay différent du montant de commande. Activation bloquée.", {
        level: "critical",
        orderId: order.order_id,
        dedupeKey: `amount-mismatch-${order.order_id}`,
      });
      return res.status(200).json({ received: true, amount_mismatch: true });
    }
    if (verified.state === "paid") {
      const result = await fulfillVerifiedPayment(order, "slickpay_webhook", {
        paymentTransitioned: observation.transitioned,
      });
      return res.status(200).json({
        received: true,
        activated: result.order_status === "active",
        needs_manual: result.order_status === "pending",
        ...result,
      });
    }
    return res.status(200).json({
      received: true,
      verified: true,
      payment_status: observation.payment_status || verified.state,
      order_status: observation.order_status || order.status,
    });
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
