import { Router, Request } from "express";
import rateLimit from "express-rate-limit";
import { supabase } from "../lib/supabase";

const router = Router();

const SLICKPAY_URL = "https://prodapi.slick-pay.com/api/v2/users/invoices";

const invoiceLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    return token || req.ip || "unknown";
  },
  message: { error: "Trop de tentatives de paiement, réessayez dans une minute." },
});

async function getAuthedEmail(req: Request): Promise<string | null> {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return null;
  const token = h.slice(7).trim();
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user?.email) return null;
  return data.user.email;
}

router.post("/create-invoice", invoiceLimiter, async (req, res): Promise<void> => {
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
      res.status(404).json({ error: "Commande introuvable." });
      return;
    }

    if (order.assigned_email.toLowerCase() !== email.toLowerCase()) {
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

    const payload = {
      amount,
      url: `${process.env.FRONTEND_URL || "http://localhost:3000"}/?payment=success&order_id=${order.order_id}`,
      webhook_url: process.env.SLICKPAY_WEBHOOK_URL,
      firstname: email.split("@")[0] || "Client",
      lastname: "Aura Stream",
      email,
      items: order.items && Array.isArray(order.items) && order.items.length > 0 ? order.items : [
        {
          name: `Commande ${order.order_id}`,
          price: amount,
          quantity: 1,
        },
      ],
    };

    const spRes = await fetch(SLICKPAY_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.SLICKPAY_PUBLIC_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    if (!spRes.ok) {
      console.error("SlickPay error:", spRes.status);
      res.status(502).json({ error: "Erreur du prestataire de paiement." });
      return;
    }

    const spData: any = await spRes.json();

    if (spData?.data?.id || spData?.id) {
      await supabase
        .from("orders")
        .update({ invoice_id: String(spData?.data?.id || spData?.id) })
        .eq("order_id", order.order_id);
    }

    res.json({
      payment_url: spData?.url || spData?.data?.url || spData?.payment_url,
      order_id: order.order_id,
      amount,
    });
  } catch (err) {
    console.error("create-invoice error:", err);
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

export default router;
