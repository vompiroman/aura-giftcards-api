import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";

const router: IRouter = Router();

router.get("/gift-cards", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("gift_cards")
      .select("*")
      .eq("available", true);

    if (error) {
      req.log.error({ error }, "Supabase error fetching gift cards");
      res.status(500).json({ error: "Erreur lors de la récupération des cartes cadeaux." });
      return;
    }

    res.json({ gift_cards: data });
  } catch (err) {
    req.log.error({ err }, "Unexpected error in GET /gift-cards");
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

export default router;
