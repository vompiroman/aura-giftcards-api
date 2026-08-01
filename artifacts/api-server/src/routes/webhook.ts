import { Router, Request } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { supabaseAdmin as supabase } from "../lib/supabase";
import { notifyAdmin } from "../lib/notifyAdmin";
import { sendMetaPurchase } from "../lib/metaConversions";
import { appendAuditLog } from "../lib/auditLog";
import { recordPaymentFailure, resetPaymentFailure } from "../lib/paymentAlerts";
import { clientPromoHash } from "../lib/promos";

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

interface InvoiceVerification {
  paid: boolean;
  failed: boolean;
  amount: number | null;
}

async function verifyInvoiceWithSlickPay(invoiceId: string): Promise<InvoiceVerification> {
  const apiKey = process.env.SLICKPAY_PUBLIC_KEY || process.env.SLICKPAY_API_KEY || "";
  if (!apiKey) throw new Error("SlickPay API key is missing");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(
      `https://prodapi.slick-pay.com/api/v2/users/invoices/${encodeURIComponent(invoiceId)}`,
      {
        headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error(`SlickPay verification returned ${response.status}`);

    const body: any = await response.json();
    let data: any = body?.data ?? {};
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch { data = {}; }
    }

    const completed = body?.completed ?? data?.completed;
    const status = String(
      data?.payment_status ?? body?.payment_status ?? data?.status ?? body?.status ?? "",
    ).toLowerCase();
    const amountValue = data?.amount ?? body?.amount;
    const amount = Number(amountValue);

    return {
      paid: completed === 1 || completed === true || completed === "1" || String(completed).toLowerCase() === "true"
        || ["paid", "completed", "success", "successful", "true"].includes(status),
      failed: ["failed", "cancelled", "canceled"].includes(status),
      amount: Number.isFinite(amount) ? amount : null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function durationFromItems(items: any[]): number {
  let max = 1;
  for (const it of items || []) {
    const text = String(it?.name || "").toLowerCase();
    if (text.includes("1 an") || text.includes("1 year") || text.includes("12 mois") || text.includes("سنة")) {
      max = Math.max(max, 12);
    } else if (text.includes("6 mois") || text.includes("6 months")) {
      max = Math.max(max, 6);
    } else if (text.includes("3 mois") || text.includes("3 months")) {
      max = Math.max(max, 3);
    } else if (text.includes("2 mois") || text.includes("2 months") || text.includes("شهران")) {
      max = Math.max(max, 2);
    } else {
      const m = /(\d+)\s*(mois|month|ans?|years?)/i.exec(text);
      if (m) {
        let val = parseInt(m[1], 10);
        if (m[2].startsWith("an") || m[2].startsWith("year")) val *= 12;
        max = Math.max(max, val);
      }
    }
  }
  return Math.min(max, 12);
}

function expiresAtFromMonths(months: number): string {
  const now = new Date();
  const day = now.getUTCDate();
  const expiresAt = new Date(now);
  expiresAt.setUTCDate(1);
  expiresAt.setUTCMonth(expiresAt.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(expiresAt.getUTCFullYear(), expiresAt.getUTCMonth() + 1, 0)).getUTCDate();
  expiresAt.setUTCDate(Math.min(day, lastDay));
  return expiresAt.toISOString();
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

    const verified = await verifyInvoiceWithSlickPay(invoiceId);

    if (isFailed) {
      if (!verified.failed || verified.paid || order.payment_status === "paid") {
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
      if (!verified.paid) {
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

      // Seul ce webhook authentifié constitue une preuve de paiement.
      const wasAlreadyPaid = order.payment_status === "paid";
      const { data: paymentTransition, error: paymentUpdateError } = wasAlreadyPaid
        ? { data: [{ order_id: order.order_id }], error: null }
        : await supabase
          .from("orders")
          .update({ status: "pending", payment_status: "paid" })
          .eq("order_id", order.order_id)
          .eq("payment_status", "unpaid")
          .select("order_id");
      if (paymentUpdateError) throw paymentUpdateError;

      if (!wasAlreadyPaid && !paymentTransition?.length) {
        return res.status(200).json({ received: true, idempotent: true });
      }

      if (order.promo_code_id) {
        const { data: reserved, error: reserveError } = await supabase.rpc("reserve_promo_redemption", {
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
          return res.status(200).json({ received: true, needs_manual: true, promo_unavailable: true });
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
          const { error: metaUpdateError } = await supabase
            .from("orders")
            .update({ meta_purchase_sent_at: new Date().toISOString() })
            .eq("order_id", order.order_id)
            .is("meta_purchase_sent_at", null);
          if (metaUpdateError) {
            req.log?.warn({ orderId: order.order_id }, "Could not persist Meta Purchase delivery marker");
          }
        }
      }

      const months = durationFromItems(order.items);
      const { error: rpcErr } = await supabase.rpc("assign_inventory_for_order", {
        p_order_id: order.order_id,
        p_expires_at: expiresAtFromMonths(months),
      });

      if (rpcErr) {
        const isOutOfStock = rpcErr.message?.includes("OUT_OF_STOCK");
        const service = isOutOfStock
          ? rpcErr.message.split("OUT_OF_STOCK:")[1]?.trim() || "inconnu"
          : undefined;

        await notifyAdmin(
          isOutOfStock
            ? `Client PAYÉ mais stock épuisé pour « ${service} ». Attribution manuelle requise immédiatement.`
            : `Échec d'assignation d'inventaire (paiement pourtant confirmé) : ${rpcErr.message}`,
          {
            level: "critical",
            orderId: order.order_id,
            service,
            dedupeKey: order.order_id,
          }
        );

        return res.status(200).json({ received: true, needs_manual: true });
      }

      resetPaymentFailure("webhook", order.order_id);
      void appendAuditLog({
        action: "order_activation",
        targetType: "order",
        targetId: order.order_id,
        details: { source: "slickpay_webhook" },
      });
      return res.status(200).json({ received: true, activated: true });
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
