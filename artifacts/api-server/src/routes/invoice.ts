import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { supabaseAuth, supabaseAdmin as supabase } from "../lib/supabase";
import { PRICES } from "../config/prices";

const router = Router();

const SLICKPAY_URL = "https://prodapi.slick-pay.com/api/v2/users/invoices";

const invoiceLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false, default: false },
  keyGenerator: (req: Request) => {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    return token || (typeof req.headers["x-forwarded-for"] === "string" ? req.headers["x-forwarded-for"] : "unknown");
  },
  message: { error: "Trop de tentatives de paiement, réessayez dans une minute." },
});

async function getAuthedEmail(req: Request): Promise<string | null> {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return null;
  const token = h.slice(7).trim();
  if (!token) return null;
  const { data, error } = await supabaseAuth.auth.getUser(token);
  if (error || !data?.user?.email) return null;
  return data.user.email.trim().toLowerCase();
}

// Construction des lignes SlickPay (exige { name, price, quantity })
function buildSlickpayItems(
  orderItems: any[]
): Array<{ name: string; price: number; quantity: number }> | null {
  if (!Array.isArray(orderItems) || orderItems.length === 0) return null;

  const mapped = [];
  for (const item of orderItems) {
    const unitPrice = PRICES[item.name];
    const qty = Number(item.quantity);

    if (typeof unitPrice !== "number" || !Number.isFinite(qty) || qty <= 0) {
      console.warn(`[invoice] Ligne non résolvable pour SlickPay : ${item?.name}`);
      return null;
    }

    mapped.push({
      name: item.name,
      price: unitPrice,
      quantity: qty,
    });
  }
  return mapped;
}

// Fallback garanti-accepté : une seule ligne
function singleLineFallback(
  orderId: string,
  amount: number
): Array<{ name: string; price: number; quantity: number }> {
  return [{ name: `Commande ${orderId}`, price: amount, quantity: 1 }];
}

router.post("/create-invoice", invoiceLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const email = await getAuthedEmail(req);
    if (!email) {
      res.status(401).json({ error: "Token invalide ou expiré." });
      return;
    }

    const { order_id } = req.body;
    if (!order_id || typeof order_id !== "string") {
      res.status(400).json({ error: "order_id requis." });
      return;
    }

    const { data: order, error: fetchError } = await supabase
      .from("orders")
      .select("order_id, assigned_email, amount, status, items")
      .eq("order_id", order_id)
      .single();

    if (fetchError || !order) {
      console.error(`[create-invoice] Order not found: ${order_id}. Supabase error:`, fetchError ? JSON.stringify(fetchError) : "no error, just empty result");
      res.status(404).json({ error: "Commande introuvable. Si vous venez de la créer, veuillez réessayer dans quelques secondes." });
      return;
    }

    if (order.assigned_email?.toLowerCase() !== email.toLowerCase()) {
      res.status(403).json({ error: "Accès refusé à cette commande." });
      return;
    }

    if (order.status !== "pending") {
      res.status(409).json({ error: "Cette commande n'est plus payable." });
      return;
    }

    const amount = Number(order.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      res.status(500).json({ error: "Montant de commande invalide." });
      return;
    }

    const detailed = buildSlickpayItems(order.items);
    const slickpayItems = detailed ?? singleLineFallback(order.order_id, amount);

    const itemsTotal = slickpayItems.reduce((s, it) => s + it.price * it.quantity, 0);
    const finalItems =
      itemsTotal === amount ? slickpayItems : singleLineFallback(order.order_id, amount);

    const payload = {
      amount,
      url: `${process.env.FRONTEND_URL || "http://localhost:3000"}/?payment=success&order_id=${order.order_id}`,
      webhook_url: process.env.SLICKPAY_WEBHOOK_URL,
      firstname: email.split("@")[0] || "Client",
      lastname: "Aura Stream",
      email,
      address: "Alger, Algérie",
      phone: "0550000000",
      items: finalItems,
    };

    const apiKey = process.env.SLICKPAY_PUBLIC_KEY || process.env.SLICKPAY_API_KEY || "";
    const spRes = await fetch(SLICKPAY_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!spRes.ok) {
      const detail = await spRes.text().catch(() => "");
      console.error(`[invoice] SlickPay error ${spRes.status} pour commande ${order_id}: ${detail}`);
      res.status(502).json({ error: "Erreur du prestataire de paiement.", slickpay_status: spRes.status, slickpay_detail: detail });
      return;
    }

    const spData: any = await spRes.json();
    const invoiceId = spData?.data?.id || spData?.id;

    if (invoiceId) {
      await supabase
        .from("orders")
        .update({ invoice_id: String(invoiceId) })
        .eq("order_id", order.order_id);
    }

    res.json({
      payment_url: spData?.url || spData?.data?.url || spData?.payment_url || spData?.redirect_url,
      order_id: order.order_id,
      amount,
    });
  } catch (err) {
    console.error("create-invoice error:", err);
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

export default router;
