import { Router, Request } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { supabase } from "../lib/supabase";
import { notifyAdmin } from "../lib/notifyAdmin";

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

function durationFromItems(items: any[]): number {
  let max = 1;
  for (const it of items || []) {
    const m = /(\d+)\s*mois/i.exec(String(it?.name || ""));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

router.post("/webhook", webhookLimiter, async (req, res) => {
  try {
    if (!validSecret(req.headers["x-webhook-secret"])) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const invoiceId = String(req.body?.invoice_id ?? req.body?.id ?? "");
    const orderIdParam = String(req.body?.order_id ?? "");
    const rawStatus = String(req.body?.status ?? req.body?.completed ?? "").toLowerCase();
    
    if (!invoiceId && !orderIdParam) return res.status(400).json({ error: "id manquant" });

    const isPaid = ["completed", "paid", "success", "1"].includes(rawStatus);
    const isFailed = ["failed", "cancelled", "canceled", "0"].includes(rawStatus);

    let query = supabase.from("orders").select("order_id, status, items");
    if (invoiceId) {
      query = query.eq("invoice_id", invoiceId);
    } else {
      query = query.eq("order_id", orderIdParam);
    }

    const { data: order, error: fetchErr } = await query.single();

    if (fetchErr || !order) {
      console.error("Webhook: commande introuvable pour", invoiceId || orderIdParam);
      return res.status(200).json({ received: true });
    }

    if (order.status === "active" || order.status === "completed" || order.status === "cancelled") {
      return res.status(200).json({ received: true, idempotent: true });
    }

    if (isFailed) {
      await supabase
        .from("orders")
        .update({ status: "cancelled" })
        .eq("order_id", order.order_id)
        .eq("status", "pending");
      return res.status(200).json({ received: true });
    }

    if (isPaid) {
      const months = durationFromItems(order.items);
      const { error: rpcErr } = await supabase.rpc("assign_inventory_for_order", {
        p_order_id: order.order_id,
        p_duration_months: months,
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

      return res.status(200).json({ received: true, activated: true });
    }

    return res.status(200).json({ received: true, ignored: rawStatus });
  } catch (err) {
    console.error("Webhook error:", err);
    await notifyAdmin(`Erreur inattendue dans le webhook de paiement: ${(err as Error)?.message}`, {
      level: "warning",
    });
    return res.status(500).json({ error: "Erreur interne" });
  }
});

export default router;
