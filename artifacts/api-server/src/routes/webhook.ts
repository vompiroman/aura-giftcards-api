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

    const event = req.body;
    req.log.info({ event }, "Webhook reçu");

    if (event.type === "payment.succeeded") {
      const invoiceId = event.data?.invoice_id;
      const giftCardId = event.data?.metadata?.gift_card_id;

      if (giftCardId) {
        const { error } = await supabase
          .from("gift_cards")
          .update({ available: false, sold_invoice_id: invoiceId })
          .eq("id", giftCardId);

        if (error) {
          req.log.error({ error }, "Erreur lors de la mise à jour de la carte cadeau");
        }
      }

      const { error: orderError } = await supabase.from("orders").insert([
        {
          invoice_id: invoiceId,
          gift_card_id: giftCardId ?? null,
          amount: event.data?.amount,
          customer_email: event.data?.customer_email,
          status: "paid",
          raw_event: event,
        },
      ]);

      if (orderError) {
        req.log.error({ orderError }, "Erreur lors de l'enregistrement de la commande");
      }
    }

    res.json({ received: true });
  } catch (err) {
    req.log.error({ err }, "Unexpected error in POST /webhook");
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

export default router;
