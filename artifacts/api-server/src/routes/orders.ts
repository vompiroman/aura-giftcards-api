import { Router, type IRouter, Request } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { supabaseAuth as supabase, supabaseAdmin } from "../lib/supabase";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { computeCart } from "../config/prices";

const router: IRouter = Router();

const createOrderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false, default: false },
  keyGenerator: (req: Request) => {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    return token || (typeof req.headers["x-forwarded-for"] === "string" ? req.headers["x-forwarded-for"] : "unknown");
  },
  message: { error: "Trop de commandes créées, réessayez dans une minute." },
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
      res.status(401).json({ error: "Token invalide ou expiré." });
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
    }).select("order_id");

    if (insertError) {
      req.log?.error({ insertError }, "Supabase error creating order");
      console.error("[create-order] Supabase insert error:", JSON.stringify(insertError));
      res.status(500).json({ error: "Erreur lors de la création de la commande: " + insertError.message });
      return;
    }

    if (!inserted || inserted.length === 0) {
      console.error("[create-order] Insert returned 0 rows. RLS may be blocking inserts. Check that SUPABASE_KEY is the service_role key, not the anon key.");
      res.status(500).json({ error: "La commande n'a pas pu être enregistrée. Contactez le support." });
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
      res.status(401).json({ error: "Token invalide ou expiré." });
      return;
    }

    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("assigned_email", email)
      .order("created_at", { ascending: false });

    if (error) {
      req.log?.error({ error }, "Supabase error fetching orders");
      res.status(500).json({ error: "Erreur lors de la récupération." });
      return;
    }

    res.json({ orders: data });
  } catch (err) {
    req.log?.error({ err }, "Unexpected error in GET /my-orders");
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

router.get("/validate-order", async (req, res): Promise<any> => {
  try {
    const { id } = req.query;
    if (!id || typeof id !== 'string') {
      res.status(400).send("ID manquant");
      return;
    }
    
    // Fetch the order
    const { data: order, error: fetchError } = await supabase
      .from("orders")
      .select("*")
      .eq("order_id", id)
      .single();
      
    if (fetchError || !order) {
      res.status(404).send("Commande non trouvée");
      return;
    }
    
    if (order.status === 'active') {
      res.send(`
        <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
          <h1 style="color: #1DB954;">✅ Déjà Validée !</h1>
          <p>La commande <strong>${id}</strong> est déjà active.</p>
        </div>
      `);
      return;
    }

    let durationMonths = 1;
    let serviceName = "netflix";
    const itemsText = JSON.stringify(order.items || []).toLowerCase();
    
    if (itemsText.includes("spotify")) serviceName = "spotify";
    else if (itemsText.includes("crunchyroll")) serviceName = "crunchyroll";

    if (itemsText.includes("2 mois") || itemsText.includes("2 months") || itemsText.includes("شهران")) {
      durationMonths = 2;
    } else if (itemsText.includes("1 an") || itemsText.includes("1 year") || itemsText.includes("سنة واحدة")) {
      durationMonths = 12;
    } else if (itemsText.includes("6 mois") || itemsText.includes("6 months")) {
      durationMonths = 6;
    }
    
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + durationMonths);
    
    // Auto-assign from inventory
    const { data: invItem } = await supabase
      .from("inventory")
      .select("*")
      .eq("service", serviceName)
      .eq("is_used", false)
      .limit(1)
      .single();

    let accountAssignedMsg = "";
    if (invItem) {
      await supabaseAdmin.from("inventory").update({ is_used: true, assigned_order_id: id }).eq("id", invItem.id);
      accountAssignedMsg = `<p style="color: #1DB954; font-weight: bold; padding: 10px; border: 1px solid #1DB954; border-radius: 5px;">🎉 Un compte ${serviceName} a été automatiquement assigné et livré au client !</p>`;
    } else {
      accountAssignedMsg = `<p style="color: orange; font-weight: bold;">⚠️ Aucun compte en stock pour ${serviceName}. Pensez à ajouter le compte manuellement.</p>`;
    }

    const { error: updateError } = await supabase
      .from("orders")
      .update({
        status: "active",
        expires_at: expiresAt.toISOString()
      })
      .eq("order_id", id);
      
    if (updateError) {
      res.status(500).send("Erreur lors de la validation : " + updateError.message);
      return;
    }
    
    res.send(`
      <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
        <h1 style="color: #1DB954;">✅ Commande Validée !</h1>
        <p>La commande <strong>${id}</strong> est maintenant active.</p>
        <p>Date d'expiration automatique : <strong>${expiresAt.toLocaleDateString('fr-FR')}</strong></p>
        ${accountAssignedMsg}
      </div>
    `);
  } catch (err) {
    req.log.error({ err }, "Validation error");
    res.status(500).send("Erreur serveur");
  }
});

router.get("/cron/reminders", async (req, res): Promise<any> => {
  try {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) {
      res.status(500).json({ error: "DISCORD_WEBHOOK_URL non défini." });
      return;
    }
    
    const now = new Date();
    const threeDaysFromNow = new Date();
    threeDaysFromNow.setDate(now.getDate() + 3);
    const twoDaysFromNow = new Date();
    twoDaysFromNow.setDate(now.getDate() + 2);
    
    const { data: expiringOrders, error } = await supabase
      .from("orders")
      .select("*")
      .eq("status", "active")
      .lte("expires_at", threeDaysFromNow.toISOString())
      .gt("expires_at", twoDaysFromNow.toISOString());
      
    if (error) {
      req.log.error({ error }, "Error fetching expiring orders");
      res.status(500).json({ error: error.message });
      return;
    }
    
    if (!expiringOrders || expiringOrders.length === 0) {
      res.json({ message: "Aucun rappel nécessaire aujourd'hui." });
      return;
    }
    
    let sentCount = 0;
    for (const order of expiringOrders) {
      // PRE-FILLED WHATSAPP LINK FOR ADMIN
      const message = `Bonjour Aura Stream ! Mon abonnement se termine dans 3 jours et je souhaite le renouveler pour ne pas perdre l'accès.`;
      const waLink = `https://wa.me/?text=${encodeURIComponent(message)}`;

      const payload = {
        content: `🚨 **RAPPEL D'EXPIRATION IMMINENTE (J-3)** 🚨\n\n**Commande :** ${order.order_id}\n**Client :** ${order.assigned_email}\n**Articles :** ${JSON.stringify(order.items)}\n**Expire le :** ${new Date(order.expires_at).toLocaleDateString('fr-FR')}\n\n👉 **Action:** Cliquez ici pour contacter le client sur WhatsApp : ${waLink}`
      };
      
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      sentCount++;
    }
    
    res.json({ message: `${sentCount} rappel(s) envoyé(s) sur Discord.` });
  } catch (err) {
    req.log.error({ err }, "Cron error");
    res.status(500).json({ error: "Erreur interne" });
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
      res.status(401).json({ error: "Token invalide ou expiré." });
      return;
    }
    
    // Authorization check
    const adminEmail = process.env["ADMIN_EMAIL"] || "nassym.yak@gmail.com";
    if (userData.user.email !== adminEmail) {
      res.status(403).json({ error: "Accès refusé. Vous n'êtes pas administrateur." });
      return;
    }

    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      req.log.error({ error }, "Supabase error fetching all orders");
      res.status(500).json({ error: "Erreur lors de la récupération des commandes." });
      return;
    }

    let keyRole = "unknown";
    try {
      const k = process.env["SUPABASE_SERVICE_ROLE_KEY"] || process.env["SUPABASE_KEY"] || "";
      const p = k.split(".");
      if (p.length === 3) keyRole = JSON.parse(Buffer.from(p[1], "base64url").toString()).role;
    } catch {}

    res.json({ orders: data || [], debug_key_role: keyRole });
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

    const adminEmails = ["admin@aura-stream.com", "vompiroman@gmail.com", process.env["ADMIN_EMAIL"] || "nassym.yak@gmail.com"];
    if (!adminEmails.includes(userData.user.email)) {
      return res.status(403).json({ error: "Accès refusé. Admin requis." });
    }

    const { order_id, status } = req.body;
    if (!order_id || !status) return res.status(400).json({ error: "order_id et status requis." });
    if (!['pending', 'active', 'cancelled'].includes(status)) return res.status(400).json({ error: "Statut invalide." });

    const { error: updateError } = await supabase
      .from("orders")
      .update({ status: status })
      .eq("order_id", order_id);

    if (updateError) {
      req.log.error({ updateError }, "Supabase error updating order status");
      return res.status(500).json({ error: "Erreur lors de la mise à jour." });
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

    const { data: userOrders, error: ordersError } = await supabase
      .from("orders")
      .select("order_id")
      .eq("assigned_email", email)
      .eq("status", "active")
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

    const { data: credentials, error } = await supabase
      .from("inventory")
      .select("assigned_order_id, account_email, account_password, service, profile_name, profile_pin")
      .in("assigned_order_id", orderIds);

    if (error) {
      res.status(500).json({ error: "Erreur serveur" });
      return;
    }
    res.json({ credentials: credentials || [] });
  } catch (err) {
    req.log?.error({ err }, "Error fetching credentials");
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// POST client credentials into order.items
router.post("/client-credentials", async (req, res): Promise<any> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Token manquant" });
    const token = authHeader.replace("Bearer ", "");

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user?.email) return res.status(401).json({ error: "Token invalide." });

    const { order_id, service, email, password, whatsapp } = req.body;
    if (!order_id || !service || !email || !password || !whatsapp) {
      return res.status(400).json({ error: "Données manquantes" });
    }

    const { data: order, error: orderError } = await supabaseAdmin.from("orders").select("*").eq("order_id", order_id).single();
    if (orderError || !order) return res.status(404).json({ error: "Commande introuvable" });
    if (order.assigned_email?.toLowerCase() !== userData.user.email.toLowerCase()) return res.status(403).json({ error: "Accès refusé" });

    // Update items with credentials
    let items = Array.isArray(order.items) ? order.items : [];
    if (typeof order.items === 'string') {
      try { items = JSON.parse(order.items); } catch(e) {}
    }
    
    const updatedItems = items.map((item: any) => {
      if (item.name && item.name.toLowerCase().includes(service.toLowerCase())) {
        return { ...item, client_credentials: { email, password, whatsapp } };
      }
      return item;
    });

    const { error: updateError } = await supabaseAdmin.from("orders").update({ items: updatedItems }).eq("order_id", order_id);
    if (updateError) throw updateError;

    // Notification Discord désormais gérée côté serveur par /client-credentials
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (webhookUrl) {
      const frontendUrl = (process.env.FRONTEND_URL || "https://aura-stream.netlify.app").replace(/\/$/, "");
      const validationLink = `${frontendUrl}/?admin=true`;
      let icon = '🔔';
      if (service.toLowerCase().includes('spotify')) icon = '🎵';
      else if (service.toLowerCase().includes('crunchyroll')) icon = '🍥';

      const content = `${icon} **Nouveau compte ${service} à activer !**\n**Commande :** ${order_id}\n**Email :** ${email}\n**Mot de passe :** ${password}\n**Numéro WhatsApp :** ${whatsapp}\n\n[🛠️ Valider et activer la commande](${validationLink})`;

      try {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content })
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

router.post("/get-netflix-otp", async (req, res): Promise<any> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Token manquant" });
    const token = authHeader.replace("Bearer ", "");

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user?.email) return res.status(401).json({ error: "Token invalide." });

    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ error: "order_id requis." });

    const { data: order, error: orderError } = await supabaseAdmin.from("orders").select("*").eq("order_id", order_id).single();
    if (orderError || !order) return res.status(404).json({ error: "Commande introuvable" });
    if (order.assigned_email?.toLowerCase() !== userData.user.email.toLowerCase()) return res.status(403).json({ error: "Accès refusé" });

    const { data: invItems, error: invError } = await supabaseAdmin.from("inventory").select("*").eq("assigned_order_id", order_id);
    if (invError || !invItems || invItems.length === 0) return res.status(404).json({ error: "Aucun compte assigné" });
    
    const netflixAccount = invItems.find((i: any) => i.service.toLowerCase().includes("netflix"));
    if (!netflixAccount) return res.status(404).json({ error: "Pas de compte Netflix assigné" });

    const email = netflixAccount.account_email;
    const password = netflixAccount.account_password;

    if (!email || !password) return res.status(400).json({ error: "Identifiants IMAP manquants dans l'inventaire" });

    let host = 'outlook.office365.com';
    let port = 993;
    if (email.includes('@gmail.com')) host = 'imap.gmail.com';
    else if (email.includes('@yahoo.com')) host = 'imap.mail.yahoo.com';

    const client = new ImapFlow({
      host: host,
      port: port,
      secure: true,
      tls: {
        rejectUnauthorized: false
      },
      auth: { user: email, pass: password },
      logger: false
    });

    try {
      await client.connect();
    } catch(e) {
      req.log.error({ e, email }, "IMAP Connection Error");
      return res.status(500).json({ error: "Impossible de se connecter à la boîte mail. Vérifiez le mot de passe d'application." });
    }

    let lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - 15 * 60 * 1000); // last 15 min
      let foundCode = null;

      for await (let message of client.fetch({ since }, { envelope: true, source: true })) {
        if (message.envelope?.from?.some((f: any) => f.address?.toLowerCase().includes('netflix'))) {
          const parsed = await simpleParser(message.source as any);
          const text = ((parsed as any).text || (parsed as any).html || "") as string;
          
          // Chercher une séquence de 4 à 6 chiffres
          const match = text.match(/\b\d{4,6}\b/g);
          if (match) {
            foundCode = match[0];
            break;
          }
        }
      }

      if (foundCode) {
        res.json({ success: true, code: foundCode });
      } else {
        res.status(404).json({ error: "Aucun code trouvé dans les 15 dernières minutes. Veuillez demander un nouveau code sur Netflix puis réessayer dans 1 minute." });
      }
    } finally {
      lock.release();
    }
    await client.logout();
    
  } catch (err) {
    req.log.error({ err }, "Unexpected error in POST /get-netflix-otp");
    res.status(500).json({ error: "Erreur lors de la récupération de l'email." });
  }
});

// Admin inventory routes
router.get("/admin/inventory", async (req, res): Promise<any> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Token manquant" });
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user?.email || userData.user.email !== (process.env["ADMIN_EMAIL"] || "nassym.yak@gmail.com")) {
      return res.status(403).json({ error: "Accès refusé." });
    }

    const { data, error } = await supabaseAdmin.from("inventory").select("*").order("created_at", { ascending: false });
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
    if (userError || !userData?.user?.email || userData.user.email !== (process.env["ADMIN_EMAIL"] || "nassym.yak@gmail.com")) {
      return res.status(403).json({ error: "Accès refusé." });
    }

    if (Array.isArray(req.body)) {
      const rows = req.body.map(item => ({
        service: item.service,
        account_email: item.account_email,
        account_password: item.account_password,
        profile_name: item.profile_name,
        profile_pin: item.profile_pin
      }));
      const { error } = await supabaseAdmin.from("inventory").insert(rows);
      if (error) throw error;
      return res.status(201).json({ success: true });
    } else {
      const { service, account_email, account_password, profile_name, profile_pin } = req.body;
      if (!service || !account_email || !account_password) return res.status(400).json({ error: "Données manquantes." });

      const { error } = await supabaseAdmin.from("inventory").insert({ service, account_email, account_password, profile_name, profile_pin });
      if (error) throw error;
      res.status(201).json({ success: true });
    }
  } catch (err: any) {
    console.error("[admin/inventory POST] Error:", err?.message || err?.code || err);
    res.status(500).json({ error: "Erreur serveur", details: err?.message || String(err) });
  }
});

router.delete("/admin/inventory/:id", async (req, res): Promise<any> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Token manquant" });
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user?.email || userData.user.email !== (process.env["ADMIN_EMAIL"] || "nassym.yak@gmail.com")) {
      return res.status(403).json({ error: "Accès refusé." });
    }

    const { error } = await supabaseAdmin.from("inventory").delete().eq("id", req.params.id);
    if (error) throw error;
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
    if (userError || !userData?.user?.email || userData.user.email !== (process.env["ADMIN_EMAIL"] || "nassym.yak@gmail.com")) {
      return res.status(403).json({ error: "Accès refusé." });
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

export default router;
