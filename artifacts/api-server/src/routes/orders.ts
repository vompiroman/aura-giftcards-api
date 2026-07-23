import { Router, type IRouter, Request } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { supabaseAuth as supabase, supabaseAdmin } from "../lib/supabase";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { computeCart } from "../config/prices";
import { runCleanupCycle, checkMailboxHealth } from "../jobs/imapCleanup";
import { isAdmin } from "../middleware/requireAdmin";
import {
  adminOrderItems,
  orderItemSummary,
  parseOrderItems,
  publicOrderItems,
  setClientCredentials,
} from "../lib/orderItems";
import { notifyAdmin } from "../lib/notifyAdmin";
import { summarizeAvailableStock } from "../lib/stockAlerts";

const router: IRouter = Router();

const createOrderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false, default: false },
  keyGenerator: (req: Request) => req.ip || "unknown",
  message: { error: "Trop de commandes crÃƒÂ©ÃƒÂ©es, rÃƒÂ©essayez dans une minute." },
});

const credentialLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.ip || "unknown",
  message: { error: "Trop de modifications. RÃƒÂ©essayez plus tard." },
});

async function getAuthedEmail(req: Request): Promise<string | null> {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return null;
  const token = h.slice(7).trim();
  if (!token) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user?.email) return null;
  return data.user.email.trim().toLowerCase();
}

router.post("/create-order", createOrderLimiter, async (req, res) => {
  try {
    const email = await getAuthedEmail(req);
    if (!email) {
      res.status(401).json({ error: "Token invalide ou expirÃƒÂ©." });
      return;
    }

    const { items } = req.body;
    const pricing = computeCart(items);
    if (!pricing.ok) {
      res.status(400).json({ error: pricing.error });
      return;
    }

    const orderId = "ORD-" + crypto.randomUUID();

    const { data: inserted, error: insertError } = await supabaseAdmin.from("orders").insert({
      order_id: orderId,
      assigned_email: email,
      items: pricing.cleanItems,
      amount: pricing.amount,
      status: "pending",
      payment_status: "unpaid",
    }).select("order_id");

    if (insertError) {
      req.log?.error({ insertError }, "Supabase error creating order");
      res.status(500).json({ error: "Erreur lors de la crÃƒÂ©ation de la commande." });
      return;
    }

    if (!inserted || inserted.length === 0) {
      console.error("[create-order] Insert returned 0 rows. RLS may be blocking inserts. Check that SUPABASE_KEY is the service_role key, not the anon key.");
      res.status(500).json({ error: "La commande n'a pas pu ÃƒÂªtre enregistrÃƒÂ©e. Contactez le support." });
      return;
    }

    res.status(201).json({ order_id: orderId, amount: pricing.amount });
  } catch (err) {
    req.log?.error({ err }, "Unexpected error in POST /create-order");
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

router.get("/my-orders", async (req, res): Promise<any> => {
  try {
    const email = await getAuthedEmail(req);
    if (!email) {
      res.status(401).json({ error: "Token invalide ou expirÃƒÂ©." });
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
      res.status(500).json({ error: "Erreur lors de la rÃƒÂ©cupÃƒÂ©ration." });
      return;
    }

    if (!orders || orders.length === 0) {
      return res.json({ orders: [] });
    }

    const orderIds = orders.map((o: any) => o.order_id || o.id).filter(Boolean);
    const { data: accounts } = await supabaseAdmin
      .from("inventory")
      .select("assigned_order_id, account_email, profile_name, profile_pin, service")
      .in("assigned_order_id", orderIds);

    const accountByOrderId = new Map(
      (accounts || []).map((a: any) => [a.assigned_order_id, a])
    );

    const enrichedOrders = orders.map((o: any) => {
      const acc = accountByOrderId.get(o.order_id) || accountByOrderId.get(o.id);
      const hasNetflix = publicOrderItems(o.items).some((item: any) =>
        String(item?.name || item?.service || "").toLowerCase().includes("netflix")
      );
      return {
        ...o,
        items: publicOrderItems(o.items),
        waiting_for_stock:
          o.payment_status === "paid" && o.status === "pending" && hasNetflix && !acc,
        account:
          o.status === "active" && acc
            ? {
                email: acc.account_email,
                profile_name: acc.profile_name ?? null,
                profile_pin: acc.profile_pin ?? null,
                service: acc.service,
              }
            : null,
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

function escapeHtml(input: string): string {
  return String(input).replace(/[&<>"'/]/g, (c) => (
    { '&': '&', '<': '<', '>': '>', '"': '"', "'": '&#39;', '/': '&#x2F;' }[c] as string
  ));
}

router.get("/validate-order", async (req, res): Promise<any> => {
  try {
    const email = await getAuthedEmail(req);
    const orderId = String(req.query.id || "");
    if (!/^ORD-[A-Za-z0-9-]{6,40}$/.test(orderId)) {
      return res.status(400).json({ error: "Identifiant de commande invalide." });
    }

    const { data: order, error: fetchError } = await supabaseAdmin
      .from("orders")
      .select("order_id, status, payment_status, assigned_email, expires_at")
      .eq("order_id", orderId)
      .single();

    if (fetchError || !order) {
      return res.status(404).json({ error: "Commande introuvable." });
    }

    if (!email || (order.assigned_email?.toLowerCase() !== email.toLowerCase() && !isAdmin(email))) {
      return res.status(403).json({ error: "AccÃƒÂ¨s refusÃƒÂ©." });
    }

    return res.json({
      status: order.status,
      payment_status: order.payment_status,
      expires_at: order.expires_at,
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
    return res.status(503).json({ error: "CRON_SECRET non configurÃƒÂ©." });
  }
  if (!validCronSecret(req.get("x-cron-secret"))) {
    return res.status(401).json({ error: "Non autorisÃƒÂ©" });
  }
  try {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) {
      res.status(500).json({ error: "DISCORD_WEBHOOK_URL non dÃƒÂ©fini." });
      return;
    }
    
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
      res.status(500).json({ error: error.message });
      return;
    }
    
    if (!expiringOrders || expiringOrders.length === 0) {
      res.json({ message: "Aucun rappel nÃƒÂ©cessaire aujourd'hui." });
      return;
    }
    
    let sentCount = 0;
    for (const order of expiringOrders) {
      // PRE-FILLED WHATSAPP LINK FOR ADMIN
      const message = `Bonjour Aura Stream ! Mon abonnement se termine dans 3 jours et je souhaite le renouveler pour ne pas perdre l'accÃƒÂ¨s.`;
      const waLink = `https://wa.me/?text=${encodeURIComponent(message)}`;

      const payload = {
        content: `Ã°Å¸Å¡Â¨ **RAPPEL D'EXPIRATION IMMINENTE (J-3)** Ã°Å¸Å¡Â¨\n\n**Commande :** ${order.order_id}\n**Client :** ${order.assigned_email}\n**Articles :** ${orderItemSummary(order.items)}\n**Expire le :** ${new Date(order.expires_at).toLocaleDateString('fr-FR')}\n\nÃ°Å¸â€˜â€° **Action:** Cliquez ici pour contacter le client sur WhatsApp : ${waLink}`,
        allowed_mentions: { parse: [] },
      };
      
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      sentCount++;
    }
    
    res.json({ message: `${sentCount} rappel(s) envoyÃƒÂ©(s) sur Discord.` });
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

router.get("/admin/all-orders", async (req, res): Promise<any> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.status(401).json({ error: "Token manquant" });
      return;
    }
    const token = authHeader.replace("Bearer ", "");

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user?.email) {
      res.status(401).json({ error: "Token invalide ou expirÃƒÂ©." });
      return;
    }
    
    if (!isAdmin(userData.user.email)) {
      res.status(403).json({ error: "AccÃƒÂ¨s refusÃƒÂ©. Vous n'ÃƒÂªtes pas administrateur." });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from("orders")
      .select("id, order_id, assigned_email, amount, status, payment_status, items, created_at, expires_at, activated_at")
      .order("created_at", { ascending: false });

    if (error) {
      req.log.error({ error }, "Supabase error fetching all orders");
      res.status(500).json({ error: "Erreur lors de la rÃƒÂ©cupÃƒÂ©ration des commandes." });
      return;
    }

    res.json({ orders: (data || []).map((order: any) => ({
      ...order,
      items: adminOrderItems(order.items),
    })) });
  } catch (err) {
    req.log.error({ err }, "Unexpected error in GET /admin/all-orders");
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

router.post("/admin/update-order-status", async (req, res): Promise<any> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Token manquant" });
    const token = authHeader.replace("Bearer ", "");

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user?.email) return res.status(401).json({ error: "Token invalide." });

    if (!isAdmin(userData.user.email)) {
      return res.status(403).json({ error: "AccÃƒÂ¨s refusÃƒÂ©. Admin requis." });
    }

    const { order_id, status } = req.body;
    if (!order_id || !status) return res.status(400).json({ error: "order_id et status requis." });
    if (typeof order_id !== "string" || !/^ORD-[A-Za-z0-9-]{6,40}$/.test(order_id)) {
      return res.status(400).json({ error: "Identifiant de commande invalide." });
    }
    if (!['pending', 'active', 'cancelled'].includes(status)) return res.status(400).json({ error: "Statut invalide." });

    const { data: currentOrder, error: currentOrderError } = await supabaseAdmin
      .from("orders")
      .select("status, payment_status")
      .eq("order_id", order_id)
      .single();
    if (currentOrderError || !currentOrder) return res.status(404).json({ error: "Commande introuvable." });
    if (status === "active" && currentOrder.payment_status !== "paid") {
      return res.status(409).json({ error: "Impossible d'activer une commande dont le paiement n'est pas confirmÃƒÂ©." });
    }

    const update: Record<string, string> = { status };
    if (status === "cancelled" && currentOrder.payment_status === "unpaid") update.payment_status = "failed";
    const { error: updateError } = await supabaseAdmin
      .from("orders")
      .update(update)
      .eq("order_id", order_id);

    if (updateError) {
      req.log.error({ updateError }, "Supabase error updating order status");
      return res.status(500).json({ error: "Erreur lors de la mise ÃƒÂ  jour." });
    }

    res.json({ success: true, status: status });
  } catch (err) {
    req.log.error({ err }, "Unexpected error in POST /admin/update-order-status");
    res.status(500).json({ error: "Erreur interne." });
  }
});

// GET user credentials from inventory
router.get("/my-credentials", async (req, res): Promise<void> => {
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
        account_password: isNetflix ? null : c.account_password,
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
    const normalizedWhatsapp = typeof whatsapp === "string" ? whatsapp.trim() : "";
    if (typeof order_id !== "string" || !/^ORD-[A-Za-z0-9-]{6,40}$/.test(order_id) || !["spotify", "crunchyroll"].includes(normalizedService) || !normalizedEmail || !normalizedPassword || !normalizedWhatsapp || normalizedEmail.length > 254 || normalizedPassword.length > 256 || normalizedWhatsapp.length > 40) {
      return res.status(400).json({ error: "DonnÃƒÂ©es manquantes" });
    }

    const { data: order, error: orderError } = await supabaseAdmin.from("orders").select("order_id, assigned_email, status, payment_status, items").eq("order_id", order_id).single();
    if (orderError || !order) return res.status(404).json({ error: "Commande introuvable" });
    if (order.assigned_email?.toLowerCase() !== userData.user.email.toLowerCase()) return res.status(403).json({ error: "AccÃƒÂ¨s refusÃƒÂ©" });
    if (order.payment_status !== "paid" || order.status === "cancelled") return res.status(409).json({ error: "Le paiement de cette commande n'est pas confirmÃƒÂ©." });

    // Update items with credentials
    const items = parseOrderItems(order.items);
    
    const serviceItemExists = items.some((item: any) => typeof item?.name === "string" && item.name.toLowerCase().includes(normalizedService));
    if (!serviceItemExists) return res.status(400).json({ error: "Service non prÃƒÂ©sent dans cette commande." });

    let updatedItems: any[];
    try {
      updatedItems = setClientCredentials(order.items, normalizedService, {
        email: normalizedEmail,
        password: normalizedPassword,
        whatsapp: normalizedWhatsapp,
      });
    } catch {
      return res.status(503).json({ error: "Le stockage sÃƒÂ©curisÃƒÂ© des identifiants n'est pas configurÃƒÂ©." });
    }

    const { data: updated, error: updateError } = await supabaseAdmin.from("orders")
      .update({ items: updatedItems })
      .eq("order_id", order_id)
      .eq("assigned_email", userData.user.email)
      .eq("payment_status", "paid")
      .neq("status", "cancelled")
      .select("order_id");
    if (updateError) throw updateError;
    if (!updated?.length) return res.status(409).json({ error: "La commande n'est plus modifiable." });

    // Notification Discord dÃƒÂ©sormais gÃƒÂ©rÃƒÂ©e cÃƒÂ´tÃƒÂ© serveur par /client-credentials
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (webhookUrl) {
      const frontendUrl = (process.env.FRONTEND_URL || "https://aura-stream.netlify.app").replace(/\/$/, "");
      const validationLink = `${frontendUrl}/?admin=true`;
      let icon = 'Ã°Å¸â€â€';
       if (normalizedService.includes('spotify')) icon = 'Ã°Å¸Å½Âµ';
       else if (normalizedService.includes('crunchyroll')) icon = 'Ã°Å¸ÂÂ¥';

       const content = `${icon} **Nouveau compte ${normalizedService} ÃƒÂ  activer !**\n**Commande :** ${order_id}\n*(Les identifiants client sont disponibles uniquement dans le panneau sÃƒÂ©curisÃƒÂ©.)*\n\n[Ã°Å¸â€ºÂ Ã¯Â¸Â Valider et activer la commande](${validationLink})`;

      try {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, allowed_mentions: { parse: [] } })
        });
      } catch (webhookErr) {
        req.log.error({ webhookErr }, "Failed to send Discord webhook");
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

function resolveImapStrategy(acc: {
  account_email: string;
  account_password?: string;
  imap_host?: string;
  imap_port?: number;
  imap_user?: string;
  imap_password?: string;
}): { host: string; port: number; user: string; pass: string } {
  const email = acc.account_email;
  const domain = (email.toLowerCase().split('@')[1] || '');
  const user = acc.imap_user || email;
  const pass = acc.imap_password || acc.account_password || '';

  if (acc.imap_host) {
    return {
      host: acc.imap_host,
      port: acc.imap_port || 993,
      user,
      pass
    };
  }

  // Support automatique pour le domaine Catch-All aura-stream.com (Hostinger)
  if (domain === 'aura-stream.com') {
    return {
      host: 'imap.hostinger.com',
      port: 993,
      user: acc.imap_user || process.env.IMAP_ADMIN_USER || email,
      pass: acc.imap_password || process.env.DEFAULT_IMAP_PASSWORD || process.env.IMAP_ADMIN_PASS || ''
    };
  }

  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return { host: 'imap.gmail.com', port: 993, user, pass };
  }

  if (domain.startsWith('yahoo.')) {
    return { host: 'imap.mail.yahoo.com', port: 993, user, pass };
  }

  const microsoft = ['outlook.fr','outlook.com','hotmail.fr','hotmail.com','hotmail.co.uk','live.fr','live.com','msn.com'];
  if (microsoft.includes(domain)) {
    return { host: 'outlook.office365.com', port: 993, user, pass };
  }

  // Unknown providers are rejected. Never derive a network target from database
  // or user-controlled email data; that would create an SSRF primitive.
  return { host: '', port: 993, user, pass };
}

function isAllowedImapTarget(host: string, email: string, port: number): boolean {
  const normalizedHost = String(host || "").trim().toLowerCase().replace(/\.$/, "");
  const allowed = new Set([
    "imap.hostinger.com",
    "imap.gmail.com",
    "imap.mail.yahoo.com",
    "outlook.office365.com",
    "imap-mail.outlook.com",
    ...(process.env.ALLOWED_IMAP_HOSTS || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  ]);
  return port === 993 && allowed.has(normalizedHost) && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalizedHost);
}


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
      if (val.toLowerCase().includes(lowerTarget)) return true;
    }
  }

  return addresses.some(addr => addr.includes(lowerTarget));
}

function isAuthenticNetflix(parsed: any): boolean {
  const authResults = (parsed.headers?.get?.('authentication-results') || '').toString().toLowerCase();
  if (!authResults) return false;
  return /dkim=pass/.test(authResults) && /netflix\.com/.test(authResults);
}

function extractNetflixCode(text: string, html: string, subject?: string): { code?: string; link?: string } {
  const lowerSubject = (subject || '').normalize('NFD').toLowerCase();
  const forbiddenKeywords = [
    'mot de passe',
    'password',
    'contraseÃƒÂ±a',
    'reinitialis',
    'reset',
    'restablece',
    'changement d\'adresse',
    'update your email',
    'change your email'
  ];
  if (forbiddenKeywords.some(kw => lowerSubject.includes(kw))) {
    return {};
  }

  const haystack = `${text || ''}\n${html || ''}`;
  const linkMatch = haystack.match(
    /https?:\/\/[^\s"'<>]*netflix\.com\/[^\s"'<>]*(?:account\/travel\/verify|account\/update-primary-location|verify|nftoken|EMAIL_)[^\s"'<>]*/i
  );

  const CODE_NEAR_LABEL =
    /(?:code|cÃƒÂ³digo|codice|zugangscode|verification code|code de vÃƒÂ©rification|votre code|access code|temporaire|connexion|login)\D{0,40}\b(\d{4})\b/i;

  const nearMatch = haystack.match(CODE_NEAR_LABEL);
  const code = nearMatch ? nearMatch[1] : undefined;

  return { code, link: linkMatch ? linkMatch[0] : undefined };
}

const otpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de tentatives. RÃƒÂ©essayez dans une minute." },
});

router.post("/get-netflix-otp", otpLimiter, async (req, res): Promise<any> => {
  const { order_id } = req.body;
  if (typeof order_id !== "string" || !/^ORD-[A-Za-z0-9-]{6,40}$/.test(order_id)) return res.status(400).json({ error: "Identifiant de commande invalide." });

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

  if (order.status !== "active" || order.payment_status !== "paid" || !order.expires_at || new Date(order.expires_at).getTime() <= Date.now()) {
    return res.status(409).json({ error: "Cette commande n'est pas active ou son paiement n'est pas confirmÃƒÂ©." });
  }

  const { data: invItems, error: invError } = await supabaseAdmin
    .from("inventory")
    .select("id, account_email, account_password, imap_host, imap_port, imap_user, imap_password, service")
    .eq("assigned_order_id", order_id)
    .eq("is_used", true)
    .ilike("service", "%netflix%");

  if (invError) return res.status(500).json({ error: "Erreur serveur" });

  if (!invItems || invItems.length === 0) return res.status(404).json({ error: "Aucun compte Netflix disponible en stock pour cette commande." });

  const netflixAccount = invItems.find((i: any) => i.service.toLowerCase().includes("netflix")) || invItems[0];
  if (!netflixAccount) return res.status(404).json({ error: "Pas de compte Netflix assignÃƒÂ©" });

  const strat = resolveImapStrategy(netflixAccount);
  if (!strat.user || !strat.pass) return res.status(400).json({ error: "Identifiants IMAP manquants dans l'inventaire" });
  if (!isAllowedImapTarget(strat.host, netflixAccount.account_email, strat.port)) {
    req.log?.warn({ host: strat.host, port: strat.port }, "Blocked non-allowlisted IMAP target");
    return res.status(400).json({ error: "Serveur IMAP non autorisÃƒÂ©." });
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

        for (let attempt = 1; attempt <= 3; attempt++) {
          for await (let message of client.fetch({ since }, { envelope: true, source: true })) {
            if (message.envelope?.from?.some((f: any) => f.address?.toLowerCase().includes('netflix'))) {
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
          return res.status(404).json({ error: "Aucun email Netflix rÃƒÂ©cent trouvÃƒÂ©. Assurez-vous d'avoir demandÃƒÂ© le code sur Netflix puis rÃƒÂ©essayez dans quelques secondes." });
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
  let userMessage = "Impossible de se connecter ÃƒÂ  la boÃƒÂ®te mail.";
  if (/AUTHENTICATE failed|AUTHENTICATIONFAILED|invalid credentials/i.test(raw)) {
    userMessage = "Basic Auth refusÃƒÂ© par le serveur. Si vous utilisez Outlook, passez ce compte Netflix sur une adresse Gmail (@gmail.com) ou un domaine personnalisÃƒÂ© pour dÃƒÂ©bloquer l'IMAP.";
  } else if (/IMAP.*disabled|not enabled/i.test(raw)) {
    userMessage = "L'accÃƒÂ¨s IMAP est dÃƒÂ©sactivÃƒÂ© sur ce compte. Activez-le dans les options du fournisseur.";
  }

  return res.status(502).json({ error: userMessage });
});


// Admin inventory routes
router.get("/admin/inventory", async (req, res): Promise<any> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Token manquant" });
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user?.email || !isAdmin(userData.user.email)) {
      return res.status(403).json({ error: "AccÃƒÂ¨s refusÃƒÂ©." });
    }

    const { data, error } = await supabaseAdmin
      .from("inventory")
      .select("id, service, account_email, account_password, is_used, assigned_order_id, created_at, profile_name, profile_pin")
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ inventory: data || [] });
  } catch (err) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/admin/inventory", async (req, res): Promise<any> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Token manquant" });
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user?.email || !isAdmin(userData.user.email)) {
      return res.status(403).json({ error: "AccÃƒÂ¨s refusÃƒÂ©." });
    }

    const VALID_SERVICES = new Set(["netflix", "spotify", "crunchyroll"]);
    const MAX_BATCH = 100;

    const validateEntry = (e: any): string | null => {
      if (!e || typeof e !== "object") return "EntrÃƒÂ©e invalide.";
      const svc = String(e.service || "").toLowerCase();
      if (!VALID_SERVICES.has(svc)) return `Service inconnu: ${e.service}`;
      if (!e.account_email || typeof e.account_email !== "string") return "Email manquant.";
      if (svc !== "netflix" && !e.account_password) return "Mot de passe manquant pour ce service.";
      return null;
    };

    let rows: any[] = [];
    if (Array.isArray(req.body)) {
      if (req.body.length === 0) return res.status(400).json({ error: "Lot vide." });
      if (req.body.length > MAX_BATCH) return res.status(400).json({ error: `Maximum ${MAX_BATCH} comptes par lot.` });
      for (const e of req.body) {
        const err = validateEntry(e);
        if (err) return res.status(400).json({ error: err });
      }
      rows = req.body;
    } else {
      const err = validateEntry(req.body);
      if (err) return res.status(400).json({ error: err });
      rows = [req.body];
    }

    const cleanRows = rows.map(r => ({
      service: String(r.service).toLowerCase(),
      account_email: r.account_email,
      account_password: r.account_password ?? null,
      profile_name: r.profile_name ?? null,
      profile_pin: r.profile_pin ?? null,
      is_used: false,
    }));

    const { error } = await supabaseAdmin.from("inventory").insert(cleanRows);
    if (error) throw error;
    return res.status(201).json({ success: true, added: cleanRows.length });
  } catch (err: any) {
    req.log?.error({ code: err?.code }, "Admin inventory insert failed");
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

router.delete("/admin/inventory/:id", async (req, res): Promise<any> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Token manquant" });
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user?.email || !isAdmin(userData.user.email)) {
      return res.status(403).json({ error: "AccÃƒÂ¨s refusÃƒÂ©." });
    }

    const { data: existing, error: lookupError } = await supabaseAdmin
      .from("inventory")
      .select("id, is_used, assigned_order_id")
      .eq("id", req.params.id)
      .single();
    if (lookupError || !existing) return res.status(404).json({ error: "Compte introuvable." });
    if (existing.is_used || existing.assigned_order_id) {
      return res.status(409).json({ error: "Ce compte est attribuÃƒÂ© et ne peut pas ÃƒÂªtre supprimÃƒÂ©." });
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
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.put("/admin/inventory/:id", async (req, res): Promise<any> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Token manquant" });
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user?.email || !isAdmin(userData.user.email)) {
      return res.status(403).json({ error: "AccÃƒÂ¨s refusÃƒÂ©." });
    }

    const { account_email, account_password, profile_name, profile_pin } = req.body;
    const updates: any = {};
    if (account_email !== undefined) updates.account_email = account_email;
    if (account_password !== undefined) updates.account_password = account_password;
    if (profile_name !== undefined) updates.profile_name = profile_name;
    if (profile_pin !== undefined) updates.profile_pin = profile_pin;

    const { error } = await supabaseAdmin.from("inventory").update(updates).eq("id", req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.get("/health/mailbox", async (req, res): Promise<any> => {
  try {
    const healthToken = process.env.HEALTH_TOKEN;
    const authHeader = req.get("x-health-token") || req.get("authorization") || "";
    const email = await getAuthedEmail(req);

    if ((!healthToken || req.get("x-health-token") !== healthToken) && !isAdmin(email)) {
      return res.status(404).end();
    }
    await checkMailboxHealth();
    return res.json({ ok: true, status: "healthy" });
  } catch (err: any) {
    return res.status(500).json({ status: "error" });
  }
});



router.post("/cron/imap-cleanup", async (req, res): Promise<any> => {
  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ error: "CRON_SECRET non configurÃƒÂ©." });
  }
  if (!validCronSecret(req.get("x-cron-secret"))) {
    return res.status(401).json({ error: "Non autorisÃƒÂ©" });
  }
  res.status(202).json({ accepted: true });
  runCleanupCycle().catch((e) => console.error("[cleanup] Ãƒâ€°chec via endpoint :", e?.message || e));
});

export default router;
