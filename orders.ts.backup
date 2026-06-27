import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";
import { v4 as uuidv4 } from "uuid";

const router: IRouter = Router();

router.post("/create-order", async (req, res) => {
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

    const { items, amount } = req.body;
    if (!items || !amount) {
      res.status(400).json({ error: "Les items et le montant sont requis." });
      return;
    }

    const orderId = uuidv4();
    const assignedEmail = userData.user.email;

    // TODO: Depending on the schema, items might be saved in a specific way or as JSON
    const { error: insertError } = await supabase
      .from("orders")
      .insert({
        order_id: orderId,
        assigned_email: assignedEmail,
        status: "pending",
        // Assuming there is a details or items column, or maybe not. We will just save what we can.
      });

    if (insertError) {
      req.log.error({ insertError }, "Supabase error creating order");
      res.status(500).json({ error: "Erreur lors de la création de la commande." });
      return;
    }

    res.status(201).json({ order_id: orderId });
  } catch (err) {
    req.log.error({ err }, "Unexpected error in POST /create-order");
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

router.get("/my-orders", async (req, res) => {
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

    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("assigned_email", userData.user.email)
      // .order("created_at", { ascending: false }); // Supabase will order if column exists

    if (error) {
      req.log.error({ error }, "Supabase error fetching orders");
      res.status(500).json({ error: "Erreur lors de la récupération des commandes." });
      return;
    }

    res.json({ orders: data });
  } catch (err) {
    req.log.error({ err }, "Unexpected error in GET /my-orders");
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

export default router;
