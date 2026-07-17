import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { supabaseAuth, supabaseAdmin as supabase } from "../lib/supabase";
import { PRICES } from "../config/prices";
import { expiresAtFromItems, slickPayPaymentState } from "../lib/payments";
import { notifyAdmin } from "../lib/notifyAdmin";

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

const verifyPaymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false, default: false },
  keyGenerator: (req: Request) => {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    return token || "unknown";
  },
  message: { error: "Trop de vérifications de paiement, réessayez dans une minute." },
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
      url: `${process.env.FRONTEND_URL || "http://localhost:3000"}/?payment=return&order_id=${encodeURIComponent(order.order_id)}`,
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

    if (!invoiceId) {
      console.error(`[invoice] Réponse SlickPay sans identifiant pour ${order.order_id}`);
      res.status(502).json({ error: "Facture créée sans identifiant vérifiable." });
      return;
    }

    const { error: invoiceSaveError } = await supabase
      .from("orders")
      .update({ slickpay_invoice_id: String(invoiceId) })
      .eq("order_id", order.order_id)
      .eq("status", "pending");

    if (invoiceSaveError) {
      console.error(`[invoice] Impossible d'enregistrer la facture ${invoiceId} pour ${order.order_id}:`, invoiceSaveError);
      res.status(502).json({ error: "Impossible de sécuriser la vérification de cette facture. Contactez le support." });
      return;
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

router.post("/verify-payment", verifyPaymentLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const email = await getAuthedEmail(req);
    if (!email) {
      res.status(401).json({ error: "Token invalide ou expiré." });
      return;
    }

    const orderId = String(req.body?.order_id || "");
    if (!/^ORD-[A-Za-z0-9-]{6,40}$/.test(orderId)) {
      res.status(400).json({ error: "Identifiant de commande invalide." });
      return;
    }

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select("order_id, assigned_email, amount, status, payment_status, slickpay_invoice_id, items, expires_at")
      .eq("order_id", orderId)
      .single();

    if (orderError || !order) {
      res.status(404).json({ error: "Commande introuvable." });
      return;
    }
    if (order.assigned_email?.trim().toLowerCase() !== email) {
      res.status(403).json({ error: "Accès refusé à cette commande." });
      return;
    }
    if (order.status === "active") {
      res.json({ verified: true, payment_status: "paid", order_status: "active", expires_at: order.expires_at });
      return;
    }
    if (!order.slickpay_invoice_id) {
      res.status(409).json({
        verified: false,
        payment_status: order.payment_status || "unpaid",
        order_status: order.status,
        error: "Cette ancienne facture ne possède pas d'identifiant de vérification.",
      });
      return;
    }

    const apiKey = process.env.SLICKPAY_PUBLIC_KEY || process.env.SLICKPAY_API_KEY || "";
    if (!apiKey) {
      res.status(500).json({ error: "Configuration de paiement incomplète." });
      return;
    }

    const spRes = await fetch(`${SLICKPAY_URL}/${encodeURIComponent(order.slickpay_invoice_id)}`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    });

    if (!spRes.ok) {
      const detail = await spRes.text().catch(() => "");
      console.error(`[verify-payment] SlickPay ${spRes.status} pour ${orderId}: ${detail}`);
      res.status(502).json({ error: "La vérification du paiement est momentanément indisponible." });
      return;
    }

    const spData: any = await spRes.json();
    const paymentState = slickPayPaymentState(spData);
    const providerAmount = Number(spData?.data?.amount ?? spData?.amount);

    if (Number.isFinite(providerAmount) && providerAmount !== Number(order.amount)) {
      console.error(`[verify-payment] Montant incohérent pour ${orderId}: attendu ${order.amount}, reçu ${providerAmount}`);
      await notifyAdmin(`Montant SlickPay incohérent pour la commande ${orderId}.`, {
        level: "critical",
        orderId,
        dedupeKey: `amount-${orderId}`,
      });
      res.status(409).json({ error: "Le montant vérifié ne correspond pas à la commande." });
      return;
    }

    if (paymentState !== "paid") {
      if (paymentState === "failed") {
        await supabase
          .from("orders")
          .update({ payment_status: "failed", status: "cancelled" })
          .eq("order_id", orderId)
          .eq("status", "pending");
      }
      res.json({
        verified: true,
        payment_status: paymentState,
        order_status: paymentState === "failed" ? "cancelled" : order.status,
      });
      return;
    }

    const { error: paidUpdateError } = await supabase
      .from("orders")
      .update({ payment_status: "paid" })
      .eq("order_id", orderId)
      .eq("status", "pending");

    if (paidUpdateError) {
      console.error(`[verify-payment] Impossible d'enregistrer le paiement de ${orderId}:`, paidUpdateError);
      res.status(500).json({ error: "Paiement confirmé mais enregistrement impossible. Le support a été alerté." });
      return;
    }

    const expiresAt = expiresAtFromItems(order.items);
    const { error: assignmentError } = await supabase.rpc("assign_inventory_for_order", {
      p_order_id: orderId,
      p_expires_at: expiresAt,
    });

    if (assignmentError) {
      const waitingForStock = assignmentError.message?.includes("OUT_OF_STOCK");
      await notifyAdmin(
        waitingForStock
          ? `Paiement confirmé mais stock épuisé pour la commande ${orderId}.`
          : `Paiement confirmé mais attribution impossible pour ${orderId}: ${assignmentError.message}`,
        {
          level: waitingForStock ? "critical" : "warning",
          orderId,
          dedupeKey: `assignment-${orderId}`,
        },
      );

      if (waitingForStock) {
        res.json({ verified: true, payment_status: "paid", order_status: "pending", waiting_for_stock: true });
        return;
      }

      res.status(502).json({
        verified: true,
        payment_status: "paid",
        order_status: "pending",
        error: "Paiement confirmé. L'attribution sera finalisée par le support.",
      });
      return;
    }

    res.json({ verified: true, payment_status: "paid", order_status: "active", expires_at: expiresAt });
  } catch (err) {
    console.error("verify-payment error:", err);
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

export default router;
