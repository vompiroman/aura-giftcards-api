import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";

const router: IRouter = Router();

const WEBHOOK_SECRET = process.env["WEBHOOK_SECRET"];

router.post("/webhook", async (req, res) => {
  try {
    const secret = req.headers["x-webhook-secret"];

    if (!secret || secret !== WEBHOOK_SECRET) {
      req.log.warn("Webhook: secret invalide ou manquant");
      res.status(401).json({ error: "Non autorisé." });
      return;
    }

    const { order_id, completed } = req.body;
    req.log.info({ order_id, completed }, "Webhook SlickPay reçu");

    if (!order_id) {
      res.status(400).json({ error: "order_id est requis." });
      return;
    }

    if (completed === 1) {
      const { data: order, error: fetchError } = await supabase
        .from("orders")
        .select("gift_card_id")
        .eq("order_id", order_id)
        .single();

      if (fetchError) {
        req.log.error({ fetchError }, "Erreur lors de la récupération de la commande");
      }

      const { error: orderError } = await supabase
        .from("orders")
        .update({ status: "completed" })
        .eq("order_id", order_id);

      if (orderError) {
        req.log.error({ orderError }, "Erreur lors de la mise à jour du statut de la commande");
      }

      if (order?.gift_card_id) {
        const { error: cardError } = await supabase
          .from("gift_cards")
          .update({ available: false, status: "sold" })
          .eq("id", order.gift_card_id);

        if (cardError) {
          req.log.error({ cardError }, "Erreur lors du marquage de la carte cadeau comme vendue");
        }
      }

      req.log.info({ order_id }, "Paiement réussi — commande et carte cadeau mises à jour");
    } else {
      const { error: orderError } = await supabase
        .from("orders")
        .update({ status: "failed" })
        .eq("order_id", order_id);

      if (orderError) {
        req.log.error({ orderError }, "Erreur lors de la mise à jour du statut échoué");
      }

      req.log.info({ order_id, completed }, "Paiement échoué — commande marquée comme failed");
    }

    res.json({ received: true });
  } catch (err) {
    req.log.error({ err }, "Unexpected error in POST /webhook");
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

export default router;
