import { Router, Request, Response as ExpressResponse } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { supabaseAuth, supabaseAdmin as supabase } from "../lib/supabase";
import { PRICES } from "../config/prices";
import { notifyAdmin } from "../lib/notifyAdmin";

const router = Router();

const SLICKPAY_URL = "https://prodapi.slick-pay.com/api/v2/users/invoices";

const invoiceLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false, default: false },
  keyGenerator: (req: Request) => req.ip || "unknown",
  message: { error: "Trop de tentatives de paiement, rÃƒÂ©essayez dans une minute." },
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
      console.warn(`[invoice] Ligne non rÃƒÂ©solvable pour SlickPay : ${item?.name}`);
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

// Fallback garanti-acceptÃƒÂ© : une seule ligne
function singleLineFallback(
  orderId: string,
  amount: number
): Array<{ name: string; price: number; quantity: number }> {
  return [{ name: `Commande ${orderId}`, price: amount, quantity: 1 }];
}

function frontendReturnUrl(orderId: string): string | null {
  const configured = process.env.FRONTEND_URL || "https://aura-stream.netlify.app";
  try {
    const url = new URL(configured);
    if (process.env.NODE_ENV === "production" && url.protocol !== "https:") return null;
    url.searchParams.set("payment", "return");
    url.searchParams.set("order_id", orderId);
    return url.toString();
  } catch {
    return null;
  }
}

function isAllowedPaymentUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (
      url.hostname === "slick-pay.com" || url.hostname.endsWith(".slick-pay.com")
    );
  } catch {
    return false;
  }
}

async function releaseClaim(orderId: string, claim: string): Promise<void> {
  await supabase
    .from("orders")
    .update({ slickpay_invoice_id: null })
    .eq("order_id", orderId)
    .eq("slickpay_invoice_id", claim);
}

router.post("/create-invoice", invoiceLimiter, async (req: Request, res: ExpressResponse): Promise<void> => {
  try {
    const email = await getAuthedEmail(req);
    if (!email) {
      res.status(401).json({ error: "Token invalide ou expirÃƒÂ©." });
      return;
    }

    const { order_id } = req.body;
    if (typeof order_id !== "string" || !/^ORD-[A-Za-z0-9-]{6,40}$/.test(order_id)) {
      res.status(400).json({ error: "order_id requis." });
      return;
    }

    const { data: order, error: fetchError } = await supabase
      .from("orders")
      .select("order_id, assigned_email, amount, status, payment_status, slickpay_invoice_id, items")
      .eq("order_id", order_id)
      .single();

    if (fetchError || !order) {
      req.log?.warn({ orderId: order_id }, "Invoice requested for unknown order");
      res.status(404).json({ error: "Commande introuvable. Si vous venez de la crÃƒÂ©er, veuillez rÃƒÂ©essayer dans quelques secondes." });
      return;
    }

    if (order.assigned_email?.toLowerCase() !== email.toLowerCase()) {
      res.status(403).json({ error: "AccÃƒÂ¨s refusÃƒÂ© ÃƒÂ  cette commande." });
      return;
    }

    if (order.status !== "pending" || order.payment_status !== "unpaid") {
      res.status(409).json({ error: "Cette commande n'est plus payable." });
      return;
    }

    if (typeof order.slickpay_invoice_id === "string" && order.slickpay_invoice_id.startsWith("pending:")) {
      const claimedAt = Number(order.slickpay_invoice_id.split(":")[1]);
      if (Number.isFinite(claimedAt) && Date.now() - claimedAt > 2 * 60 * 1000) {
        const staleClaim = order.slickpay_invoice_id;
        const { data: released } = await supabase
          .from("orders")
          .update({ slickpay_invoice_id: null })
          .eq("order_id", order.order_id)
          .eq("slickpay_invoice_id", staleClaim)
          .select("order_id");
        if (released?.length) order.slickpay_invoice_id = null;
      }
    }

    if (order.slickpay_invoice_id) {
      res.status(409).json({ error: "Un paiement a dÃƒÂ©jÃƒÂ  ÃƒÂ©tÃƒÂ© initialisÃƒÂ© pour cette commande." });
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

    const apiKey = process.env.SLICKPAY_PUBLIC_KEY || process.env.SLICKPAY_API_KEY || "";
    const webhookUrl = process.env.SLICKPAY_WEBHOOK_URL || "";
    const returnUrl = frontendReturnUrl(order.order_id);
    if (!apiKey || !process.env.WEBHOOK_SECRET || !returnUrl || !/^https:\/\//i.test(webhookUrl)) {
      res.status(503).json({ error: "Le service de paiement n'est pas configurÃƒÂ©." });
      return;
    }

    // Claim the order atomically before calling SlickPay. This prevents two
    // concurrent requests from creating two external invoices.
    const claim = `pending:${Date.now()}:${crypto.randomUUID()}`;
    const { data: claimed, error: claimError } = await supabase
      .from("orders")
      .update({ slickpay_invoice_id: claim })
      .eq("order_id", order.order_id)
      .eq("assigned_email", email)
      .eq("status", "pending")
      .eq("payment_status", "unpaid")
      .is("slickpay_invoice_id", null)
      .select("order_id");
    if (claimError || !claimed?.length) {
      res.status(409).json({ error: "Un paiement est dÃƒÂ©jÃƒÂ  en cours pour cette commande." });
      return;
    }

    const payload = {
      amount,
      // SlickPay utilise cette URL aussi bien aprÃƒÂ¨s un paiement qu'aprÃƒÂ¨s une
      // annulation. Le frontend doit vÃƒÂ©rifier le statut serveur avant d'afficher
      // une confirmation.
      url: returnUrl,
      webhook_url: webhookUrl,
      webhook_signature: process.env.WEBHOOK_SECRET,
      webhook_meta_data: [{ order_id: order.order_id }],
      firstname: email.split("@")[0] || "Client",
      lastname: "Aura Stream",
      email,
      address: "Alger, AlgÃƒÂ©rie",
      phone: "0550000000",
      items: finalItems,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let spRes: globalThis.Response;
    try {
      spRes = await fetch(SLICKPAY_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      await releaseClaim(order.order_id, claim);
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!spRes.ok) {
      await spRes.text().catch(() => "");
      req.log?.warn({ status: spRes.status, orderId: order_id }, "SlickPay invoice creation failed");
      await releaseClaim(order.order_id, claim);
      res.status(502).json({ error: "Erreur du prestataire de paiement." });
      return;
    }

    const spData: any = await spRes.json();
    const invoiceId = spData?.data?.id || spData?.id;
    const paymentUrl = spData?.url || spData?.data?.url || spData?.payment_url || spData?.redirect_url;

    if (!invoiceId || !isAllowedPaymentUrl(paymentUrl)) {
      await releaseClaim(order.order_id, claim);
      req.log?.error({ orderId: order_id }, "Invalid SlickPay invoice response");
      res.status(502).json({ error: "RÃƒÂ©ponse invalide du prestataire de paiement." });
      return;
    }

    const { data: saved, error: invoiceUpdateError } = await supabase
      .from("orders")
      .update({ slickpay_invoice_id: String(invoiceId) })
      .eq("order_id", order.order_id)
      .eq("slickpay_invoice_id", claim)
      .select("order_id");

    if (invoiceUpdateError || !saved?.length) {
      req.log?.error({ orderId: order_id }, "Could not persist SlickPay invoice id");
      await notifyAdmin("Facture SlickPay crÃƒÂ©ÃƒÂ©e mais impossible de l'enregistrer.", {
        level: "critical",
        orderId: order.order_id,
        dedupeKey: `invoice-save-${order.order_id}`,
      });
      res.status(502).json({ error: "Le paiement ne peut pas ÃƒÂªtre initialisÃƒÂ©. Contactez le support." });
      return;
    }

    res.json({
      payment_url: paymentUrl,
      invoice_id: String(invoiceId),
      order_id: order.order_id,
      amount,
    });
  } catch (err) {
    req.log?.error({ errorName: (err as Error)?.name }, "Invoice creation failed");
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

export default router;
