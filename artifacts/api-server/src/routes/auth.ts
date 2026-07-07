import { Router, type IRouter } from "express";
import { supabaseAuth as supabase } from "../lib/supabase";
import axios from "axios";

const router: IRouter = Router();

router.get("/diag-role", async (req, res) => {
  const k = process.env["SUPABASE_SERVICE_ROLE_KEY"] || process.env["SUPABASE_KEY"] || "";
  let role = "unknown";
  try {
    const parts = k.split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      role = payload.role;
    }
  } catch (e) {}
  res.json({
    status: "ok",
    role,
    has_service_role_var: Boolean(process.env["SUPABASE_SERVICE_ROLE_KEY"]),
    has_slickpay_key: Boolean(process.env.SLICKPAY_PUBLIC_KEY || process.env.SLICKPAY_API_KEY),
    has_slickpay_webhook: Boolean(process.env.SLICKPAY_WEBHOOK_URL),
    commit: "slickpay_address_1"
  });
});

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

router.post("/update-profile", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.status(401).json({ error: "Token manquant" });
      return;
    }
    const token = authHeader.replace("Bearer ", "");
    
    const { first_name, last_name, phone, old_password, password } = req.body;
    
    const updates: any = { data: { first_name, last_name, phone } };
    
    // If attempting to change password
    if (password && password.trim().length >= 6) {
      if (!old_password) {
        res.status(400).json({ error: "L'ancien mot de passe est requis pour le modifier." });
        return;
      }
      
      // Verify old password
      const { data: userData, error: userError } = await supabase.auth.getUser(token);
      if (userError || !userData?.user?.email) {
        res.status(401).json({ error: "Token invalide ou expiré." });
        return;
      }
      
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: userData.user.email,
        password: old_password,
      });
      
      if (signInError) {
        res.status(401).json({ error: "L'ancien mot de passe est incorrect." });
        return;
      }
      
      updates.password = password;
    }
    
    // Call Supabase Auth REST API directly to bypass SDK session requirement
    const supabaseUrl = process.env["SUPABASE_URL"];
    const supabaseKey = process.env["SUPABASE_KEY"];
    
    const response = await axios.put(`${supabaseUrl}/auth/v1/user`, updates, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: supabaseKey as string,
        "Content-Type": "application/json"
      }
    });
    
    res.json({ message: "Profil mis à jour", user: response.data });
  } catch (err: any) {
    req.log.error({ err }, "Unexpected error in POST /update-profile");
    if (axios.isAxiosError(err)) {
      res.status(err.response?.status || 400).json({ error: err.response?.data?.msg || err.message });
      return;
    }
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      res.status(400).json({ error: "L'adresse email est requise." });
      return;
    }
    
    const origin = req.headers.origin || "http://localhost:3000";
    
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${origin}/?type=recovery`,
    });
    
    if (error) {
      req.log.error({ error }, "Erreur Supabase resetPassword");
      res.status(400).json({ error: error.message });
      return;
    }
    
    res.json({ message: "Si cet email existe, un lien de réinitialisation a été envoyé." });
  } catch (err) {
    req.log.error({ err }, "Unexpected error in POST /forgot-password");
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

router.post("/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      res.status(400).json({ error: "Token et mot de passe requis." });
      return;
    }
    
    const supabaseUrl = process.env["SUPABASE_URL"];
    const supabaseKey = process.env["SUPABASE_KEY"];
    
    const response = await axios.put(`${supabaseUrl}/auth/v1/user`, { password }, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: supabaseKey as string,
        "Content-Type": "application/json"
      }
    });
    
    res.json({ message: "Mot de passe réinitialisé avec succès." });
  } catch (err: any) {
    req.log.error({ err }, "Unexpected error in POST /reset-password");
    if (axios.isAxiosError(err)) {
      res.status(err.response?.status || 400).json({ error: err.response?.data?.msg || err.message });
      return;
    }
    res.status(500).json({ error: "Erreur interne." });
  }
});

router.get("/me", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.status(401).json({ error: "Token manquant" });
      return;
    }
    const token = authHeader.replace("Bearer ", "");

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    
    if (userError || !userData?.user) {
      res.status(401).json({ error: "Token invalide ou expiré." });
      return;
    }

    res.json({ user: userData.user });
  } catch (err) {
    req.log.error({ err }, "Unexpected error in GET /me");
    res.status(500).json({ error: "Erreur interne." });
  }
});

export default router;
