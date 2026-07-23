import { Router, Request } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { supabaseAdmin as supabase } from "../lib/supabase";
import { notifyAdmin } from "../lib/notifyAdmin";
import { sendMetaPurchase } from "../lib/metaConversions";

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
      paid: completed === 1 || completed === true || completed === "1" || ["paid", "completed", "success"].includes(status),
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
    if (text.includes("1 an") || text.includes("1 year") || text.includes("12 mois") || text.includes("Ã˜Â³Ã™â€ Ã˜Â©")) {
      max = Math.max(max, 12);
    } else if (text.includes("6 mois") || text.includes("6 months")) {
      max = Math.max(max, 6);
    } else if (text.includes("3 mois") || text.includes("3 months")) {
      max = Math.max(max, 3);
    } else if (text.includes("2 mois") || text.includes("2 months") || text.includes("Ã˜Â´Ã™â€¡Ã˜Â±Ã˜Â§Ã™â€ ")) {
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
    const rawStatus = String(req.body?.status ?? req.body?.completed ?? "").toLowerCase();
    
    if (!invoiceId || invoiceId.length > 160) return res.status(400).json({ error: "invoice_id manquant" });

    const isPaid = ["completed", "paid", "success", "1"].includes(rawStatus);
    const isFailed = ["failed", "cancelled", "canceled", "0"].includes(rawStatus);

    const query = supabase
      .from("orders")
      .select("order_id, assigned_email, status, payment_status, items, amount, slickpay_invoice_id")
      .eq("slickpay_invoice_id", invoiceId);

    const { data: order, error: fetchErr } = await query.single();

    if (fetchErr || !order) {
      console.warn("Webhook: invoice inconnue");
      return res.status(200).json({ received: true });
    }

    if (orderIdParam && orderIdParam !== order.order_id) {
      return res.status(400).json({ error: "RÃƒÂ©fÃƒÂ©rences incohÃƒÂ©rentes" });
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
      if (verified.amount !== null && Math.abs(verified.amount - Number(order.amount)) > 0.001) {
        await notifyAdmin("Montant SlickPay diffÃƒÂ©rent du montant de commande. Activation bloquÃƒÂ©e.", {
          level: "critical",
          orderId: order.order_id,
          dedupeKey: `amount-mismatch-${order.order_id}`,
        });
        return res.status(200).json({ received: true, amount_mismatch: true });
      }

      // Seul ce webhook authentifiÃƒÂ© constitue une preuve de paiement.
      const { error: paymentUpdateError } = await supabase
        .from("orders")
        .update({ status: "pending", payment_status: "paid" })
        .eq("order_id", order.order_id)
        .neq("payment_status", "paid");
      if (paymentUpdateError) throw paymentUpdateError;

      // Browser Pixel and server CAPI share this order-based event_id. Meta can
      // therefore deduplicate the two Purchase signals safely.
      void sendMetaPurchase({
        orderId: order.order_id,
        amount: Number(order.amount),
        email: String(order.assigned_email || ""),
        items: order.items,
      });

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
            ? `Client PAYÃƒâ€° mais stock ÃƒÂ©puisÃƒÂ© pour Ã‚Â« ${service} Ã‚Â». Attribution manuelle requise immÃƒÂ©diatement.`
            : `Ãƒâ€°chec d'assignation d'inventaire (paiement pourtant confirmÃƒÂ©) : ${rpcErr.message}`,
          {
            level: "critical",
            orderId: order.order_id,
            service,
            dedupeKey: order.order_id,
          }
        );

        return res.status(200).json({ received: true, needs_manual: true });
      }

      return res.status(200).json({ received: true, activated: true });
    }

    return res.status(200).json({ received: true, ignored: rawStatus });
  } catch (err) {
    console.error("Webhook payment processing failed.");
    await notifyAdmin("Erreur inattendue dans le webhook de paiement.", {
      level: "warning",
    });
    return res.status(500).json({ error: "Erreur interne" });
  }
});

export default router;
