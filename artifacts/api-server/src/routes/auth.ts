import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { supabaseAuth as supabase } from "../lib/supabase";
import { isAdmin } from "../middleware/requireAdmin";
import axios from "axios";

const router: IRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de tentatives de connexion. RÃƒÂ©essayez dans quelques minutes." },
});

const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de crÃƒÂ©ations de compte. RÃƒÂ©essayez plus tard." },
});

const recoveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de tentatives de rÃƒÂ©cupÃƒÂ©ration. RÃƒÂ©essayez plus tard." },
});

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function validPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= 128;
}

function bearerToken(req: any): string | null {
  const value = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  if (!/^Bearer\s+/i.test(value)) return null;
  const token = value.replace(/^Bearer\s+/i, "").trim();
  return token || null;
}

function publicUser(user: any) {
  if (!user) return null;
  const metadata = user.user_metadata || {};
  return {
    id: user.id,
    email: user.email,
    user_metadata: {
      full_name: metadata.full_name,
      first_name: metadata.first_name,
      last_name: metadata.last_name,
      phone: metadata.phone,
      cart: Array.isArray(metadata.cart) ? metadata.cart : undefined,
    },
    is_admin: isAdmin(user.email),
  };
}


router.post("/register", registrationLimiter, async (req, res) => {
  try {
    const { email, password, full_name } = req.body;
    const normalizedEmail = normalizeEmail(email);

    if (!normalizedEmail || !validPassword(password)) {
      res.status(400).json({ error: "Adresse email ou mot de passe invalide (8 ÃƒÂ  128 caractÃƒÂ¨res)." });
      return;
    }
    const safeFullName = typeof full_name === "string" ? full_name.trim().slice(0, 120) : "";

    const { data, error } = await supabase.auth.signUp({
      email: normalizedEmail,
      password,
      options: {
        data: { full_name: safeFullName },
      },
    });

    if (error) {
      req.log.error({ error }, "Erreur Supabase signUp");
      res.status(400).json({ error: error.message });
      return;
    }

    res.status(201).json({
      message: "Compte crÃƒÂ©ÃƒÂ©. VÃƒÂ©rifiez votre email pour confirmer l'inscription.",
      user: data.user,
    });
  } catch (err) {
    req.log.error({ err }, "Unexpected error in POST /register");
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

router.post("/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = normalizeEmail(email);

    if (!normalizedEmail || typeof password !== "string" || password.length > 128) {
      res.status(400).json({ error: "Adresse email ou mot de passe invalide." });
      return;
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email: normalizedEmail,
      password,
    });

    if (error) {
      req.log.error({ error }, "Erreur Supabase signIn");
      res.status(401).json({ error: error.message });
      return;
    }

    res.json({
      message: "Connexion rÃƒÂ©ussie.",
      access_token: data.session?.access_token,
      expires_at: data.session?.expires_at,
      user: publicUser(data.user),
    });
  } catch (err) {
    req.log.error({ err }, "Unexpected error in POST /login");
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

router.post("/update-profile", async (req, res) => {
  try {
    const token = bearerToken(req);
    if (!token) {
      res.status(401).json({ error: "Token manquant" });
      return;
    }
    const { first_name, last_name, phone, old_password, password } = req.body;
    const profileData: Record<string, string> = {};
    for (const [key, value] of [["first_name", first_name], ["last_name", last_name], ["phone", phone]] as const) {
      if (value !== undefined) {
        if (typeof value !== "string" || value.length > 120) {
          res.status(400).json({ error: "DonnÃƒÂ©es de profil invalides." });
          return;
        }
        profileData[key] = value.trim();
      }
    }
    const updates: any = { data: profileData };
    
    // If attempting to change password
    if (password !== undefined) {
      if (!validPassword(password)) {
        res.status(400).json({ error: "Le nouveau mot de passe doit contenir 8 ÃƒÂ  128 caractÃƒÂ¨res." });
        return;
      }
      if (!old_password) {
        res.status(400).json({ error: "L'ancien mot de passe est requis pour le modifier." });
        return;
      }
      
      // Verify old password
      const { data: userData, error: userError } = await supabase.auth.getUser(token);
      if (userError || !userData?.user?.email) {
        res.status(401).json({ error: "Token invalide ou expirÃƒÂ©." });
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
    const supabaseKey = process.env["SUPABASE_ANON_KEY"] || process.env["SUPABASE_SERVICE_ROLE_KEY"] || process.env["SUPABASE_KEY"];
    if (!supabaseUrl || !supabaseKey) {
      res.status(503).json({ error: "Service d'authentification indisponible." });
      return;
    }
    
    const response = await axios.put(`${supabaseUrl}/auth/v1/user`, updates, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: supabaseKey as string,
        "Content-Type": "application/json"
      }
    });
    
    res.json({ message: "Profil mis ÃƒÂ  jour", user: response.data });
  } catch (err: any) {
    req.log.error({ err }, "Unexpected error in POST /update-profile");
    if (axios.isAxiosError(err)) {
      res.status(err.response?.status || 400).json({ error: err.response?.data?.msg || err.message });
      return;
    }
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

router.post("/forgot-password", recoveryLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
      res.status(400).json({ error: "L'adresse email est requise." });
      return;
    }
    
    const origin = (process.env.FRONTEND_URL || "https://aura-stream.netlify.app").replace(/\/$/, "");
    
    const { error } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
      redirectTo: `${origin}/?type=recovery`,
    });
    
    if (error) {
      req.log.error({ error }, "Erreur Supabase resetPassword");
      res.status(400).json({ error: error.message });
      return;
    }
    
    res.json({ message: "Si cet email existe, un lien de rÃƒÂ©initialisation a ÃƒÂ©tÃƒÂ© envoyÃƒÂ©." });
  } catch (err) {
    req.log.error({ err }, "Unexpected error in POST /forgot-password");
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

router.post("/reset-password", recoveryLimiter, async (req, res) => {
  try {
    const { token, password } = req.body;
    if (typeof token !== "string" || token.length < 20 || !validPassword(password)) {
      res.status(400).json({ error: "Token et mot de passe requis." });
      return;
    }
    
    const supabaseUrl = process.env["SUPABASE_URL"];
    const supabaseKey = process.env["SUPABASE_ANON_KEY"] || process.env["SUPABASE_SERVICE_ROLE_KEY"] || process.env["SUPABASE_KEY"];
    if (!supabaseUrl || !supabaseKey) {
      res.status(503).json({ error: "Service d'authentification indisponible." });
      return;
    }
    
    const response = await axios.put(`${supabaseUrl}/auth/v1/user`, { password }, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: supabaseKey as string,
        "Content-Type": "application/json"
      }
    });
    
    res.json({ message: "Mot de passe rÃƒÂ©initialisÃƒÂ© avec succÃƒÂ¨s." });
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
    const token = bearerToken(req);
    if (!token) {
      res.status(401).json({ error: "Token manquant" });
      return;
    }

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    
    if (userError || !userData?.user) {
      res.status(401).json({ error: "Token invalide ou expirÃƒÂ©." });
      return;
    }

    res.json({ user: publicUser(userData.user) });
  } catch (err) {
    req.log.error({ err }, "Unexpected error in GET /me");
    res.status(500).json({ error: "Erreur interne." });
  }
});

export default router;
