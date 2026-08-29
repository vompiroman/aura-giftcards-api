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
import { isAdmin, requireAdmin, type AuthedRequest } from "../middleware/requireAdmin";
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

async function getAuthedEmail(req: Request): Promise<string | null> {
  const h = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  const token = /^Bearer\s+(.+)$/i.exec(h)?.[1]?.trim() || "";
  if (!token) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user?.email) return null;
  return data.user.email.trim().toLowerCase();
}

router.post("/create-order", createOrderLimiter, async (req, res) => {
  try {
    const email = await getAuthedEmail(req);
    if (!email) {
      res.status(401).json({ error: "Token invalide ou expiré." });
      return;
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

    const manualServices = cartManualActivationServices(pricing.cleanItems);
    if (manualServices.length > 0 && !customerWhatsapp) {
      res.status(400).json({ error: "Le numéro WhatsApp est requis pour une activation Spotify ou Crunchyroll." });
      return;
    }
    let orderItems = pricing.cleanItems;
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

    const { count: pendingOrderCount, error: pendingCountError } = await supabaseAdmin
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
    const finalAmount = Math.max(0, pricing.amount - discountAmount);

    const { data: inserted, error: insertError } = await supabaseAdmin.from("orders").insert({
      order_id: orderId,
      assigned_email: email,
      items: orderItems,
      amount: finalAmount,
      subtotal_amount: pricing.amount,
      discount_amount: discountAmount,
      promo_code_id: promo?.id || null,
      status: "pending",
      payment_status: "unpaid",
      marketing_consent: marketingConsent,
      marketing_consent_at: marketingConsent ? new Date().toISOString() : null,
      consent_version: marketingConsent ? MARKETING_CONSENT_VERSION : null,
      customer_whatsapp: customerWhatsapp || null,
    }).select("order_id");

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
            profile_pin: acc.profile_pin ?? null,
            service: acc.service,
          }))
        : [];
      return {
        ...o,
        items: publicOrderItems(o.items),
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

    if (!email || (order.assigned_email?.toLowerCase() !== email.toLowerCase() && !isAdmin(email))) {
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
  const services = (process.env.LOW_STOCK_SERVICES || "Netflix,Spotify,Crunchyroll")
    .split(",")
    .map((service) => service.trim())
    .filter(Boolean);

  try {
    const { data, error } = await supabaseAdmin
      .from("inventory")
      .select("service, is_used")
      .eq("is_used", false);
    if (error) throw error;

    const summary = summarizeAvailableStock(data || [], services, threshold);
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

router.get("/admin/all-orders", async (req, res): Promise<any> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.status(401).json({ error: "Token manquant" });
      return;
    }
    const token = /^Bearer\s+(.+)$/i.exec(authHeader)?.[1]?.trim() || "";
    if (!token) return res.status(401).json({ error: "Token manquant" });

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user?.email) {
      res.status(401).json({ error: "Token invalide ou expiré." });
      return;
    }
    
    if (!isAdmin(userData.user.email, userData.user.app_metadata)) {
      res.status(403).json({ error: "Accès refusé. Vous n'êtes pas administrateur." });
      return;
    }

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
    const service = ["Netflix", "Spotify", "Crunchyroll"].includes(requestedService) ? requestedService : "";
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
        .select("id, order_id, assigned_email, customer_whatsapp, amount, status, payment_status, items, created_at, expires_at, activated_at", { count: "exact" })
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

router.post("/admin/update-order-status", async (req, res): Promise<any> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Token manquant" });
    const token = /^Bearer\s+(.+)$/i.exec(authHeader)?.[1]?.trim() || "";
    if (!token) return res.status(401).json({ error: "Token manquant" });

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user?.email) return res.status(401).json({ error: "Token invalide." });

    if (!isAdmin(userData.user.email, userData.user.app_metadata)) {
      return res.status(403).json({ error: "Accès refusé. Admin requis." });
    }

    const { order_id, status } = req.body;
    if (!order_id || !status) return res.status(400).json({ error: "Action de commande manquante." });
    if (typeof order_id !== "string" || !/^ORD-[A-Za-z0-9-]{6,40}$/.test(order_id)) {
      return res.status(400).json({ error: "Identifiant de commande invalide." });
    }
    if (status && !['pending', 'active', 'completed', 'cancelled'].includes(status)) return res.status(400).json({ error: "Statut invalide." });

    let { data: currentOrder, error: currentOrderError } = await supabaseAdmin
      .from("orders")
      .select("order_id, assigned_email, status, payment_status, promo_code_id, items, amount, expires_at, activated_at, marketing_consent, meta_purchase_sent_at")
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
        return res.status(409).json({ error: "Les identifiants Spotify ou Crunchyroll doivent être reçus avant l’activation." });
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
    const { error: updateError } = await supabaseAdmin
      .from("orders")
      .update(update)
      .eq("order_id", order_id);

    if (updateError) {
      req.log.error({ updateError }, "Supabase error updating order status");
      return res.status(500).json({ error: "Erreur lors de la mise à jour." });
    }

    void appendAuditLog({
      action: "admin_order_status_update",
      actorUserId: userData.user.id,
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
        profile_pin: c.profile_pin ?? null,
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

    const { data: order, error: orderError } = await supabaseAdmin.from("orders").select("order_id, assigned_email, status, payment_status, items").eq("order_id", order_id).single();
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
      .select("order_id");
    if (updateError) throw updateError;
    if (!updated?.length) return res.status(409).json({ error: "La commande n'est plus modifiable." });

    const frontendUrl = (process.env.FRONTEND_URL || "https://aura-stream.netlify.app").replace(/\/$/, "");
    const validationLink = `${frontendUrl}/?admin=true`;
    const discordSent = await notifyOperations(
      `Nouveau compte ${normalizedService} à activer. Les identifiants temporaires sont disponibles dans ce canal opérationnel privé et dans le panneau sécurisé : ${validationLink}`,
      {
        orderId: order_id,
        service: normalizedService,
        credentials: {
          email: normalizedEmail,
          password: normalizedPassword,
          whatsapp: normalizedWhatsapp,
        },
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
        let bestCode = null;
        let bestLink = null;
        let bestTime = 0;
        let bestUid = 0;
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
            { uid: true, envelope: true, size: true, source: { maxLength: maxMessageBytes } },
            { uid: true },
          )) {
            if (typeof message.size === "number" && message.size > maxMessageBytes) continue;
            if (message.envelope?.from?.some((f: any) => isNetflixSenderAddress(f.address))) {
              const parsed = await simpleParser(message.source as any);
              if (targetEmail && !recipientMatches(parsed, targetEmail)) continue;
              if (!isAuthenticNetflix(parsed)) continue;

              const { code, link } = extractNetflixCode(parsed.text || '', (parsed as any).html || '', parsed.subject);
              if (code || link) {
                const msgTime = message.envelope?.date ? new Date(message.envelope.date).getTime() : Date.now();
                const msgUid = message.uid || 0;
                if (msgTime > bestTime || (msgTime === bestTime && msgUid >= bestUid)) {
                  bestTime = msgTime;
                  bestUid = msgUid;
                  if (code) bestCode = code;
                  if (link) bestLink = link;
                }
              }
            }
          }

          if (bestCode || bestLink) break;
          if (attempt < 3) await new Promise(r => setTimeout(r, 2500));
        }

        if (bestCode || bestLink) {
          return res.json({ success: true, code: bestCode, link: bestLink });
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
router.get("/admin/inventory", async (req, res): Promise<any> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Token manquant" });
    const token = /^Bearer\s+(.+)$/i.exec(authHeader)?.[1]?.trim() || "";
    if (!token) return res.status(401).json({ error: "Token manquant" });
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user?.email || !isAdmin(userData.user.email, userData.user.app_metadata)) {
      return res.status(403).json({ error: "Accès refusé." });
    }

    const { data, error } = await supabaseAdmin
      .from("inventory")
      .select("id, service, account_email, is_used, assigned_order_id, assigned_at, created_at, profile_name, profile_pin, imap_host, imap_port, imap_user, account_password, imap_password")
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
          profile_pin: item.profile_pin,
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

router.post("/admin/inventory", async (req, res): Promise<any> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Token manquant" });
    const token = /^Bearer\s+(.+)$/i.exec(authHeader)?.[1]?.trim() || "";
    if (!token) return res.status(401).json({ error: "Token manquant" });
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user?.email || !isAdmin(userData.user.email, userData.user.app_metadata)) {
      return res.status(403).json({ error: "Accès refusé." });
    }

    const MAX_BATCH = 100;

    let rows: any[] = [];
    if (Array.isArray(req.body)) {
      if (req.body.length === 0) return res.status(400).json({ error: "Lot vide." });
      if (req.body.length > MAX_BATCH) return res.status(400).json({ error: `Maximum ${MAX_BATCH} comptes par lot.` });
      rows = req.body;
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
        profile_pin: inventoryProfilePinRequired(entry.profile_pin),
        is_used: false,
      };
    });

    const { error } = await supabaseAdmin.from("inventory").insert(cleanRows);
    if (error) throw error;
    void appendAuditLog({
      action: "admin_inventory_create",
      actorUserId: userData.user.id,
      targetType: "inventory",
      details: { count: cleanRows.length, services: [...new Set(cleanRows.map((row) => row.service))] },
    });
    let stockReconciliation = null;
    try {
      stockReconciliation = await fulfillPaidOrdersWaitingForStock(req.log);
    } catch (reconciliationError) {
      req.log?.warn({ errorName: (reconciliationError as Error)?.name }, "Post-insert stock reconciliation failed");
    }
    return res.status(201).json({
      success: true,
      added: cleanRows.length,
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
    return res.json({ success: true, stock_reconciliation: stockReconciliation });
  } catch (err: any) {
    req.log?.error({ code: err?.code }, "Admin inventory release failed");
    return res.status(503).json({ error: "Impossible de libérer ce profil pour le moment." });
  }
});

router.delete("/admin/inventory/:id", async (req, res): Promise<any> => {
  try {
    if (!INVENTORY_ID_RE.test(req.params.id)) return res.status(400).json({ error: "Identifiant de stock invalide." });
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Token manquant" });
    const token = /^Bearer\s+(.+)$/i.exec(authHeader)?.[1]?.trim() || "";
    if (!token) return res.status(401).json({ error: "Token manquant" });
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user?.email || !isAdmin(userData.user.email, userData.user.app_metadata)) {
      return res.status(403).json({ error: "Accès refusé." });
    }

    const { data: existing, error: lookupError } = await supabaseAdmin
      .from("inventory")
      .select("id, is_used, assigned_order_id")
      .eq("id", req.params.id)
      .single();
    if (lookupError || !existing) return res.status(404).json({ error: "Compte introuvable." });
    if (existing.is_used || existing.assigned_order_id) {
      return res.status(409).json({ error: "Ce compte est attribué et ne peut pas être supprimé." });
    }

    const { data: deleted, error } = await supabaseAdmin
      .from("inventory")
      .delete()
      .eq("id", req.params.id)
      .eq("is_used", false)
      .is("assigned_order_id", null)
      .select("id");
    if (error) throw error;
    if (!deleted?.length) return res.status(409).json({ error: "Ce compte n'est plus supprimable." });
    void appendAuditLog({
      action: "admin_inventory_delete",
      actorUserId: userData.user.id,
      targetType: "inventory",
      targetId: req.params.id,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.put("/admin/inventory/:id", async (req, res): Promise<any> => {
  try {
    if (!INVENTORY_ID_RE.test(req.params.id)) return res.status(400).json({ error: "Identifiant de stock invalide." });
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Token manquant" });
    const token = /^Bearer\s+(.+)$/i.exec(authHeader)?.[1]?.trim() || "";
    if (!token) return res.status(401).json({ error: "Token manquant" });
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user?.email || !isAdmin(userData.user.email, userData.user.app_metadata)) {
      return res.status(403).json({ error: "Accès refusé." });
    }

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
    if (profile_pin !== undefined) updates.profile_pin = inventoryProfilePinRequired(profile_pin);

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
      actorUserId: userData.user.id,
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

router.post("/admin/inventory/:id/test-mailbox", async (req, res): Promise<any> => {
  if (!INVENTORY_ID_RE.test(req.params.id)) return res.status(400).json({ error: "Identifiant de stock invalide." });
  try {
    const authHeader = req.headers.authorization;
    const token = /^Bearer\s+(.+)$/i.exec(authHeader || "")?.[1]?.trim() || "";
    if (!token) return res.status(401).json({ error: "Token manquant" });
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user?.email || !isAdmin(userData.user.email, userData.user.app_metadata)) {
      return res.status(403).json({ error: "Accès refusé." });
    }

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
        actorUserId: userData.user.id,
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
      if (error || !data?.user?.email || !isAdmin(data.user.email, data.user.app_metadata)) {
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
      "Test technique Aura Stream : la boîte OTP Netflix et le canal d'activation Spotify/Crunchyroll sont opérationnels. Aucun identifiant client réel n'est inclus dans ce test.",
      {
        orderId: `TEST-${Date.now()}`,
        service: "spotify",
        credentials: {
          email: "test-activation@aura-stream.com",
          password: "TEST-NE-PAS-UTILISER",
          whatsapp: "+213500000000",
        },
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
