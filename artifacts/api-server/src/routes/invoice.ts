import { Router, Request, Response as ExpressResponse } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { supabaseAuth, supabaseAdmin as supabase } from "../lib/supabase";
import { PRICES } from "../config/prices";
import { notifyAdmin } from "../lib/notifyAdmin";
import { recordPaymentFailure } from "../lib/paymentAlerts";
import { fetchSlickPayInvoice } from "../lib/slickpay";
import { fulfillVerifiedPayment } from "../lib/paymentFulfillment";
import { runPaymentReconciliation } from "../jobs/paymentReconciliation";

const router = Router();

const SLICKPAY_URL = "https://prodapi.slick-pay.com/api/v2/users/invoices";
const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;

function validCronSecret(received: string | undefined): boolean {
  const expected = process.env.CRON_SECRET || "";
  if (!received || !expected) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readBoundedProviderText(response: globalThis.Response): Promise<string> {
  const announcedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(announcedLength) && announcedLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new Error("PROVIDER_RESPONSE_TOO_LARGE");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("PROVIDER_RESPONSE_TOO_LARGE");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function readBoundedProviderJson(response: globalThis.Response): Promise<any> {
  return JSON.parse(await readBoundedProviderText(response));
}

const invoiceLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false, default: false },
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
      // SlickPay hands SATIM/Edahabia checkout to this exact payment host.
      || url.hostname === "cib.satim.dz"
    );
  } catch {
    return false;
  }
}

function configuredSlickPayAccount(): string | null {
  const value = String(process.env.SLICKPAY_ACCOUNT_UUID || "").trim();
  if (!value) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

function slickPayResponseSummary(data: any): Record<string, unknown> {
  const rawUrl =
    data?.url ??
    data?.data?.url ??
    data?.payment_url ??
    data?.data?.payment_url ??
    data?.redirect_url ??
    data?.data?.redirect_url;
  let paymentHost: string | null = null;
  try {
    paymentHost = typeof rawUrl === "string" ? new URL(rawUrl).hostname : null;
  } catch {
    paymentHost = null;
  }
  return {
    success: data?.success,
    keys: data && typeof data === "object" && !Array.isArray(data)
      ? Object.keys(data).slice(0, 12)
      : [],
    hasId: Boolean(data?.data?.id ?? data?.id),
    paymentHost,
  };
}

function slickPayErrorSummary(raw: string): Record<string, unknown> {
  let parsed: any = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // SlickPay may return a plain-text or HTML error body.
  }

  const values = [
    parsed?.message,
    parsed?.error,
    parsed?.detail,
    parsed?.errors,
    parsed?.data?.message,
    parsed?.data?.error,
  ].filter((value) => value !== undefined && value !== null);
  const message = String(values[0] ?? raw ?? "")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b\d{10,}\b/g, "[number]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);

  return {
    format: parsed ? "json" : "text",
    keys: parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.keys(parsed).slice(0, 12)
      : [],
    message,
  };
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
      res.status(401).json({ error: "Token invalide ou expiré." });
      return;
    }

    const { order_id } = req.body;
    if (typeof order_id !== "string" || !/^ORD-[A-Za-z0-9-]{6,40}$/.test(order_id)) {
      res.status(400).json({ error: "order_id requis." });
      return;
    }

    const { data: order, error: fetchError } = await supabase
      .from("orders")
      .select("order_id, assigned_email, amount, status, payment_status, promo_code_id, slickpay_invoice_id, items")
      .eq("order_id", order_id)
      .single();

    if (fetchError || !order) {
      req.log?.warn({ orderId: order_id }, "Invoice requested for unknown order");
      res.status(404).json({ error: "Commande introuvable. Si vous venez de la créer, veuillez réessayer dans quelques secondes." });
      return;
    }

    if (order.assigned_email?.toLowerCase() !== email.toLowerCase()) {
      res.status(403).json({ error: "Accès refusé à cette commande." });
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
      res.status(409).json({ error: "Un paiement a déjà été initialisé pour cette commande." });
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
    const configuredAccountValue = String(process.env.SLICKPAY_ACCOUNT_UUID || "").trim();
    const account = configuredSlickPayAccount();
    const returnUrl = frontendReturnUrl(order.order_id);
    if (
      !apiKey ||
      !process.env.WEBHOOK_SECRET ||
      !returnUrl ||
      !/^https:\/\//i.test(webhookUrl) ||
      (configuredAccountValue && !account)
    ) {
      res.status(503).json({ error: "Le service de paiement n'est pas configuré." });
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
      res.status(409).json({ error: "Un paiement est déjà en cours pour cette commande." });
      return;
    }

    const payload = {
      amount,
      // SlickPay utilise cette URL aussi bien après un paiement qu'après une
      // annulation. Le frontend doit vérifier le statut serveur avant d'afficher
      // une confirmation.
      url: returnUrl,
      ...(account ? { account } : {}),
      webhook_url: webhookUrl,
      webhook_signature: process.env.WEBHOOK_SECRET,
      webhook_meta_data: [{ order_id: order.order_id }],
      firstname: email.split("@")[0] || "Client",
      lastname: "Aura Stream",
      email,
      address: "Alger, Algérie",
      phone: "0550000000",
      items: finalItems,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let spRes!: globalThis.Response;
    let providerBody = "";
    let spData: any = null;
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
      if (spRes.ok) {
        spData = await readBoundedProviderJson(spRes);
      } else {
        providerBody = await readBoundedProviderText(spRes);
      }
    } catch (error) {
      await releaseClaim(order.order_id, claim);
      req.log?.warn({
        orderId: order_id,
        reason: (error as Error)?.name === "AbortError" ? "timeout" : "invalid_response",
      }, "SlickPay invoice request failed");
      res.status(502).json({ error: "Le prestataire de paiement est momentanément indisponible." });
      return;
    } finally {
      clearTimeout(timeout);
    }

    if (!spRes.ok) {
      req.log?.warn(
        {
          status: spRes.status,
          orderId: order_id,
          provider: slickPayErrorSummary(providerBody),
        },
        "SlickPay invoice creation failed",
      );
      await releaseClaim(order.order_id, claim);
      res.status(502).json({ error: "Erreur du prestataire de paiement." });
      return;
    }

    const invoiceId = spData?.data?.id ?? spData?.id;
    const paymentUrl =
      spData?.url ??
      spData?.data?.url ??
      spData?.payment_url ??
      spData?.data?.payment_url ??
      spData?.redirect_url ??
      spData?.data?.redirect_url;

    if (
      invoiceId === undefined ||
      invoiceId === null ||
      String(invoiceId).trim() === "" ||
      !isAllowedPaymentUrl(paymentUrl)
    ) {
      await releaseClaim(order.order_id, claim);
      req.log?.error(
        { orderId: order_id, provider: slickPayResponseSummary(spData) },
        "Invalid SlickPay invoice response",
      );
      res.status(502).json({ error: "Réponse invalide du prestataire de paiement." });
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
      await notifyAdmin("Facture SlickPay créée mais impossible de l'enregistrer.", {
        level: "critical",
        orderId: order.order_id,
        dedupeKey: `invoice-save-${order.order_id}`,
      });
      res.status(502).json({ error: "Le paiement ne peut pas être initialisé. Contactez le support." });
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

router.post("/verify-payment", verifyPaymentLimiter, async (req: Request, res: ExpressResponse): Promise<void> => {
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
      .select("order_id, assigned_email, amount, status, payment_status, promo_code_id, slickpay_invoice_id, items, expires_at, marketing_consent, meta_purchase_sent_at")
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

    let provider;
    try {
      provider = await fetchSlickPayInvoice(order.slickpay_invoice_id, 15_000);
    } catch (error) {
      req.log?.error({
        orderId,
        reason: (error as Error)?.name === "AbortError" ? "timeout" : "invalid_response",
      }, "Payment verification provider request failed");
      void recordPaymentFailure("blocked", orderId);
      res.status(502).json({ error: "La vérification du paiement est momentanément indisponible." });
      return;
    }

    const paymentState = provider.state;
    const providerAmount = provider.amount;

    if (providerAmount === null) {
      req.log?.error({ orderId }, "SlickPay response did not include a numeric amount");
      await notifyAdmin(`Montant SlickPay absent pour la commande ${orderId}.`, {
        level: "critical",
        orderId,
        dedupeKey: `amount-missing-${orderId}`,
      });
      void recordPaymentFailure("blocked", orderId);
      res.status(409).json({ error: "Le montant du paiement n'a pas pu être vérifié." });
      return;
    }

    if (Math.abs(providerAmount - Number(order.amount)) > 0.001) {
      req.log?.error({ orderId, expected: order.amount, received: providerAmount }, "SlickPay amount mismatch");
      await notifyAdmin(`Montant SlickPay incohérent pour la commande ${orderId}.`, {
        level: "critical",
        orderId,
        dedupeKey: `amount-${orderId}`,
      });
      void recordPaymentFailure("blocked", orderId);
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

    const result = await fulfillVerifiedPayment(order, "slickpay_return");
    res.json({ verified: true, ...result });
  } catch (err) {
    req.log?.error({ errorName: (err as Error)?.name }, "Payment verification failed unexpectedly");
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

router.post("/cron/reconcile-payments", async (req, res): Promise<any> => {
  if (!process.env.CRON_SECRET) return res.status(503).json({ error: "CRON_SECRET non configuré." });
  if (!validCronSecret(req.get("x-cron-secret"))) return res.status(401).json({ error: "Non autorisé" });

  try {
    return res.json(await runPaymentReconciliation(req.log));
  } catch {
    return res.status(503).json({ error: "Réconciliation indisponible." });
  }
});

export default router;
