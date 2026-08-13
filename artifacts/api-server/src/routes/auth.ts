import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { supabaseAdmin, supabaseAuth as supabase } from "../lib/supabase";
import { isAdmin } from "../middleware/requireAdmin";
import axios from "axios";
import { appendAuditLog } from "../lib/auditLog";
import {
  accessTokenFromRequest,
  clearSessionCookies,
  refreshTokenFromRequest,
  rememberSessionFromRequest,
  setSessionCookies,
} from "../lib/sessionCookies";

const router: IRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de tentatives de connexion. Réessayez dans quelques minutes." },
});

const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de créations de compte. Réessayez plus tard." },
});

const recoveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de tentatives de récupération. Réessayez plus tard." },
});

const profileLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de modifications de profil. Réessayez plus tard." },
});

const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de renouvellements de session. Réessayez dans quelques minutes." },
});

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function validPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 12 && value.length <= 128;
}

function isRecentRecoveryToken(token: string): boolean {
  try {
    const [, encodedPayload] = token.split(".");
    if (!encodedPayload) return false;
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString()) as {
      amr?: Array<{ method?: unknown; timestamp?: unknown }>;
    };
    const nowSeconds = Math.floor(Date.now() / 1000);
    return Array.isArray(payload.amr) && payload.amr.some((entry) => {
      const timestamp = typeof entry?.timestamp === "number" ? entry.timestamp : Number.NaN;
      return entry?.method === "recovery"
        && Number.isFinite(timestamp)
        && timestamp <= nowSeconds + 60
        && nowSeconds - timestamp <= 15 * 60;
    });
  } catch {
    return false;
  }
}

function authApiKey(): string | null {
  const candidate = process.env["SUPABASE_ANON_KEY"] || process.env["SUPABASE_PUBLISHABLE_KEY"] || process.env["SUPABASE_KEY"];
  if (!candidate) return null;
  try {
    const parts = candidate.split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as { role?: unknown };
      if (payload.role === "service_role") return null;
    }
  } catch {
    // New publishable keys are opaque strings and are valid for the Auth API.
  }
  return candidate;
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
    is_admin: isAdmin(user.email, user.app_metadata),
  };
}

function normalizeAlgerianMobile(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "";

  let digits = trimmed.replace(/\D/g, "");
  if (digits.startsWith("00213")) digits = digits.slice(5);
  else if (digits.startsWith("213")) digits = digits.slice(3);
  else if (digits.startsWith("0")) digits = digits.slice(1);
  digits = digits.replace(/^0+/, "");

  return /^[5-7]\d{8}$/.test(digits) ? `+213${digits}` : null;
}


router.post("/register", registrationLimiter, async (req, res) => {
  try {
    const { email, password, full_name, first_name, last_name, phone } = req.body;
    const normalizedEmail = normalizeEmail(email);

    if (!normalizedEmail || !validPassword(password)) {
      res.status(400).json({ error: "Adresse email ou mot de passe invalide (12 à 128 caractères)." });
      return;
    }
    if (
      [full_name, first_name, last_name, phone].some((value) => value !== undefined && typeof value !== "string")
    ) {
      res.status(400).json({ error: "Données de profil invalides." });
      return;
    }
    const safeFullName = typeof full_name === "string" ? full_name.trim().slice(0, 120) : "";
    const safeFirstName = typeof first_name === "string" ? first_name.trim().slice(0, 80) : "";
    const safeLastName = typeof last_name === "string" ? last_name.trim().slice(0, 80) : "";
    const safePhone = typeof phone === "string" ? normalizeAlgerianMobile(phone.slice(0, 32)) : "";
    if (safePhone === null) {
      res.status(400).json({ error: "Numéro de téléphone invalide." });
      return;
    }

    const { data, error } = await supabase.auth.signUp({
      email: normalizedEmail,
      password,
      options: {
        data: {
          full_name: safeFullName,
          first_name: safeFirstName,
          last_name: safeLastName,
          phone: safePhone,
        },
      },
    });

    if (error) {
      req.log.warn({ code: error.code }, "Supabase signUp rejected");
      res.status(400).json({ error: "Impossible de créer le compte avec ces informations." });
      return;
    }

    if (data.session) {
      setSessionCookies(res, data.session, false);
    }
    res.status(201).json({
      authenticated: Boolean(data.session),
      message: "Compte créé. Vérifiez votre email pour confirmer l'inscription.",
      user: publicUser(data.user),
    });
  } catch (err) {
    req.log.error({ errorName: err instanceof Error ? err.name : "unknown" }, "Unexpected error in POST /register");
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
      req.log.warn({ code: error.code }, "Supabase signIn rejected");
      res.status(401).json({ error: "Identifiants invalides." });
      return;
    }

    if (!data.session?.access_token || !data.session.refresh_token || !data.user) {
      req.log.error("Supabase signIn returned no usable session");
      res.status(503).json({ error: "Connexion momentanément indisponible." });
      return;
    }

    setSessionCookies(res, data.session, req.body?.remember === true);

    res.json({
      message: "Connexion réussie.",
      authenticated: true,
      expires_at: data.session.expires_at,
      user: publicUser(data.user),
    });
    if (isAdmin(data.user?.email, data.user?.app_metadata)) {
      void appendAuditLog({
        action: "admin_login",
        actorUserId: data.user?.id,
        targetType: "auth",
        details: { method: "password" },
      });
    }
  } catch (err) {
    req.log.error({ errorName: err instanceof Error ? err.name : "unknown" }, "Unexpected error in POST /login");
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

router.post("/refresh-session", refreshLimiter, async (req, res) => {
  try {
    const refreshToken = refreshTokenFromRequest(req)
      || (typeof req.body?.refresh_token === "string" ? req.body.refresh_token.trim() : "");
    if (
      refreshToken.length < 8
      || refreshToken.length > 4096
      || /[\r\n]/.test(refreshToken)
    ) {
      return res.status(400).json({ error: "Session invalide." });
    }

    const { data, error } = await supabase.auth.refreshSession({
      refresh_token: refreshToken,
    });
    if (error || !data.session?.access_token || !data.session?.refresh_token || !data.user) {
      req.log.warn({ code: error?.code }, "Supabase session refresh rejected");
      return res.status(401).json({ error: "Session expirée. Reconnectez-vous." });
    }

    setSessionCookies(
      res,
      data.session,
      rememberSessionFromRequest(req) || req.body?.remember === true,
    );
    return res.json({
      authenticated: true,
      expires_at: data.session.expires_at,
      user: publicUser(data.user),
    });
  } catch (err) {
    req.log.error({ errorName: err instanceof Error ? err.name : "unknown" }, "Unexpected error in POST /refresh-session");
    return res.status(503).json({ error: "Le renouvellement de session est momentanément indisponible." });
  }
});

router.post("/update-profile", profileLimiter, async (req, res) => {
  try {
    const token = accessTokenFromRequest(req);
    if (!token) {
      res.status(401).json({ error: "Token manquant" });
      return;
    }
    const { first_name, last_name, phone, old_password, password } = req.body;
    const profileData: Record<string, string> = {};
    for (const [key, value] of [["first_name", first_name], ["last_name", last_name], ["phone", phone]] as const) {
      if (value !== undefined) {
        if (typeof value !== "string" || value.length > 120) {
          res.status(400).json({ error: "Données de profil invalides." });
          return;
        }
        const normalizedValue = key === "phone" ? normalizeAlgerianMobile(value) : value.trim();
        if (normalizedValue === null) {
          res.status(400).json({ error: "Numéro de téléphone invalide." });
          return;
        }
        profileData[key] = normalizedValue;
      }
    }
    const updates: any = { data: profileData };
    
    // If attempting to change password
    if (password !== undefined) {
      if (!validPassword(password)) {
        res.status(400).json({ error: "Le nouveau mot de passe doit contenir 12 à 128 caractères." });
        return;
      }
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
    const supabaseKey = authApiKey();
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
    
    res.json({ message: "Profil mis à jour", user: publicUser(response.data) });
  } catch (err: any) {
    req.log.error({
      message: err instanceof Error ? err.message : "unknown",
      status: axios.isAxiosError(err) ? err.response?.status : undefined,
    }, "Unexpected error in POST /update-profile");
    if (axios.isAxiosError(err)) {
      const status = err.response?.status === 401 || err.response?.status === 403 ? 401 : 400;
      res.status(status).json({
        error: status === 401 ? "Token invalide ou expiré." : "Impossible de mettre à jour le profil.",
      });
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
    
    const origin = (process.env.FRONTEND_URL || "https://www.aura-stream.com").replace(/\/$/, "");
    
    const { error } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
      redirectTo: `${origin}/?type=recovery`,
    });
    
    if (error) {
      req.log.warn({ code: error.code }, "Supabase resetPassword rejected");
      res.json({ message: "Si cet email existe, un lien de réinitialisation a été envoyé." });
      return;
    }
    
    res.json({ message: "Si cet email existe, un lien de réinitialisation a été envoyé." });
  } catch (err) {
    req.log.warn({ message: err instanceof Error ? err.message : "unknown" }, "Forgot-password request failed");
    res.json({ message: "Si cet email existe, un lien de réinitialisation a été envoyé." });
  }
});

router.post("/reset-password", recoveryLimiter, async (req, res) => {
  try {
    const { token, password } = req.body;
    if (
      typeof token !== "string"
      || token.length < 20
      || token.length > 4096
      || /[\r\n]/.test(token)
      || !validPassword(password)
    ) {
      res.status(400).json({ error: "Token et mot de passe requis." });
      return;
    }

    const { data: recoveryUser, error: recoveryUserError } = await supabase.auth.getUser(token);
    if (recoveryUserError || !recoveryUser?.user || !isRecentRecoveryToken(token)) {
      res.status(400).json({ error: "Lien de réinitialisation invalide ou expiré." });
      return;
    }
    
    const supabaseUrl = process.env["SUPABASE_URL"];
    const supabaseKey = authApiKey();
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
    
    const { error: revokeError } = await supabaseAdmin.auth.admin.signOut(token, "global");
    if (revokeError) {
      req.log.warn({ code: revokeError.code }, "Supabase session revocation failed after password reset");
    }

    res.json({ message: "Mot de passe réinitialisé avec succès." });
  } catch (err: any) {
    req.log.warn({ message: err instanceof Error ? err.message : "unknown" }, "Reset-password request failed");
    if (axios.isAxiosError(err)) {
      res.status(400).json({ error: "Lien de réinitialisation invalide ou expiré." });
      return;
    }
    res.status(500).json({ error: "Erreur interne." });
  }
});

router.post("/logout", async (req, res) => {
  clearSessionCookies(res);
  try {
    const token = accessTokenFromRequest(req);
    if (!token) {
      res.status(204).send();
      return;
    }

    const { error } = await supabaseAdmin.auth.admin.signOut(token, "local");
    if (error) {
      req.log.warn({ code: error.code }, "Supabase local session revocation rejected");
      res.status(401).json({ error: "Session invalide ou expirée." });
      return;
    }

    res.status(204).send();
    return;
  } catch (err) {
    req.log.error({ message: err instanceof Error ? err.message : "unknown" }, "Unexpected error in POST /logout");
    res.status(503).json({ error: "Déconnexion momentanément indisponible." });
  }
});

router.get("/me", async (req, res) => {
  try {
    const token = accessTokenFromRequest(req);
    if (!token) {
      res.status(401).json({ error: "Token manquant" });
      return;
    }

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    
    if (userError || !userData?.user) {
      res.status(401).json({ error: "Token invalide ou expiré." });
      return;
    }

    res.json({ user: publicUser(userData.user) });
  } catch (err) {
    req.log.error({ errorName: err instanceof Error ? err.name : "unknown" }, "Unexpected error in GET /me");
    res.status(500).json({ error: "Erreur interne." });
  }
});

export default router;
