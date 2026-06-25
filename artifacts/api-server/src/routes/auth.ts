import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabase";

const router: IRouter = Router();

router.post("/register", async (req, res) => {
  try {
    const { email, password, full_name } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: "email et password sont requis." });
      return;
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: full_name ?? "" },
      },
    });

    if (error) {
      req.log.error({ error }, "Erreur Supabase signUp");
      res.status(400).json({ error: error.message });
      return;
    }

    res.status(201).json({
      message: "Compte créé. Vérifiez votre email pour confirmer l'inscription.",
      user: data.user,
    });
  } catch (err) {
    req.log.error({ err }, "Unexpected error in POST /register");
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: "email et password sont requis." });
      return;
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      req.log.error({ error }, "Erreur Supabase signIn");
      res.status(401).json({ error: error.message });
      return;
    }

    res.json({
      message: "Connexion réussie.",
      session: data.session,
      user: data.user,
    });
  } catch (err) {
    req.log.error({ err }, "Unexpected error in POST /login");
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

export default router;
