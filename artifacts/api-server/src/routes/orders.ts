import { Router, type IRouter, Request } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { supabaseAuth as supabase, supabaseAdmin } from "../lib/supabase";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { computeCart } from "../config/prices";
import { runCleanupCycle, checkMailboxHealth } from "../jobs/imapCleanup";
import { deliverPendingActivationNotifications } from "../jobs/activationNotificationDelivery";
import { fulfillPaidOrdersWaitingForStock } from "../jobs/stockFulfillment";
import { runPartnerStockAlerts } from "../jobs/partnerStockAlerts";
import { hasAdminMfa, isAdmin, requireAdmin, type AuthedRequest } from "../middleware/requireAdmin";
import {
  adminOrderItems,
  customerWhatsappFromItems,
  clearClientCredentials,
  manualActivationReady,
  orderItemSummary,
  paidOrderAccessAvailable,
  parseOrderItems,
  publicOrderItems,
  setClientCredentials,
  markClientCredentialsNotified,
} from "../lib/orderItems";
import { notifyAdmin } from "../lib/notifyAdmin";
import { notifyOperations } from "../lib/notifyOperations";
import { summarizeAvailableStock } from "../lib/stockAlerts";
import { appendAuditLog } from "../lib/auditLog";
import { decryptInventorySecret, encryptInventorySecret } from "../lib/inventoryCredentials";
import { isAllowedImapTarget, resolveImapStrategy } from "../lib/imapStrategy";
import { buildAdminOrdersCsv } from "../lib/adminOrderExport";
import {
  extractNetflixCode as extractTrustedNetflixCode,
  isAuthenticNetflix as isTrustedAuthenticNetflix,
  isNetflixSenderAddress,
} from "../lib/netflixValidation";
import {
  calculatePromoDiscount,
  clientPromoHash,
  hashPromoCode,
  normalizePromoCode,
  promoIsActive,
  promoSupportsItems,
  promoUsageExhausted,
} from "../lib/promos";
import { normalizeAlgerianMobile } from "../lib/phone";
import { expiresAtFromItems } from "../lib/payments";
import { loyaltyRenewalDiscount, renewalOffer, sameRenewalItems } from "../lib/renewals";

import { normalizeSnapchatUsername } from "../lib/snapchat";
import { PARTNER_ENABLED, PARTNER_SCHEMA_READY, uuidPattern } from "../config/partnerTiers";
import { fulfillVerifiedPayment } from "../lib/paymentFulfillment";

const router: IRouter = Router();
const MARKETING_CONSENT_VERSION = "2026-07-26";
const INVENTORY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVENTORY_EMAIL_RE = /^[^\s@]{1,64}@[A-Za-z0-9.-]{1,190}$/;
const INVENTORY_SECRET_MAX = 512;
const CLIENT_ACCOUNT_EMAIL_RE = /^[^\s@]{1,64}@[A-Za-z0-9.-]{1,190}$/;
const MANUAL_ACTIVATION_SERVICES = ["spotify", "crunchyroll"] as const;

type ManualActivationService = typeof MANUAL_ACTIVATION_SERVICES[number];

function cartManualActivationServices(items: unknown): ManualActivationService[] {
  if (!Array.isArray(items)) return [];
  return MANUAL_ACTIVATION_SERVICES.filter((service) => items.some((item: any) => {
    const name = String(item?.name || item?.service || "").toLowerCase();
    return name.includes(service);
  }));
}

function checkoutClientCredentials(
  value: unknown,
  service: ManualActivationService,
  whatsapp: string,
): { email: string; password: string; whatsapp: string } {
  const candidate = value && typeof value === "object"
    ? (value as Record<string, any>)[service]
    : null;
  const email = typeof candidate?.email === "string" ? candidate.email.trim().toLowerCase() : "";
  const password = typeof candidate?.password === "string" ? candidate.password : "";
  if (
    !CLIENT_ACCOUNT_EMAIL_RE.test(email)
    || email.length > 254
    || password.length < 1
    || password.length > 256
    || !whatsapp
  ) {
    throw Object.assign(new Error(`Identifiants ${service === "spotify" ? "Spotify" : "Crunchyroll"} manquants ou invalides.`), { statusCode: 400 });
  }
  return { email, password, whatsapp };
}

function inventoryText(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw Object.assign(new Error("Champ de stock invalide."), { statusCode: 400 });
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw Object.assign(new Error("Champ de stock invalide."), { statusCode: 400 });
  }
  return normalized;
}

function inventoryEmail(value: unknown): string {
  const normalized = inventoryText(value, 255)?.toLowerCase() || "";
  if (!INVENTORY_EMAIL_RE.test(normalized)) {
    throw Object.assign(new Error("Adresse e-mail du compte invalide."), { statusCode: 400 });
  }
  return normalized;
}

function inventoryPassword(value: unknown, required: boolean): string | null {
  if (value === null || value === undefined || value === "") {
    if (required) throw Object.assign(new Error("Mot de passe du compte manquant."), { statusCode: 400 });
    return null;
  }
  if (typeof value !== "string" || value.length > INVENTORY_SECRET_MAX) {
    throw Object.assign(new Error("Mot de passe du compte invalide."), { statusCode: 400 });
  }
  return value;
}

function inventoryProfilePin(value: unknown): string | null {
  const normalized = inventoryText(value, 8);
  if (normalized && !/^\d{4,8}$/.test(normalized)) {
    throw Object.assign(new Error("Le code PIN doit contenir entre 4 et 8 chiffres."), { statusCode: 400 });
  }
  return normalized;
}

function inventoryImapSettings(payload: any, accountEmail: string): {
  imap_host: string | null;
  imap_port: number;
  imap_user: string | null;
  imap_password: string | null;
} {
  const imapPassword = inventoryPassword(payload?.imap_password, false);
  // L'hôte et le port sont une configuration d'infrastructure commune gérée
  // dans Render. L'adresse du compte Netflix est sa sous-boîte Hostinger.
  return { imap_host: null, imap_port: 993, imap_user: accountEmail, imap_password: imapPassword };
}

function inventoryProfileName(value: unknown): string {
  const normalized = inventoryText(value, 80);
  if (!normalized) {
    throw Object.assign(new Error("Nom du profil Netflix manquant."), { statusCode: 400 });
  }
  return normalized;
}

function inventoryProfilePinRequired(value: unknown): string {
  const normalized = inventoryProfilePin(value);
  if (!normalized) {
    throw Object.assign(new Error("Code PIN du profil Netflix manquant."), { statusCode: 400 });
  }
  return normalized;
}

function inventoryCanBeReleased(order: { status?: unknown; expires_at?: unknown } | undefined): boolean {
  if (!order) return true;
  if (["completed", "cancelled"].includes(String(order.status || "").toLowerCase())) return true;
  const expiresAt = new Date(String(order.expires_at || "")).getTime();
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function netflixQuantity(items: unknown): number {
  if (!Array.isArray(items)) return 0;
  return items.reduce((total, item: any) => {
    const name = String(item?.name || item?.service || "").trim().toLowerCase();
    if (!name.includes("netflix")) return total;
    const quantity = Number(item?.quantity);
    return total + (Number.isInteger(quantity) && quantity > 0 ? quantity : 1);
  }, 0);
}

const createOrderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === "test" ? 100 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false, default: false },
  message: { error: "Trop de commandes créées, réessayez dans une minute." },
});

const credentialLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de modifications. Réessayez plus tard." },
});

const orderReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de consultations. Réessayez dans une minute." },
});

const credentialReadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de consultations d'identifiants. Réessayez plus tard." },
});

async function getAuthedOrderUser(req: Request) {
  const h = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  const token = /^Bearer\s+(.+)$/i.exec(h)?.[1]?.trim() || "";
  if (!token) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user?.email) return null;
  return { id: data.user.id, email: data.user.email.trim().toLowerCase() };
}

async function getAuthedEmail(req: Request): Promise<string | null> {
  return (await getAuthedOrderUser(req))?.email ?? null;
}

router.post("/create-order", createOrderLimiter, async (req, res) => {
  try {
    const actor = await getAuthedOrderUser(req);
    const email = actor?.email;
    if (!email) {
      res.status(401).json({ error: "Token invalide ou expiré." });
      return;
    }

    const wallet = req.body?.payment_method === "wallet";
    let approvedPartner = false;
    if (PARTNER_ENABLED() && actor?.id) {
      const {data,error} = await supabaseAdmin.from("partner_accounts").select("partner_status")
        .eq("user_id",actor.id).maybeSingle();
      if (error) { res.status(503).json({error:"Impossible de vérifier le compte partenaire."}); return; }
      approvedPartner = data?.partner_status === "APPROVED";
    }
    if ((wallet || req.body?.checkout_key) && !approvedPartner) {
      res.status(403).json({error:"Le portefeuille est réservé aux partenaires approuvés."}); return;
    }
    const { items } = req.body;
    const customerWhatsapp = typeof req.body?.customer_whatsapp === "string"
      ? normalizeAlgerianMobile(req.body.customer_whatsapp.slice(0, 40))
      : "";
    if (req.body?.customer_whatsapp && !customerWhatsapp) {
      res.status(400).json({ error: "Numéro WhatsApp invalide." });
      return;
    }
    const pricing = computeCart(items);
    if (!pricing.ok) {
      res.status(400).json({ error: pricing.error });
      return;
    }

    const rawRenewalOrderId = typeof req.body?.renewal_order_id === "string"
      ? req.body.renewal_order_id.trim()
      : "";
    let renewalOrderId: string | null = null;
    if (rawRenewalOrderId) {
      if (!/^ORD-[A-Za-z0-9-]{6,40}$/.test(rawRenewalOrderId)) {
        res.status(400).json({ error: "Référence de renouvellement invalide." });
        return;
      }
      const { data: renewedOrder, error: renewedOrderError } = await supabaseAdmin
        .from("orders")
        .select("order_id, assigned_email, payment_status, status, items, expires_at")
        .eq("order_id", rawRenewalOrderId)
        .maybeSingle();
      const sameOwner = String(renewedOrder?.assigned_email || "").trim().toLowerCase() === email;
      const requestedNetflixQuantity = netflixQuantity(pricing.cleanItems);
      const renewedNetflixQuantity = netflixQuantity(renewedOrder?.items);
      const offer = renewedOrder ? renewalOffer(renewedOrder) : null;
      if (
        renewedOrderError
        || !renewedOrder
        || !sameOwner
        || renewedOrder.payment_status !== "paid"
        || !["active", "completed"].includes(String(renewedOrder.status))
        || !offer
        || !sameRenewalItems(pricing.cleanItems, renewedOrder.items)
        || requestedNetflixQuantity !== renewedNetflixQuantity
      ) {
        res.status(409).json({ error: "Cette commande ne peut pas être renouvelée." });
        return;
      }

      if (requestedNetflixQuantity > 0) {
        const { count: assignedProfiles, error: assignedProfilesError } = await supabaseAdmin
          .from("inventory")
          .select("id", { count: "exact", head: true })
          .eq("assigned_order_id", rawRenewalOrderId)
          .eq("is_used", true)
          .ilike("service", "%netflix%");
        if (assignedProfilesError) {
          res.status(503).json({ error: "Le renouvellement est momentanément indisponible." });
          return;
        }
        if ((assignedProfiles || 0) !== requestedNetflixQuantity) {
          res.status(409).json({ error: "Le profil Netflix de cette commande n'est plus attribué." });
          return;
        }
      }
      renewalOrderId = rawRenewalOrderId;
    }

    const hasSnapchat = pricing.cleanItems.some(item => item.name.toLowerCase().includes("snapchat"));
    const snapchatUsername = hasSnapchat ? normalizeSnapchatUsername(req.body?.snapchat_username) : null;
    if (hasSnapchat && (!snapchatUsername || req.body?.snapchat_friend_added !== true)) {
      res.status(400).json({ error: "Renseigne ton nom d’utilisateur Snapchat et confirme l’ajout de @aura-stream." });
      return;
    }
    const manualServices = cartManualActivationServices(pricing.cleanItems);
    if ((manualServices.length > 0 || hasSnapchat) && !customerWhatsapp) {
      res.status(400).json({ error: "Le numéro WhatsApp est requis pour une activation manuelle." });
      return;
    }
    let orderItems: any[] = pricing.cleanItems.map(item => hasSnapchat && item.name.toLowerCase().includes("snapchat")
      ? { ...item, snapchat_username: snapchatUsername, snapchat_friend_added: true } : item);
    try {
      for (const service of manualServices) {
        orderItems = setClientCredentials(
          orderItems,
          service,
          checkoutClientCredentials(req.body?.activation_credentials, service, customerWhatsapp || ""),
        );
      }
    } catch (error: any) {
      if (error?.statusCode === 400) {
        res.status(400).json({ error: error.message });
        return;
      }
      req.log?.error({ errorName: error?.name }, "Unable to encrypt checkout activation credentials");
      res.status(503).json({ error: "Le stockage sécurisé des identifiants n'est pas configuré." });
      return;
    }

    const { count: pendingOrderCount, error: pendingCountError } = approvedPartner ? {count:null,error:null} : await supabaseAdmin
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("assigned_email", email)
      .eq("status", "pending")
      .eq("payment_status", "unpaid");
    if (pendingCountError) {
      req.log?.error({ code: pendingCountError.code }, "Unable to count pending unpaid orders");
      res.status(503).json({ error: "La création de commande est momentanément indisponible." });
      return;
    }
    if ((pendingOrderCount || 0) >= 3) {
      res.status(429).json({ error: "Trop de paiements en attente. Réessayez dans 30 minutes." });
      return;
    }

    const orderId = "ORD-" + crypto.randomUUID();
    const marketingConsent = req.body?.marketing_consent === true;
    if (
      marketingConsent
      && req.body?.marketing_consent_version !== MARKETING_CONSENT_VERSION
    ) {
      res.status(400).json({ error: "Version du consentement marketing invalide." });
      return;
    }

    const promoCode = req.body?.promo_code === undefined ? null : normalizePromoCode(req.body.promo_code);
    if (req.body?.promo_code !== undefined && !promoCode) {
      res.status(400).json({ error: "Code promo invalide." });
      return;
    }
    if (renewalOrderId && promoCode) {
      res.status(400).json({ error: "La remise fidélité ne peut pas être cumulée avec un code promo." });
      return;
    }
    let promo: any = null;
    let discountAmount = 0;
    if (promoCode) {
      const { data: candidate, error: promoError } = await supabaseAdmin
        .from("promo_codes")
        .select("id, discount_type, discount_value, starts_at, ends_at, max_uses, max_uses_per_client, services, active")
        .eq("code_hash", hashPromoCode(promoCode))
        .eq("active", true)
        .single();
      if (promoError || !candidate || !promoIsActive(candidate) || !promoSupportsItems(candidate, pricing.cleanItems)) {
        res.status(400).json({ error: "Code promo invalide ou non applicable." });
        return;
      }
      const { data: usageRows, error: usageError } = await supabaseAdmin.rpc("get_promo_usage", {
        p_promo_code_id: candidate.id,
        p_client_hash: clientPromoHash(email),
      });
      const usage = Array.isArray(usageRows) ? usageRows[0] : usageRows;
      if (usageError || promoUsageExhausted(candidate, usage)) {
        res.status(400).json({ error: "Code promo épuisé." });
        return;
      }
      promo = candidate;
      discountAmount = calculatePromoDiscount(pricing.amount, candidate);
    }
    if (renewalOrderId) {
      discountAmount = loyaltyRenewalDiscount(pricing.amount);
    }
    const finalAmount = Math.max(0, pricing.amount - discountAmount);

    const draft = {
      order_id: orderId,
      assigned_email: email,
      items: orderItems,
      amount: finalAmount,
      subtotal_amount: pricing.amount,
      discount_amount: discountAmount,
      promo_code_id: promo?.id || null,
      renewal_order_id: renewalOrderId,
      status: "pending",
      payment_status: "unpaid",
      marketing_consent: marketingConsent,
      marketing_consent_at: marketingConsent ? new Date().toISOString() : null,
      consent_version: marketingConsent ? MARKETING_CONSENT_VERSION : null,
      customer_whatsapp: customerWhatsapp || null,
    };

    if (approvedPartner) {
      const key = req.body?.checkout_key;
      const expected = req.body?.expected_total;
      if (typeof key !== "string" || !uuidPattern.test(key) || typeof expected !== "number" || !Number.isFinite(expected) || expected < 0) {
        res.status(409).json({error:"Actualise les prix partenaire avant de payer.",code:"PARTNER_QUOTE_REQUIRED"}); return;
      }
      const {data:order,error} = await supabaseAdmin.rpc("create_partner_order",{
        p_user:actor!.id,p_key:key,p_order:draft,p_wallet:wallet,p_expected:expected,
        p_promo_client_hash:clientPromoHash(email),
      });
      if (error) {
        const code = String(error.message || "");
        const failures: Record<string,[number,string]> = {
          PARTNER_QUOTE_CHANGED:[409,"Le tarif a changé. Consulte le nouveau total avant de continuer."],
          WALLET_INSUFFICIENT_BALANCE:[409,"Ton solde est insuffisant."],
          PARTNER_REQUEST_CONFLICT:[409,"Cette tentative de paiement existe déjà."],
          PARTNER_PROMO_UNAVAILABLE:[409,"Ce code promo n’est plus disponible."],
          PARTNER_USE_WALLET:[409,"Utilise le portefeuille pour valider cette commande à 0 DA."],
          PARTNER_NOT_APPROVED:[403,"Candidature partenaire non approuvée."],
        };
        const failure=failures[code];
        if (failure) {res.status(failure[0]).json({error:failure[1],code});return;}
        if (code.includes("PENDING_ORDER_LIMIT")) {
          res.status(429).json({error:"Trop de paiements en attente. Réessayez dans 30 minutes."});return;
        }
        req.log?.error({code:error.code},"Partner order transaction failed");
        res.status(503).json({error:"La création de la commande est momentanément indisponible."});return;
      }
      if (wallet && order.payment_status === "paid" && order.order_status === "pending" && !order.replayed) {
        try {
          const result = await fulfillVerifiedPayment({
            order_id:order.order_id,assigned_email:email,items:orderItems,amount:order.amount,
            status:"pending",payment_status:"paid",renewal_order_id:renewalOrderId,marketing_consent:marketingConsent,
          },"partner_wallet",{paymentTransitioned:true});
          Object.assign(order,result);
        } catch {
          // The paid order is durable; existing stock, activation and email jobs can recover.
          req.log?.warn({orderId:order.order_id},"Wallet order awaiting fulfillment retry");
        }
      }
      res.status(order.replayed ? 200 : 201).json(order);return;
    }

    const { data: inserted, error: insertError } = await supabaseAdmin.from("orders").insert(draft).select("order_id");

    if (insertError) {
      if (insertError.message?.includes("PENDING_ORDER_LIMIT")) {
        res.status(429).json({ error: "Trop de paiements en attente. Réessayez dans 30 minutes." });
        return;
      }
      req.log?.error({ code: insertError.code }, "Supabase error creating order");
      res.status(500).json({ error: "Erreur lors de la création de la commande." });
      return;
    }

    if (!inserted || inserted.length === 0) {
      console.error("[create-order] Insert returned 0 rows. RLS may be blocking inserts. Check that SUPABASE_KEY is the service_role key, not the anon key.");
      res.status(500).json({ error: "La commande n'a pas pu être enregistrée. Contactez le support." });
      return;
    }

    res.status(201).json({ order_id: orderId, amount: finalAmount, subtotal: pricing.amount, discount: discountAmount });
  } catch (err) {
    req.log?.error({ err }, "Unexpected error in POST /create-order");
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

router.get("/my-orders", orderReadLimiter, async (req, res): Promise<any> => {
  try {
    const email = await getAuthedEmail(req);
    if (!email) {
      res.status(401).json({ error: "Token invalide ou expiré." });
      return;
    }

    const { data: orders, error } = await supabaseAdmin
      .from("orders")
      .select("id, order_id, assigned_email, amount, status, payment_status, items, created_at, expires_at, activated_at")
      .eq("assigned_email", email)
      .eq("payment_status", "paid")
      .in("status", ["pending", "active", "completed"])
      .order("created_at", { ascending: false });

    if (error) {
      req.log?.error({ error }, "Supabase error fetching orders");
      res.status(500).json({ error: "Erreur lors de la récupération." });
      return;
    }

    if (!orders || orders.length === 0) {
      return res.json({ orders: [] });
    }

    const orderIds = orders.map((o: any) => o.order_id || o.id).filter(Boolean);
    const { data: accounts } = await supabaseAdmin
      .from("inventory")
      .select("id, assigned_order_id, account_email, profile_name, profile_pin, service")
      .in("assigned_order_id", orderIds);

    const accountsByOrderId = new Map<string, any[]>();
    for (const account of accounts || []) {
      const orderId = String(account.assigned_order_id || "");
      if (!orderId) continue;
      accountsByOrderId.set(orderId, [...(accountsByOrderId.get(orderId) || []), account]);
    }

    const enrichedOrders = orders.map((o: any) => {
      const assignedAccounts = accountsByOrderId.get(o.order_id) || accountsByOrderId.get(o.id) || [];
      const netflixQuantity = publicOrderItems(o.items).reduce((total: number, item: any) => {
        const name = String(item?.name || item?.service || "").toLowerCase();
        return total + (name.includes("netflix") ? Math.max(1, Number(item?.quantity) || 1) : 0);
      }, 0);
      const accessAvailable = paidOrderAccessAvailable(o);
      const publicAccounts = accessAvailable
        ? assignedAccounts.map((acc: any) => ({
            id: String(acc.id),
            email: acc.account_email,
            profile_name: acc.profile_name ?? null,
            profile_pin: decryptInventorySecret(acc.profile_pin),
            service: acc.service,
          }))
        : [];
      return {
        ...o,
        items: publicOrderItems(o.items),
        renewal_offer: renewalOffer(o),
        waiting_for_stock:
          o.status === "pending" && o.payment_status === "paid" && netflixQuantity > assignedAccounts.length,
        accounts: publicAccounts,
        // Kept for compatibility with clients deployed before multi-profile support.
        account: publicAccounts[0] || null,
      };
    });

    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Vary", "Authorization");
    res.json({ orders: enrichedOrders });
  } catch (err) {
    req.log?.error({ err }, "Unexpected error in GET /my-orders");
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

router.get("/validate-order", orderReadLimiter, async (req, res): Promise<any> => {
  try {
    const email = await getAuthedEmail(req);
    const orderId = String(req.query.id || "");
    if (!/^ORD-[A-Za-z0-9-]{6,40}$/.test(orderId)) {
      return res.status(400).json({ error: "Identifiant de commande invalide." });
    }

    const { data: order, error: fetchError } = await supabaseAdmin
      .from("orders")
      .select("order_id, status, payment_status, assigned_email, expires_at, amount, items")
      .eq("order_id", orderId)
      .single();

    if (fetchError || !order) {
      return res.status(404).json({ error: "Commande introuvable." });
    }

    if (!email || order.assigned_email?.toLowerCase() !== email.toLowerCase()) {
      return res.status(403).json({ error: "Accès refusé." });
    }

    return res.json({
      status: order.status,
      payment_status: order.payment_status,
      expires_at: order.expires_at,
      amount: order.amount,
      items: publicOrderItems(order.items),
    });
  } catch (err) {
    req.log?.error({ err }, "Validation error");
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

function validCronSecret(header: string | undefined): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  if (!header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post("/cron/reminders", async (req, res): Promise<any> => {
  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ error: "CRON_SECRET non configuré." });
  }
  if (!validCronSecret(req.get("x-cron-secret"))) {
    return res.status(401).json({ error: "Non autorisé" });
  }
  try {
    const now = new Date();
    const threeDaysFromNow = new Date();
    threeDaysFromNow.setDate(now.getDate() + 3);
    const twoDaysFromNow = new Date();
    twoDaysFromNow.setDate(now.getDate() + 2);
    
    const { data: expiringOrders, error } = await supabaseAdmin
      .from("orders")
      .select("order_id, assigned_email, items, expires_at, status, payment_status")
      .eq("status", "active")
      .eq("payment_status", "paid")
      .lte("expires_at", threeDaysFromNow.toISOString())
      .gt("expires_at", twoDaysFromNow.toISOString());
      
    if (error) {
      req.log.error({ error }, "Error fetching expiring orders");
      res.status(500).json({ error: "Erreur interne du serveur." });
      return;
    }
    
    if (!expiringOrders || expiringOrders.length === 0) {
      res.json({ message: "Aucun rappel nécessaire aujourd'hui." });
      return;
    }
    
    let sentCount = 0;
    for (const order of expiringOrders) {
      const message = `Bonjour Aura Stream ! Mon abonnement se termine dans 3 jours et je souhaite le renouveler pour ne pas perdre l'accès.`;
      const waLink = `https://wa.me/?text=${encodeURIComponent(message)}`;

      const sent = await notifyAdmin(
        `Rappel d'expiration imminente (J-3). Articles : ${orderItemSummary(order.items)}. Expire le ${new Date(order.expires_at).toLocaleDateString("fr-FR")}. Contacter le client sur WhatsApp : ${waLink}`,
        {
          level: "warning",
          orderId: order.order_id,
          email: order.assigned_email,
          dedupeKey: `expiration-j3-${order.order_id}`,
        },
      );
      if (sent) sentCount++;
    }
    
    res.json({ message: `${sentCount} rappel(s) envoyé(s) sur Discord.` });
  } catch (err) {
    req.log.error({ err }, "Cron error");
    res.status(500).json({ error: "Erreur interne" });
  }
});

router.post("/cron/stock-alerts", async (req, res): Promise<any> => {
  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ error: "CRON_SECRET non configuré." });
  }
  if (!validCronSecret(req.get("x-cron-secret"))) {
    return res.status(401).json({ error: "Non autorisé" });
  }

  const rawThreshold = Number.parseInt(process.env.LOW_STOCK_THRESHOLD || "2", 10);
  const threshold = Number.isFinite(rawThreshold) ? Math.max(0, Math.min(rawThreshold, 100)) : 2;
  try {
    const { data, error } = await supabaseAdmin
      .from("inventory")
      .select("service, is_used")
      .ilike("service", "netflix")
      .eq("is_used", false);
    if (error) throw error;

    const summary = summarizeAvailableStock(data || [], threshold);
    const lowStock = summary.filter((entry) => entry.low);
    const notifications = await Promise.all(lowStock.map((entry) => notifyAdmin(
      `Stock faible : ${entry.available} compte(s) disponible(s), seuil ${entry.threshold}. Réapprovisionnement recommandé.`,
      {
        level: entry.available === 0 ? "critical" : "warning",
        service: entry.service,
        dedupeKey: `low-stock-${entry.service}-${entry.available}`,
      },
    )));

    return res.json({
      checked: summary.length,
      low_stock: lowStock,
      notifications_sent: notifications.filter(Boolean).length,
    });
  } catch (err) {
    req.log?.error({ err }, "Stock alert cron failed");
    return res.status(500).json({ error: "Impossible de vérifier le stock." });
  }
});

router.get("/admin/orders-export.csv", orderReadLimiter, requireAdmin, async (req: AuthedRequest, res): Promise<any> => {
  try {
    const orders: any[] = [];
    const pageSize = 1000;
    const maxRows = 10_000;

    for (let offset = 0; offset < maxRows; offset += pageSize) {
      const { data, error } = await supabaseAdmin
        .from("orders")
        .select("order_id, assigned_email, customer_whatsapp, amount, status, payment_status, items, created_at, expires_at, activated_at")
        .order("created_at", { ascending: false })
        .range(offset, offset + pageSize - 1);
      if (error) {
        req.log?.error({ error }, "Admin Excel export query failed");
        return res.status(503).json({ error: "L’export Excel est momentanément indisponible." });
      }
      const page = data || [];
      orders.push(...page.map((order: any) => ({ ...order, items: adminOrderItems(order.items) })));
      if (page.length < pageSize) break;
    }

    const csv = buildAdminOrdersCsv(orders);
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="suivi-abonnements-${date}.csv"`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (orders.length >= maxRows) res.setHeader("X-Export-Truncated", "true");

    void appendAuditLog({
      action: "admin_orders_export",
      actorUserId: req.adminUserId,
      targetType: "orders",
      details: { rows: orders.length, format: "excel_csv" },
    });
    return res.send(`\uFEFF${csv}`);
  } catch (err) {
    req.log?.error({ err }, "Unexpected error in GET /admin/orders-export.csv");
    return res.status(500).json({ error: "Impossible de générer l’export Excel." });
  }
});

router.get("/admin/all-orders", requireAdmin, async (req, res): Promise<any> => {
  try {
    const rawPage = Number.parseInt(String(req.query.page || "1"), 10);
    const rawPageSize = Number.parseInt(String(req.query.limit || req.query.page_size || "50"), 10);
    const page = Number.isFinite(rawPage) ? Math.max(1, Math.min(rawPage, 10_000)) : 1;
    const pageSize = Number.isFinite(rawPageSize) ? Math.max(1, Math.min(rawPageSize, 100)) : 50;
    const rawStatusFilter = typeof req.query.status === "string" ? req.query.status : "";
    const statusFilter = ["pending", "active", "cancelled", "completed"].includes(rawStatusFilter)
      ? rawStatusFilter
      : null;
    const followUpFilter = ["disconnect", "expiring"].includes(rawStatusFilter) ? rawStatusFilter : null;
    const search = typeof req.query.search === "string"
      ? req.query.search.replace(/[^a-zA-Z0-9@._+\- ]/g, " ").trim().slice(0, 120)
      : "";
    const requestedService = typeof req.query.service === "string" ? req.query.service.trim() : "";
    const service = ["Netflix", "Spotify", "Crunchyroll", "Snapchat"].includes(requestedService) ? requestedService : "";
    const parseQueryDate = (value: unknown): string => {
      if (typeof value !== "string" || !value.trim()) return "";
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
    };
    const dateFrom = parseQueryDate(req.query.date_from);
    const dateTo = parseQueryDate(req.query.date_to);
    const sort = typeof req.query.sort === "string" ? req.query.sort : "created_at_desc";
    const sortConfig: Record<string, { column: string; ascending: boolean }> = {
      created_at_desc: { column: "created_at", ascending: false },
      created_at_asc: { column: "created_at", ascending: true },
      amount_desc: { column: "amount", ascending: false },
      amount_asc: { column: "amount", ascending: true },
    };
    const selectedSort = sortConfig[sort] || sortConfig.created_at_desc;
    const buildOrdersQuery = () => {
      let query = supabaseAdmin
        .from("orders")
        .select("id, order_id, assigned_email, customer_whatsapp, amount, status, payment_status, items, created_at, expires_at, activated_at"
          + (PARTNER_SCHEMA_READY() ? ",partner_wallet_paid,partner_wallet_refunded_at" : ""), { count: "exact" })
        .order(selectedSort.column, { ascending: selectedSort.ascending });
      if (statusFilter) query = query.eq("status", statusFilter);
      if (followUpFilter) {
        const now = new Date();
        query = query.eq("status", "active").eq("payment_status", "paid");
        if (followUpFilter === "disconnect") query = query.lte("expires_at", now.toISOString());
        if (followUpFilter === "expiring") {
          const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
          query = query.gt("expires_at", now.toISOString()).lte("expires_at", threeDaysFromNow.toISOString());
        }
      }
      if (search) query = query.or(`order_id.ilike.%${search}%,assigned_email.ilike.%${search}%`);
      if (dateFrom) query = query.gte("created_at", dateFrom);
      if (dateTo) query = query.lte("created_at", dateTo);
      return query;
    };

    const offset = (page - 1) * pageSize;
    let data: any[] | null = null;
    let error: any = null;
    let count: number | null = 0;
    if (service) {
      // Partial text matching inside a JSON/JSONB array is not expressed
      // reliably through the Data API. Apply every safe database filter first,
      // then inspect a bounded administrator-only result set before paginating.
      const serviceResult = await buildOrdersQuery().range(0, 9_999);
      error = serviceResult.error;
      if (!error) {
        const filtered = (serviceResult.data || []).filter((order: any) =>
          parseOrderItems(order.items).some((item: any) =>
            String(item?.name || item?.service || "").toLowerCase().includes(service.toLowerCase()),
          ),
        );
        data = filtered.slice(offset, offset + pageSize);
        count = filtered.length;
      }
    } else {
      const result = await buildOrdersQuery().range(offset, offset + pageSize - 1);
      data = result.data;
      error = result.error;
      count = result.count;
    }

    if (error) {
      req.log.error({ error }, "Supabase error fetching all orders");
      res.status(500).json({ error: "Erreur lors de la récupération des commandes." });
      return;
    }

    res.json({ orders: (data || []).map((order: any) => {
      const adminItems = adminOrderItems(order.items);
      return {
        ...order,
        customer_whatsapp: order.customer_whatsapp || customerWhatsappFromItems(order.items),
        items: adminItems,
      };
    }), total: count || 0, page, limit: pageSize, total_pages: Math.ceil((count || 0) / pageSize) });
  } catch (err) {
    req.log.error({ err }, "Unexpected error in GET /admin/all-orders");
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

router.post("/admin/update-order-status", requireAdmin, async (req: AuthedRequest, res): Promise<any> => {
  try {
    const { order_id, status } = req.body;
    if (!order_id || !status) return res.status(400).json({ error: "Action de commande manquante." });
    if (typeof order_id !== "string" || !/^ORD-[A-Za-z0-9-]{6,40}$/.test(order_id)) {
      return res.status(400).json({ error: "Identifiant de commande invalide." });
    }
    if (status && !['pending', 'active', 'completed', 'cancelled'].includes(status)) return res.status(400).json({ error: "Statut invalide." });

    if (PARTNER_SCHEMA_READY()) {
      const {data: walletOrder,error: walletError}=await supabaseAdmin.from("orders")
        .select("partner_wallet_paid,partner_wallet_refunded_at,status").eq("order_id",order_id).maybeSingle();
      if (walletError) return res.status(503).json({error:"Impossible de vérifier le paiement portefeuille."});
      if (walletOrder?.partner_wallet_paid && walletOrder.partner_wallet_refunded_at) {
        return status === "cancelled"
          ? res.json({success:true,status:"cancelled",wallet_refunded:true})
          : res.status(409).json({error:"Une commande remboursée ne peut pas être réactivée."});
      }
      if (walletOrder?.partner_wallet_paid && status === "cancelled") {
        const {error}=await supabaseAdmin.rpc("refund_partner_wallet_order",{p_order:order_id});
        if (error?.message==="WALLET_REFUND_NOT_ELIGIBLE") return res.status(409).json({error:"Cette commande a déjà été livrée ou un profil lui est attribué."});
        if (error) return res.status(503).json({error:"Le remboursement n’a pas pu être confirmé."});
        void appendAuditLog({action:"partner_wallet_refund",actorUserId:req.adminUserId,targetType:"order",targetId:order_id});
        return res.json({success:true,status:"cancelled",wallet_refunded:true});
      }
    }

    let { data: currentOrder, error: currentOrderError } = await supabaseAdmin
      .from("orders")
      .select("order_id, assigned_email, status, payment_status, promo_code_id, items, amount, expires_at, activated_at, marketing_consent, meta_purchase_sent_at, activation_revision")
      .eq("order_id", order_id)
      .single();
    if (currentOrderError || !currentOrder) return res.status(404).json({ error: "Commande introuvable." });

    if (status === "active" && currentOrder.payment_status !== "paid") {
      return res.status(409).json({ error: "Impossible d'activer une commande dont le paiement n'est pas confirmé." });
    }
    if (status === "active") {
      const parsedItems = parseOrderItems(currentOrder.items);
      const netflixQuantity = parsedItems.reduce((total: number, item: any) => {
        const name = String(item?.name || item?.service || "").toLowerCase();
        return total + (name.includes("netflix") ? Math.max(1, Number(item?.quantity) || 1) : 0);
      }, 0);
      if (netflixQuantity > 0) {
        const { count: assignedCount, error: inventoryError } = await supabaseAdmin
          .from("inventory")
          .select("id", { count: "exact", head: true })
          .eq("assigned_order_id", order_id)
          .eq("is_used", true)
          .ilike("service", "%netflix%");
        if (inventoryError) return res.status(503).json({ error: "Impossible de vérifier l'attribution du stock." });
        if ((assignedCount || 0) < netflixQuantity) {
          return res.status(409).json({ error: "Impossible d'activer Netflix sans profil attribué." });
        }
      }
      if (!manualActivationReady(currentOrder.items)) {
        return res.status(409).json({ error: "Les informations du compte doivent être reçues avant l’activation." });
      }
    }
    if (status === "completed" && currentOrder.payment_status !== "paid") {
      return res.status(409).json({ error: "Impossible de terminer une commande dont le paiement n'est pas confirmé." });
    }

    const update: Record<string, any> = { status };
    if (status === "pending" && currentOrder.payment_status === "failed") update.payment_status = "unpaid";
    if (status === "active") {
      update.activated_at = currentOrder.activated_at || new Date().toISOString();
      update.expires_at = currentOrder.expires_at || expiresAtFromItems(parseOrderItems(currentOrder.items));
      update.items = clearClientCredentials(currentOrder.items, new Date().toISOString());
      update.completed_at = null;
    }
    if (status === "completed") update.completed_at = new Date().toISOString();
    if (status === "cancelled" && currentOrder.payment_status !== "paid") update.payment_status = "failed";
    const { data: changedOrder, error: updateError } = await supabaseAdmin
      .from("orders")
      .update(update)
      .eq("order_id", order_id)
      .eq("activation_revision", currentOrder.activation_revision)
      .select("order_id");

    if (updateError) {
      req.log.error({ updateError }, "Supabase error updating order status");
      return res.status(500).json({ error: "Erreur lors de la mise à jour." });
    }
    if (!changedOrder?.length) return res.status(409).json({ error: "La commande a changé. Actualise la page et réessaie." });

    void appendAuditLog({
      action: "admin_order_status_update",
      actorUserId: req.adminUserId,
      targetType: "order",
      targetId: order_id,
      details: { status },
    });
    res.json({ success: true, status: status });
  } catch (err) {
    req.log.error({ err }, "Unexpected error in POST /admin/update-order-status");
    res.status(500).json({ error: "Erreur interne." });
  }
});

// GET user credentials from inventory
router.get("/my-credentials", credentialReadLimiter, async (req, res): Promise<void> => {
  try {
    const email = await getAuthedEmail(req);
    if (!email) {
      res.status(401).json({ error: "Token invalide." });
      return;
    }

    const { data: userOrders, error: ordersError } = await supabaseAdmin
      .from("orders")
      .select("order_id")
      .eq("assigned_email", email)
      .eq("status", "active")
      .eq("payment_status", "paid")
      .gt("expires_at", new Date().toISOString());

    if (ordersError) {
      res.status(500).json({ error: "Erreur serveur" });
      return;
    }
    if (!userOrders || userOrders.length === 0) {
      res.json({ credentials: [] });
      return;
    }

    const orderIds = userOrders.map((o) => o.order_id);

    const { data: credentials, error } = await supabaseAdmin
      .from("inventory")
      .select("assigned_order_id, account_email, account_password, service, profile_name, profile_pin")
      .in("assigned_order_id", orderIds);

    if (error) {
      res.status(500).json({ error: "Erreur serveur" });
      return;
    }

    const cleanCredentials = (credentials || []).map((c: any) => {
      const isNetflix = c.service?.toLowerCase().includes("netflix");
      return {
        assigned_order_id: c.assigned_order_id,
        account_email: c.account_email,
        account_password: isNetflix ? null : decryptInventorySecret(c.account_password),
        service: c.service,
        profile_name: c.profile_name ?? null,
        profile_pin: decryptInventorySecret(c.profile_pin),
      };
    });

    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Vary", "Authorization");
    res.json({ credentials: cleanCredentials });
  } catch (err) {
    req.log?.error({ err }, "Error fetching credentials");
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// POST client credentials into order.items
router.post("/client-credentials", credentialLimiter, async (req, res): Promise<any> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !/^Bearer\s+/i.test(authHeader)) return res.status(401).json({ error: "Token manquant" });
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user?.email) return res.status(401).json({ error: "Token invalide." });

    const { order_id, service, email, password, whatsapp } = req.body;
    const normalizedService = typeof service === "string" ? service.trim().toLowerCase() : "";
    const normalizedEmail = typeof email === "string" ? email.trim() : "";
    const normalizedPassword = typeof password === "string" ? password : "";
    const normalizedWhatsapp = typeof whatsapp === "string" ? normalizeAlgerianMobile(whatsapp.slice(0, 40)) : "";
    if (typeof order_id !== "string" || !/^ORD-[A-Za-z0-9-]{6,40}$/.test(order_id) || !["spotify", "crunchyroll"].includes(normalizedService) || !normalizedEmail || !normalizedPassword || !normalizedWhatsapp || normalizedEmail.length > 254 || normalizedPassword.length > 256 || normalizedWhatsapp.length > 40) {
      return res.status(400).json({ error: "Données manquantes" });
    }

    const { data: order, error: orderError } = await supabaseAdmin.from("orders").select("order_id, assigned_email, status, payment_status, items, activation_revision").eq("order_id", order_id).single();
    if (orderError || !order) return res.status(404).json({ error: "Commande introuvable" });
    if (order.assigned_email?.toLowerCase() !== userData.user.email.toLowerCase()) return res.status(403).json({ error: "Accès refusé" });
    if (order.payment_status !== "paid" || order.status !== "pending") return res.status(409).json({ error: "Cette activation n'est plus modifiable." });

    // Update items with credentials
    const items = parseOrderItems(order.items);
    
    const serviceItemExists = items.some((item: any) => typeof item?.name === "string" && item.name.toLowerCase().includes(normalizedService));
    if (!serviceItemExists) return res.status(400).json({ error: "Service non présent dans cette commande." });

    let updatedItems: any[];
    try {
      updatedItems = setClientCredentials(order.items, normalizedService, {
        email: normalizedEmail,
        password: normalizedPassword,
        whatsapp: normalizedWhatsapp,
      });
    } catch {
      return res.status(503).json({ error: "Le stockage sécurisé des identifiants n'est pas configuré." });
    }

    const { data: updated, error: updateError } = await supabaseAdmin.from("orders")
      .update({ items: updatedItems, customer_whatsapp: normalizedWhatsapp })
      .eq("order_id", order_id)
      .eq("assigned_email", userData.user.email)
      .eq("payment_status", "paid")
      .eq("status", "pending")
      .eq("activation_revision", order.activation_revision)
      .select("activation_revision");
    if (updateError) throw updateError;
    if (!updated?.length) return res.status(409).json({ error: "La commande n'est plus modifiable." });

    const frontendUrl = (process.env.FRONTEND_URL || "https://www.aura-stream.com").replace(/\/$/, "");
    const validationLink = `${frontendUrl}/?admin=true`;
    const discordSent = await notifyOperations(
      `Nouveau compte ${normalizedService} à activer. Ouvre le panneau administrateur : ${validationLink}`,
      {
        orderId: order_id,
        service: normalizedService,
      },
    );

    let notificationRecorded = false;
    if (discordSent) {
      const notifiedItems = markClientCredentialsNotified(updatedItems, normalizedService);
      const { data: recorded } = await supabaseAdmin.from("orders")
        .update({ items: notifiedItems })
        .eq("order_id", order_id)
        .eq("assigned_email", userData.user.email)
        .eq("payment_status", "paid")
        .eq("status", "pending")
        .eq("activation_revision", updated[0].activation_revision)
        .select("order_id");
      notificationRecorded = Boolean(recorded?.length);
    }

    if (!discordSent || !notificationRecorded) {
      await notifyAdmin(
        "Les identifiants d'activation ont été enregistrés mais leur notification Discord opérationnelle doit être rattrapée.",
        {
          level: "warning",
          orderId: order_id,
          service: normalizedService,
          dedupeKey: `activation-discord-pending-${order_id}-${normalizedService}`,
        },
      );
    }
    void appendAuditLog({
      action: "client_activation_credentials_submitted",
      actorUserId: userData.user.id,
      targetType: "order",
      targetId: order_id,
      details: {
        service: normalizedService,
        discord_sent: discordSent,
        delivery_recorded: notificationRecorded,
      },
    });

    res.status(discordSent && notificationRecorded ? 200 : 202).json({
      success: true,
      notification_sent: discordSent,
      notification_queued: !discordSent || !notificationRecorded,
    });
  } catch (err) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

function recipientMatches(parsed: any, target: string): boolean {
  if (!target) return true;
  const lowerTarget = target.toLowerCase().trim();
  const collect = (addrObj: any): string[] => {
    if (!addrObj) return [];
    const list = Array.isArray(addrObj) ? addrObj : [addrObj];
    return list.flatMap((a: any) => (a.value || []).map((v: any) => (v.address || '').toLowerCase()));
  };

  const addresses = [
    ...collect(parsed.to),
    ...collect(parsed.cc),
    ...collect(parsed.bcc),
  ];

  const headerKeys = ['delivered-to', 'x-envelope-to', 'x-original-to', 'x-forwarded-to'];
  for (const key of headerKeys) {
    const raw = parsed.headers?.get?.(key);
    if (raw) {
      const val = Array.isArray(raw) ? raw.join(' ') : String(raw);
      const headerAddresses = val.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+/gi) || [];
      if (headerAddresses.some((address) => address.toLowerCase() === lowerTarget)) return true;
    }
  }

  return addresses.some(addr => addr === lowerTarget);
}

function isAuthenticNetflix(parsed: any): boolean {
  return isTrustedAuthenticNetflix(parsed);
}

function extractNetflixCode(text: string, html: string, subject?: string): { code?: string; link?: string } {
  return extractTrustedNetflixCode(text, html, subject);
}

const otpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de tentatives. Réessayez dans une minute." },
});

router.post("/get-netflix-otp", otpLimiter, credentialReadLimiter, async (req, res): Promise<any> => {
  const { order_id, inventory_id } = req.body;
  if (typeof order_id !== "string" || !/^ORD-[A-Za-z0-9-]{6,40}$/.test(order_id)) return res.status(400).json({ error: "Identifiant de commande invalide." });
  if (inventory_id !== undefined && (typeof inventory_id !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(inventory_id))) {
    return res.status(400).json({ error: "Identifiant de profil invalide." });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !/^Bearer\s+/i.test(authHeader)) return res.status(401).json({ error: "Token manquant" });
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData?.user?.email) return res.status(401).json({ error: "Token invalide." });

  const { data: order, error: orderError } = await supabaseAdmin.from("orders").select("order_id, assigned_email, status, payment_status, expires_at, items").eq("order_id", order_id).single();
  if (orderError || !order) return res.status(404).json({ error: "Commande introuvable" });
  if (order.assigned_email?.toLowerCase() !== userData.user.email.toLowerCase()) {
    return res.status(404).json({ error: "Commande introuvable" });
  }

  if (!paidOrderAccessAvailable(order)) {
    return res.status(409).json({ error: "Cette commande n'est pas active ou son paiement n'est pas confirmé." });
  }

  let inventoryQuery = supabaseAdmin
    .from("inventory")
    .select("id, account_email, account_password, imap_host, imap_port, imap_user, imap_password, service")
    .eq("assigned_order_id", order_id)
    .eq("is_used", true)
    .ilike("service", "%netflix%");
  if (inventory_id) inventoryQuery = inventoryQuery.eq("id", inventory_id);
  const { data: invItems, error: invError } = await inventoryQuery;

  if (invError) return res.status(500).json({ error: "Erreur serveur" });

  if (!invItems || invItems.length === 0) return res.status(404).json({ error: "Aucun compte Netflix disponible en stock pour cette commande." });

  const netflixAccount = invItems.find((i: any) => i.service.toLowerCase().includes("netflix")) || invItems[0];
  if (!netflixAccount) return res.status(404).json({ error: "Pas de compte Netflix assigné" });

  const strat = resolveImapStrategy(netflixAccount);
  if (!strat.user || !strat.pass) return res.status(400).json({ error: "Identifiants IMAP manquants dans l'inventaire" });
  if (!isAllowedImapTarget(strat.host, netflixAccount.account_email, strat.port)) {
    req.log?.warn({ host: strat.host, port: strat.port }, "Blocked non-allowlisted IMAP target");
    return res.status(400).json({ error: "Serveur IMAP non autorisé." });
  }

  const hostsToTry = [strat.host, strat.host === 'outlook.office365.com' ? 'imap-mail.outlook.com' : ''].filter(Boolean);
  let lastError: any = null;

  for (const host of hostsToTry) {
    const client = new ImapFlow({
      host,
      port: strat.port,
      secure: true,
      tls: { rejectUnauthorized: true },
      auth: { user: strat.user, pass: strat.pass },
      logger: false,
      connectionTimeout: 10_000,
      greetingTimeout: 5_000,
      socketTimeout: 30_000,
      clientInfo: { name: 'AuraStream', version: '1.0.0' }
    });

    client.on('error', (err: any) => {
      req.log?.warn({ host, code: err?.code }, "IMAP client error");
    });

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const since = new Date(Date.now() - 15 * 60 * 1000);
        const targetEmail = netflixAccount.account_email;
        let latest: { code?: string; link?: string; receivedAt: number; uid: number } | undefined;
        const maxMessagesPerAttempt = 20;
        const maxMessageBytes = 256 * 1024;

        for (let attempt = 1; attempt <= 3; attempt++) {
          const matchingUids = await client.search({ since }, { uid: true });
          const newestUids = Array.isArray(matchingUids)
            ? matchingUids.slice(-maxMessagesPerAttempt)
            : [];
          if (newestUids.length === 0) {
            if (attempt < 3) await new Promise(r => setTimeout(r, 2500));
            continue;
          }
          for await (let message of client.fetch(
            newestUids,
            { uid: true, envelope: true, internalDate: true, size: true, source: { maxLength: maxMessageBytes } },
            { uid: true },
          )) {
            if (typeof message.size === "number" && message.size > maxMessageBytes) continue;
            // IMAP SINCE filters by calendar day, so enforce the full timestamp here.
            const receivedAt = message.internalDate ? new Date(message.internalDate).getTime() : NaN;
            if (!Number.isFinite(receivedAt) || receivedAt < since.getTime() || receivedAt > Date.now()) continue;
            if (message.envelope?.from?.some((f: any) => isNetflixSenderAddress(f.address))) {
              const parsed = await simpleParser(message.source as any);
              if (targetEmail && !recipientMatches(parsed, targetEmail)) continue;
              if (!isAuthenticNetflix(parsed)) continue;

              const { code, link } = extractNetflixCode(parsed.text || '', (parsed as any).html || '', parsed.subject);
              if ((code || link) && (!latest || receivedAt > latest.receivedAt ||
                (receivedAt === latest.receivedAt && message.uid > latest.uid))) {
                latest = { code, link, receivedAt, uid: message.uid };
              }
            }
          }

          if (latest) break;
          if (attempt < 3) await new Promise(r => setTimeout(r, 2500));
        }

        if (latest) {
          return res.json({ success: true, code: latest.code ?? null, link: latest.link ?? null });
        } else {
          return res.status(404).json({ error: "Aucun email Netflix récent trouvé. Assurez-vous d'avoir demandé le code sur Netflix puis réessayez dans quelques secondes." });
        }
      } finally {
        lock.release();
      }
    } catch (err: any) {
      lastError = err;
      req.log?.warn({ host, code: err?.code }, "IMAP connection failed");
    } finally {
      try { await client.logout(); } catch {}
    }
  }

  const raw = lastError?.responseText || lastError?.message || '';
  let userMessage = "Impossible de se connecter à la boîte mail.";
  if (/AUTHENTICATE failed|AUTHENTICATIONFAILED|invalid credentials/i.test(raw)) {
    userMessage = "Basic Auth refusé par le serveur. Si vous utilisez Outlook, passez ce compte Netflix sur une adresse Gmail (@gmail.com) ou un domaine personnalisé pour débloquer l'IMAP.";
  } else if (/IMAP.*disabled|not enabled/i.test(raw)) {
    userMessage = "L'accès IMAP est désactivé sur ce compte. Activez-le dans les options du fournisseur.";
  }

  return res.status(502).json({ error: userMessage });
});


// Admin inventory routes
router.get("/admin/inventory", requireAdmin, async (req, res): Promise<any> => {
  try {
    const { data, error } = await supabaseAdmin
      .from("inventory")
      .select("id, service, account_email, is_used, assigned_order_id, assigned_at, created_at, profile_name, profile_pin, imap_host, imap_port, imap_user, account_password, imap_password")
      .ilike("service", "netflix")
      .order("created_at", { ascending: false });
    if (error) throw error;

    const assignedOrderIds = [...new Set((data || [])
      .map((item: any) => String(item.assigned_order_id || ""))
      .filter(Boolean))];
    const orderById = new Map<string, { status: string; expires_at: string | null }>();
    if (assignedOrderIds.length > 0) {
      const { data: assignedOrders, error: assignedOrdersError } = await supabaseAdmin
        .from("orders")
        .select("order_id, status, expires_at")
        .in("order_id", assignedOrderIds);
      if (assignedOrdersError) throw assignedOrdersError;
      for (const order of assignedOrders || []) {
        orderById.set(String(order.order_id), {
          status: String(order.status || ""),
          expires_at: order.expires_at || null,
        });
      }
    }
    res.json({
      inventory: (data || []).map((item: any) => {
        const assignedOrder = item.assigned_order_id
          ? orderById.get(String(item.assigned_order_id))
          : undefined;
        return {
          id: item.id,
          service: item.service,
          account_email: item.account_email,
          is_used: item.is_used,
          assigned_order_id: item.assigned_order_id,
          assigned_at: item.assigned_at,
          created_at: item.created_at,
          profile_name: item.profile_name,
          profile_pin: decryptInventorySecret(item.profile_pin),
          has_account_password: Boolean(item.account_password),
          has_imap_password: Boolean(item.imap_password),
          order_status: assignedOrder?.status || null,
          order_expires_at: assignedOrder?.expires_at || null,
          releasable: Boolean(item.is_used && item.assigned_order_id && inventoryCanBeReleased(assignedOrder)),
        };
      }),
    });
  } catch (err) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/admin/inventory", requireAdmin, async (req: AuthedRequest, res): Promise<any> => {
  try {
    const MAX_BATCH = 100;

    let rows: any[] = [];
    if (Array.isArray(req.body)) {
      if (req.body.length === 0) return res.status(400).json({ error: "Lot vide." });
      if (req.body.length > MAX_BATCH) return res.status(400).json({ error: `Maximum ${MAX_BATCH} comptes par lot.` });
      rows = req.body;
    } else if (req.body?.profiles !== undefined) {
      if (!Array.isArray(req.body.profiles) || req.body.profiles.length < 1 || req.body.profiles.length > 5) {
        return res.status(400).json({ error: "Ajoute entre 1 et 5 profils Netflix pour ce compte." });
      }
      rows = req.body.profiles.map((profile: any) => {
        if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
          throw Object.assign(new Error("Profil Netflix invalide."), { statusCode: 400 });
        }
        return { ...req.body, profile_name: profile.profile_name, profile_pin: profile.profile_pin };
      });
    } else {
      rows = [req.body];
    }

    const cleanRows = rows.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw Object.assign(new Error("Entrée de stock invalide."), { statusCode: 400 });
      }
      if (String(entry.service || "netflix").trim().toLowerCase() !== "netflix") {
        throw Object.assign(new Error("Seuls les profils Netflix sont gérés dans le stock automatique."), { statusCode: 400 });
      }
      const accountEmail = inventoryEmail(entry.account_email);
      // Netflix est accessible par OTP envoyé à la sous-boîte. Le mot de
      // passe du compte n'est donc qu'un ancien champ facultatif.
      const accountPassword = inventoryPassword(entry.account_password, false);
      const imap = inventoryImapSettings(entry, accountEmail);
      return {
        service: "netflix",
        account_email: accountEmail,
        account_password: encryptInventorySecret(accountPassword),
        imap_host: imap.imap_host,
        imap_port: imap.imap_port,
        imap_user: imap.imap_user,
        imap_password: encryptInventorySecret(imap.imap_password),
        profile_name: inventoryProfileName(entry.profile_name),
        profile_pin: encryptInventorySecret(inventoryProfilePinRequired(entry.profile_pin)),
        is_used: false,
      };
    });

    const { error } = await supabaseAdmin.from("inventory").insert(cleanRows);
    if (error) throw error;
    void appendAuditLog({
      action: "admin_inventory_create",
      actorUserId: req.adminUserId,
      targetType: "inventory",
      details: { count: cleanRows.length, services: [...new Set(cleanRows.map((row) => row.service))] },
    });
    const manualAssignment = req.body?.manual_assignment === true || req.body?.manual_assignment === "true";
    let stockReconciliation = null;
    if (!manualAssignment) {
      try {
        stockReconciliation = await fulfillPaidOrdersWaitingForStock(req.log);
      } catch (reconciliationError) {
        req.log?.warn({ errorName: (reconciliationError as Error)?.name }, "Post-insert stock reconciliation failed");
      }
    }
    res.once("finish",()=>{void runPartnerStockAlerts().catch(()=>req.log?.warn("Partner stock alerts failed"));});
    return res.status(201).json({
      success: true,
      added: cleanRows.length,
      manual_assignment: manualAssignment,
      stock_reconciliation: stockReconciliation,
    });
  } catch (err: any) {
    req.log?.error({ code: err?.code }, "Admin inventory insert failed");
    if (err?.statusCode === 400) return res.status(400).json({ error: err.message });
    if (err?.code === "23505") {
      return res.status(409).json({ error: "Ce profil Netflix existe déjà dans le stock." });
    }
    if (err?.code === "23502" || err?.code === "23514") {
      return res.status(409).json({ error: "Les informations du profil Netflix sont incomplètes ou incohérentes." });
    }
    return res.status(500).json({ error: "Impossible d'ajouter ce profil au stock." });
  }
});

router.get("/admin/inventory/:id/assignment-options", requireAdmin, async (req: AuthedRequest, res): Promise<any> => {
  const inventoryId = String(req.params.id || "");
  if (!INVENTORY_ID_RE.test(inventoryId)) {
    return res.status(400).json({ error: "Identifiant de stock invalide." });
  }

  try {
    const { data: inventory, error: inventoryError } = await supabaseAdmin
      .from("inventory")
      .select("id, service, is_used, assigned_order_id")
      .eq("id", inventoryId)
      .single();
    if (inventoryError || !inventory) return res.status(404).json({ error: "Compte introuvable." });
    if (String(inventory.service || "").trim().toLowerCase() !== "netflix") {
      return res.status(409).json({ error: "Seuls les profils Netflix peuvent être attribués manuellement." });
    }
    if (inventory.is_used || inventory.assigned_order_id) {
      return res.status(409).json({ error: "Ce profil est déjà attribué." });
    }

    const { data: orders, error: ordersError } = await supabaseAdmin
      .from("orders")
      .select("order_id, assigned_email, status, payment_status, amount, items, created_at, expires_at, renewal_order_id")
      .eq("status", "pending")
      .eq("payment_status", "paid")
      .order("created_at", { ascending: true })
      .limit(200);
    if (ordersError) throw ordersError;

    const candidates = (orders || []).filter((order: any) => netflixQuantity(order.items) > 0);
    const orderIds = candidates.map((order: any) => String(order.order_id));
    const assignedByOrder = new Map<string, number>();
    if (orderIds.length > 0) {
      const { data: assignments, error: assignmentsError } = await supabaseAdmin
        .from("inventory")
        .select("assigned_order_id")
        .eq("is_used", true)
        .ilike("service", "%netflix%")
        .in("assigned_order_id", orderIds);
      if (assignmentsError) throw assignmentsError;
      for (const assignment of assignments || []) {
        const orderId = String(assignment.assigned_order_id || "");
        assignedByOrder.set(orderId, (assignedByOrder.get(orderId) || 0) + 1);
      }
    }

    return res.json({
      inventory_id: inventoryId,
      orders: candidates
        .filter((order: any) => (assignedByOrder.get(String(order.order_id)) || 0) < netflixQuantity(order.items))
        .map((order: any) => ({
          order_id: order.order_id,
          assigned_email: order.assigned_email,
          amount: order.amount,
          items: publicOrderItems(order.items),
          created_at: order.created_at,
          expires_at: order.expires_at,
          renewal_order_id: order.renewal_order_id || null,
          assigned_profiles: assignedByOrder.get(String(order.order_id)) || 0,
          required_profiles: netflixQuantity(order.items),
        })),
    });
  } catch (err) {
    req.log?.error({ err }, "Manual inventory assignment options failed");
    return res.status(503).json({ error: "Impossible de charger les commandes éligibles." });
  }
});

router.post("/admin/inventory/:id/assign", requireAdmin, async (req: AuthedRequest, res): Promise<any> => {
  const inventoryId = String(req.params.id || "");
  const orderId = typeof req.body?.order_id === "string" ? req.body.order_id.trim() : "";
  if (!INVENTORY_ID_RE.test(inventoryId)) {
    return res.status(400).json({ error: "Identifiant de stock invalide." });
  }
  if (!/^ORD-[A-Za-z0-9-]{6,40}$/.test(orderId)) {
    return res.status(400).json({ error: "Identifiant de commande invalide." });
  }

  try {
    const { data: order, error: orderError } = await supabaseAdmin
      .from("orders")
      .select("order_id, assigned_email, status, payment_status, items, renewal_order_id")
      .eq("order_id", orderId)
      .maybeSingle();
    if (orderError) throw orderError;
    if (!order) return res.status(404).json({ error: "Commande introuvable." });
    if (order.status !== "pending" || order.payment_status !== "paid") {
      return res.status(409).json({ error: "La commande doit être payée et en attente d’activation." });
    }
    if (netflixQuantity(order.items) < 1) {
      return res.status(409).json({ error: "Cette commande ne contient pas de profil Netflix à attribuer." });
    }

    let renewalBaseDate: string | Date = new Date();
    if (order.renewal_order_id) {
      const { data: sourceOrder, error: sourceError } = await supabaseAdmin
        .from("orders")
        .select("assigned_email, payment_status, status, expires_at")
        .eq("order_id", order.renewal_order_id)
        .maybeSingle();
      const sameOwner = String(sourceOrder?.assigned_email || "").trim().toLowerCase()
        === String(order.assigned_email || "").trim().toLowerCase();
      if (
        sourceError
        || !sourceOrder
        || !sameOwner
        || sourceOrder.payment_status !== "paid"
        || !["active", "completed"].includes(String(sourceOrder.status))
      ) {
        return res.status(409).json({ error: "La commande de renouvellement d’origine n’est plus valide." });
      }
      renewalBaseDate = sourceOrder.expires_at || renewalBaseDate;
    }

    const expiresAt = expiresAtFromItems(parseOrderItems(order.items), renewalBaseDate);
    const { data: assignment, error: assignmentError } = await supabaseAdmin.rpc("assign_inventory_manually", {
      p_inventory_id: inventoryId,
      p_order_id: orderId,
      p_expires_at: expiresAt,
    });
    if (assignmentError) {
      const message = String(assignmentError.message || "");
      if (message.includes("INVENTORY_NOT_AVAILABLE")) return res.status(409).json({ error: "Ce profil n’est plus disponible." });
      if (message.includes("ORDER_NOT_ELIGIBLE")) return res.status(409).json({ error: "Cette commande n’est plus éligible à une attribution." });
      throw assignmentError;
    }
    const result = assignment as any;
    if (result?.result === "inventory_not_available") return res.status(409).json({ error: "Ce profil n’est plus disponible." });
    if (result?.result === "order_not_eligible") return res.status(409).json({ error: "Cette commande n’est plus éligible à une attribution." });
    if (result?.result !== "assigned") return res.status(409).json({ error: "L’attribution n’a pas pu être effectuée." });

    void appendAuditLog({
      action: "admin_inventory_manual_assignment",
      actorUserId: req.adminUserId,
      targetType: "inventory",
      targetId: inventoryId,
      details: { order_id: orderId, expires_at: expiresAt },
    });
    return res.json({ success: true, order_id: orderId, inventory_id: inventoryId, expires_at: expiresAt, assignment: result });
  } catch (err) {
    req.log?.error({ err }, "Manual inventory assignment failed");
    return res.status(503).json({ error: "Impossible d’attribuer ce profil pour le moment." });
  }
});

router.post("/admin/inventory/:id/release", requireAdmin, async (req: AuthedRequest, res): Promise<any> => {
  const inventoryId = String(req.params.id || "");
  if (!INVENTORY_ID_RE.test(inventoryId)) {
    return res.status(400).json({ error: "Identifiant de stock invalide." });
  }
  if (req.body?.confirm_disconnected !== true) {
    return res.status(400).json({ error: "Confirmez d'abord que l'ancien client a été déconnecté du profil." });
  }

  try {
    const { data: item, error: lookupError } = await supabaseAdmin
      .from("inventory")
      .select("id, is_used, assigned_order_id")
      .eq("id", inventoryId)
      .single();
    if (lookupError || !item) return res.status(404).json({ error: "Compte introuvable." });
    if (!item.is_used || !item.assigned_order_id) {
      return res.status(409).json({ error: "Ce profil est déjà disponible." });
    }

    const { data: order, error: orderError } = await supabaseAdmin
      .from("orders")
      .select("order_id, status, expires_at")
      .eq("order_id", item.assigned_order_id)
      .maybeSingle();
    if (orderError) throw orderError;
    if (!inventoryCanBeReleased(order || undefined)) {
      return res.status(409).json({ error: "L'abonnement lié à ce profil est encore actif." });
    }

    if (order && !["completed", "cancelled"].includes(String(order.status))) {
      const { error: completionError } = await supabaseAdmin
        .from("orders")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("order_id", order.order_id);
      if (completionError) throw completionError;
    }

    const { data: released, error: releaseError } = await supabaseAdmin
      .from("inventory")
      .update({
        is_used: false,
        assigned_order_id: null,
        assigned_user_id: null,
        assigned_at: null,
      })
      .eq("id", inventoryId)
      .eq("is_used", true)
      .eq("assigned_order_id", item.assigned_order_id)
      .select("id");
    if (releaseError) throw releaseError;
    if (!released?.length) {
      return res.status(409).json({ error: "Ce profil a déjà été modifié. Actualisez le stock." });
    }

    const stockReconciliation = await fulfillPaidOrdersWaitingForStock(req.log).catch((error) => {
      req.log?.warn({ errorName: (error as Error)?.name }, "Post-release stock reconciliation failed");
      return null;
    });
    void appendAuditLog({
      action: "admin_inventory_release",
      actorUserId: req.adminUserId,
      targetType: "inventory",
      targetId: inventoryId,
      details: { previous_order_id: item.assigned_order_id },
    });
    res.once("finish",()=>{void runPartnerStockAlerts().catch(()=>req.log?.warn("Partner stock alerts failed"));});
    return res.json({ success: true, stock_reconciliation: stockReconciliation });
  } catch (err: any) {
    req.log?.error({ code: err?.code }, "Admin inventory release failed");
    return res.status(503).json({ error: "Impossible de libérer ce profil pour le moment." });
  }
});

router.delete("/admin/inventory/:id", requireAdmin, async (req: AuthedRequest, res): Promise<any> => {
  const inventoryId = String(req.params.id || "");
  if (!INVENTORY_ID_RE.test(inventoryId)) {
    return res.status(400).json({ error: "Identifiant de stock invalide." });
  }

  try {
    const { data, error } = await supabaseAdmin.rpc("delete_inactive_inventory_item", {
      p_inventory_id: inventoryId,
      p_confirm_disconnected: req.body?.confirm_disconnected === true,
    });
    if (error) throw error;

    const result = String(data?.result || "");
    if (result === "not_found") return res.status(404).json({ error: "Compte introuvable." });
    if (result === "confirmation_required") {
      return res.status(409).json({ error: "Confirmez d'abord que l'ancien client a été déconnecté du profil." });
    }
    if (result === "assigned_active") {
      return res.status(409).json({ error: "L'abonnement lié à ce profil est encore actif." });
    }
    if (result !== "deleted") throw Object.assign(new Error("Unexpected inventory deletion result"), { code: "INVENTORY_DELETE_RESULT" });

    void appendAuditLog({
      action: "admin_inventory_delete",
      actorUserId: req.adminUserId,
      targetType: "inventory",
      targetId: inventoryId,
      details: { previous_order_id: data?.previous_order_id || null },
    });
    res.json({ success: true });
  } catch (err: any) {
    req.log?.error({ code: err?.code }, "Admin inventory deletion failed");
    res.status(503).json({ error: "Impossible de supprimer ce compte du stock pour le moment." });
  }
});

router.put("/admin/inventory/:id", requireAdmin, async (req: AuthedRequest, res): Promise<any> => {
  try {
    if (typeof req.params.id !== "string" || !INVENTORY_ID_RE.test(req.params.id)) return res.status(400).json({ error: "Identifiant de stock invalide." });

    const { data: existing, error: lookupError } = await supabaseAdmin
      .from("inventory")
      .select("id, service, account_email")
      .eq("id", req.params.id)
      .single();
    if (lookupError || !existing) return res.status(404).json({ error: "Compte introuvable." });
    if (String(existing.service).toLowerCase() !== "netflix") {
      return res.status(409).json({ error: "Ce type de compte n'est plus géré dans le stock automatique." });
    }

    const { account_email, account_password, imap_password, profile_name, profile_pin } = req.body || {};
    const updates: any = {};
    const normalizedEmail = account_email === undefined ? String(existing.account_email) : inventoryEmail(account_email);
    if (account_email !== undefined) {
      updates.account_email = normalizedEmail;
      updates.imap_host = null;
      updates.imap_port = 993;
      updates.imap_user = normalizedEmail;
    }
    if (account_password !== undefined && account_password !== "") {
      updates.account_password = encryptInventorySecret(inventoryPassword(account_password, true));
    }
    if (profile_name !== undefined) updates.profile_name = inventoryProfileName(profile_name);
    if (profile_pin !== undefined) updates.profile_pin = encryptInventorySecret(inventoryProfilePinRequired(profile_pin));

    if (imap_password !== undefined) {
      const imap = inventoryImapSettings(req.body, normalizedEmail);
      if (imap_password !== undefined && imap_password !== "") {
        updates.imap_password = encryptInventorySecret(imap.imap_password);
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "Aucune modification valide." });
    }

    const { data: updated, error } = await supabaseAdmin
      .from("inventory")
      .update(updates)
      .eq("id", req.params.id)
      .select("id");
    if (error) throw error;
    if (!updated?.length) return res.status(404).json({ error: "Compte introuvable." });
    void appendAuditLog({
      action: "admin_inventory_update",
      actorUserId: req.adminUserId,
      targetType: "inventory",
      targetId: req.params.id,
      details: { fields: Object.keys(updates) },
    });
    res.json({ success: true });
  } catch (err: any) {
    req.log?.error({ code: err?.code }, "Admin inventory update failed");
    if (err?.code === "23505") {
      return res.status(409).json({ error: "Ce profil Netflix existe déjà dans le stock." });
    }
    res.status(err?.statusCode === 400 ? 400 : 500).json({
      error: err?.statusCode === 400 ? err.message : "Erreur serveur",
    });
  }
});

router.post("/admin/inventory/:id/test-mailbox", requireAdmin, async (req: AuthedRequest, res): Promise<any> => {
  if (typeof req.params.id !== "string" || !INVENTORY_ID_RE.test(req.params.id)) return res.status(400).json({ error: "Identifiant de stock invalide." });
  try {
    const { data: account, error } = await supabaseAdmin
      .from("inventory")
      .select("id, service, account_email, account_password, imap_host, imap_port, imap_user, imap_password")
      .eq("id", req.params.id)
      .single();
    if (error || !account) return res.status(404).json({ error: "Compte introuvable." });

    const strategy = resolveImapStrategy(account);
    if (!strategy.host || !strategy.user || !strategy.pass) {
      return res.status(400).json({ error: "Configuration IMAP incomplète." });
    }
    if (!isAllowedImapTarget(strategy.host, account.account_email, strategy.port)) {
      return res.status(400).json({ error: "Serveur IMAP non autorisé." });
    }

    const client = new ImapFlow({
      host: strategy.host,
      port: strategy.port,
      secure: true,
      tls: { rejectUnauthorized: true },
      auth: { user: strategy.user, pass: strategy.pass },
      logger: false,
      connectionTimeout: 10_000,
      greetingTimeout: 5_000,
      socketTimeout: 20_000,
      clientInfo: { name: "AuraStream-Inventory-Test", version: "1.0.0" },
    });
    try {
      await client.connect();
      const mailbox = await client.status("INBOX", { messages: true });
      void appendAuditLog({
        action: "admin_inventory_mailbox_test",
        actorUserId: req.adminUserId,
        targetType: "inventory",
        targetId: req.params.id,
        details: { result: "success", host: strategy.host },
      });
      return res.json({ ok: true, status: "healthy", messages: mailbox.messages ?? 0 });
    } finally {
      try { await client.logout(); } catch {}
    }
  } catch (err: any) {
    req.log?.warn({ inventoryId: req.params.id, code: err?.code }, "Admin inventory mailbox test failed");
    return res.status(502).json({
      error: /AUTH|LOGIN|CREDENTIAL/i.test(String(err?.responseText || err?.message || ""))
        ? "Connexion IMAP refusée. Vérifiez l’utilisateur et le mot de passe."
        : "Connexion IMAP impossible. Vérifiez la configuration de la boîte mail.",
    });
  }
});

router.get("/health/mailbox", async (req, res): Promise<any> => {
  try {
    const healthToken = process.env.HEALTH_TOKEN;
    const healthTokenAccepted = Boolean(healthToken && req.get("x-health-token") === healthToken);
    if (!healthTokenAccepted) {
      const token = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "")?.[1]?.trim() || "";
      if (!token) return res.status(404).end();
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data?.user?.email || !isAdmin(data.user) || !hasAdminMfa(token, data.user.id)) {
        return res.status(404).end();
      }
    }
    await checkMailboxHealth();
    return res.json({ ok: true, status: "healthy" });
  } catch (err: any) {
    return res.status(500).json({ status: "error" });
  }
});



router.post("/cron/imap-cleanup", async (req, res): Promise<any> => {
  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ error: "CRON_SECRET non configuré." });
  }
  if (!validCronSecret(req.get("x-cron-secret"))) {
    return res.status(401).json({ error: "Non autorisé" });
  }
  res.status(202).json({ accepted: true });
  runCleanupCycle().catch((e) => console.error("[cleanup] Échec via endpoint :", e?.message || e));
});

router.post("/cron/retry-activation-notifications", async (req, res): Promise<any> => {
  if (!process.env.CRON_SECRET) return res.status(503).json({ error: "CRON_SECRET non configuré." });
  if (!validCronSecret(req.get("x-cron-secret"))) return res.status(401).json({ error: "Non autorisé" });
  try {
    return res.json(await deliverPendingActivationNotifications());
  } catch (err: any) {
    req.log?.error({ code: err?.code }, "Activation notification retry failed");
    return res.status(500).json({ error: "Rattrapage des notifications impossible." });
  }
});

router.post("/cron/verify-integrations", async (req, res): Promise<any> => {
  if (!process.env.CRON_SECRET) return res.status(503).json({ error: "CRON_SECRET non configuré." });
  if (!validCronSecret(req.get("x-cron-secret"))) return res.status(401).json({ error: "Non autorisé" });
  try {
    await checkMailboxHealth();
    const discordOk = await notifyOperations(
      "Test technique Aura Stream : la boîte OTP Netflix et le canal d’activation sont opérationnels.",
      {
        orderId: `TEST-${Date.now()}`,
        service: "spotify",
      },
    );
    if (!discordOk) return res.status(502).json({ ok: false, mailbox: true, discord_operations: false });
    return res.json({ ok: true, mailbox: true, discord_operations: true });
  } catch (err: any) {
    req.log?.warn({ code: err?.code }, "Integration verification failed");
    return res.status(502).json({ ok: false, mailbox: false, discord_operations: false });
  }
});

export default router;
