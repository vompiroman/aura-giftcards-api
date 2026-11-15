import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { createAuthClient, supabaseAdmin, supabaseAuth as supabase } from "../lib/supabase";
import { createSessionRefresher } from "../lib/sessionRefresh";
import { isTemporaryAuthError } from "../lib/authAvailability";
import { webSessions } from "../lib/webSessionStore";
import { WEB_SESSION_COOKIE } from "../lib/webSession";
import type { SessionRequest } from "../middleware/webSession";
import { isAdmin } from "../middleware/requireAdmin";
import axios from "axios";
import { appendAuditLog } from "../lib/auditLog";
import {
  REMEMBER_COOKIE_NAME,
  accessTokenFromRequest,
  clearSessionCookies,
  refreshTokenFromRequest,
  rememberSessionFromRequest,
  setSessionCookies,
} from "../lib/sessionCookies";
import { normalizeAlgerianMobile } from "../lib/phone";
import { getPurchaseEmailConfig, sendPasswordRecoveryEmail } from "../lib/purchaseEmail";
import { PARTNER_ENABLED, AUTO_APPROVE_PARTNERS } from "../config/partnerTiers";
import { partnerQuestionnaire } from "./partners";

const router: IRouter = Router();
const refreshSession = createSessionRefresher(() => createAuthClient());

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

function validRecoveryHash(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{20,512}$/.test(value);
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
    const wantsPartner = req.body?.partner_application !== undefined;
    const partnerAnswers = wantsPartner ? partnerQuestionnaire.safeParse(req.body.partner_application) : null;
    if (wantsPartner && (!PARTNER_ENABLED() || !partnerAnswers?.success)) {
      res.status(400).json({error:"Vérifie les réponses au questionnaire."});
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

    let partnerApplicationSaved = false;
    // Supabase can return an obfuscated user on a duplicate signup. An empty
    // identities array is not proof a new account was created.
    if (partnerAnswers?.success && data.user?.id) {
      try {
        if (data.session) {
          const {error: partnerError} = await supabaseAdmin.rpc("submit_partner_application", {
            p_user:data.user.id,p_email:normalizedEmail,p_answers:partnerAnswers.data,p_auto:AUTO_APPROVE_PARTNERS(),
          });
          partnerApplicationSaved = !partnerError;
        } else if (data.user.identities?.length) {
          const {error: partnerError} = await supabaseAdmin.from("partner_signup_drafts")
            .insert({user_id:data.user.id,answers:partnerAnswers.data});
          if (partnerError) req.log?.warn({code:partnerError.code},"Partner questionnaire could not be stored");
        }
      } catch {
        req.log?.warn("Partner questionnaire could not be stored");
      }
    }
    if (data.session) {
      await setSessionCookies(res, { ...data.session, user: data.user! }, true);
    }
    res.status(201).json({
      authenticated: Boolean(data.session),
      ...(data.session && wantsPartner ? {partner_application_saved:partnerApplicationSaved} : {}),
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

    // Persistent sessions are the default for the customer experience. A
    // caller can still explicitly opt out on a shared or public device.
    await setSessionCookies(res, { ...data.session, user: data.user }, req.body?.remember !== false);
    let partnerApplicationSubmitted = false;
    if (PARTNER_ENABLED() && data.user.email) {
      try {
        const {data: draft} = await supabaseAdmin.from("partner_signup_drafts")
          .select("answers").eq("user_id",data.user.id).maybeSingle();
        const answers = partnerQuestionnaire.safeParse(draft?.answers);
        if (answers.success) {
          const {error: partnerError} = await supabaseAdmin.rpc("submit_partner_application",{
            p_user:data.user.id,p_email:data.user.email.trim().toLowerCase(),p_answers:answers.data,p_auto:AUTO_APPROVE_PARTNERS(),
          });
          partnerApplicationSubmitted = !partnerError || partnerError.message === "PARTNER_ALREADY_APPLIED";
        }
      } catch {
        // A transient partner failure must not stop account sign-in.
        req.log?.warn("Partner signup draft could not be finalized");
      }
    }

    res.json({
      message: "Connexion réussie.",
      authenticated: true,
      ...(partnerApplicationSubmitted ? {partner_application_submitted:true} : {}),
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
    
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({
      type: "recovery",
      email: normalizedEmail,
    });

    const tokenHash = data?.properties?.hashed_token;
    const emailConfig = getPurchaseEmailConfig();
    if (error || !validRecoveryHash(tokenHash)) {
      req.log.warn({ code: error?.code || "RECOVERY_LINK_MISSING" }, "Supabase recovery link generation rejected");
      res.json({ message: "Si cet email existe, un lien de réinitialisation a été envoyé." });
      return;
    }

    if (!emailConfig) {
      req.log.warn({ code: "TRANSACTIONAL_EMAIL_NOT_CONFIGURED" }, "Password recovery email disabled");
      res.json({ message: "Si cet email existe, un lien de réinitialisation a été envoyé." });
      return;
    }

    try {
      const frontendUrl = process.env.FRONTEND_URL || "";
      const configured = URL.canParse(frontendUrl) ? new URL(frontendUrl) : null;
      const origin = configured?.protocol === "https:" && configured.hostname !== "localhost"
        ? configured.origin : "https://www.aura-stream.com";
      const link = new URL("/", origin);
      link.hash = new URLSearchParams({ type: "recovery", token_hash: tokenHash }).toString();
      await sendPasswordRecoveryEmail(normalizedEmail, link.href, emailConfig);
    } catch (emailError) {
      const code = typeof (emailError as { code?: unknown })?.code === "string"
        ? String((emailError as { code: string }).code).slice(0, 100)
        : "RECOVERY_EMAIL_SEND_FAILED";
      req.log.warn({ code }, "Password recovery email failed");
    }

    res.json({ message: "Si cet email existe, un lien de réinitialisation a été envoyé." });
  } catch (err) {
    req.log.warn({ message: err instanceof Error ? err.message : "unknown" }, "Forgot-password request failed");
    res.json({ message: "Si cet email existe, un lien de réinitialisation a été envoyé." });
  }
});

router.post("/reset-password", recoveryLimiter, async (req, res) => {
  try {
    const { token: legacyToken, token_hash: tokenHash, password } = req.body;
    const usingHash = tokenHash !== undefined;
    const validToken = usingHash ? validRecoveryHash(tokenHash) && legacyToken === undefined
      : typeof legacyToken === "string" && legacyToken.length >= 20 && legacyToken.length <= 4096
        && !/[\r\n]/.test(legacyToken);
    if (!validToken || !validPassword(password)) {
      res.status(400).json({ error: "Token et mot de passe requis." });
      return;
    }

    const supabaseUrl = process.env["SUPABASE_URL"];
    const supabaseKey = authApiKey();
    if (!supabaseUrl || !supabaseKey) {
      res.status(503).json({ error: "Service d'authentification indisponible." });
      return;
    }

    let token: string;
    let userId: string;
    if (usingHash) {
      // A mail scanner may open the link. Consume it only when the form is submitted.
      const { data, error } = await createAuthClient().auth.verifyOtp({ type: "recovery", token_hash: tokenHash });
      if (error || !data.session?.access_token || !data.user?.id) {
        res.status(400).json({ error: "Lien de réinitialisation invalide ou expiré." });
        return;
      }
      token = data.session.access_token;
      userId = data.user.id;
    } else {
      token = legacyToken;
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data.user?.id || !isRecentRecoveryToken(token)) {
        res.status(400).json({ error: "Lien de réinitialisation invalide ou expiré." });
        return;
      }
      userId = data.user.id;
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

    await webSessions().revokeUser(userId);
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
  try {
    const cookie = req.cookies?.[WEB_SESSION_COOKIE];
    if (cookie) await webSessions().revoke(cookie);
    clearSessionCookies(res);
    const token = accessTokenFromRequest(req);
    if (token) {
      const { error } = await supabaseAdmin.auth.admin.signOut(token, "local");
      if (error) req.log.warn({ code: error.code }, "Legacy session revocation rejected");
    }
    res.status(204).send();
  } catch {
    res.status(503).json({ error: "Déconnexion momentanément indisponible." });
  }
});

async function restoreWebSession(req: SessionRequest, res: import("express").Response) {
  res.setHeader("Cache-Control", "no-store");
  try {
    const cookie = req.cookies?.[WEB_SESSION_COOKIE];
    let resolved = req.webSession;
    if (cookie && !resolved) return res.json({ authenticated: false, user: null });
    if (resolved) {
      let result = await supabase.auth.getUser(resolved.tokens.access_token);
      if (isTemporaryAuthError(result.error)) return res.status(503).json({ error: "Service de connexion momentanément indisponible." });
      if (result.error || !result.data.user) {
        resolved = await webSessions().resolve(cookie, true);
        if (!resolved) return res.json({ authenticated: false, user: null });
        result = await supabase.auth.getUser(resolved.tokens.access_token);
      }
      if (isTemporaryAuthError(result.error)) return res.status(503).json({ error: "Service de connexion momentanément indisponible." });
      if (result.error || !result.data.user || result.data.user.id !== resolved.row.user_id) {
        await webSessions().revoke(cookie);
        return res.json({ authenticated: false, user: null });
      }
      return res.json({ authenticated: true, expires_at: resolved.tokens.expires_at, user: publicUser(result.data.user) });
    }

    // One-time upgrade of sessions issued by the old two-token cookie system.
    const legacyToken = refreshTokenFromRequest(req)
      || (req.path === "/refresh-session" && typeof req.body?.refresh_token === "string" ? req.body.refresh_token.trim() : "");
    if (!legacyToken) return res.json({ authenticated: false, user: null });
    if (legacyToken.length < 8 || legacyToken.length > 4096 || /[\r\n]/.test(legacyToken)) {
      return res.status(400).json({ error: "Session invalide." });
    }
    const { data, error } = await refreshSession(legacyToken);
    if (isTemporaryAuthError(error)) return res.status(503).json({ error: "Service de connexion momentanément indisponible." });
    if (error) {
      req.log.warn({ code: error.code, status: error.status }, "Legacy session upgrade rejected");
      return res.json({ authenticated: false, user: null });
    }
    if (!data.session?.access_token || !data.session.refresh_token || !data.session.expires_at || !data.user) {
      return res.status(503).json({ error: "Service de connexion momentanément indisponible." });
    }
    await setSessionCookies(res, { ...data.session, user: data.user },
      rememberSessionFromRequest(req) || !req.cookies?.[REMEMBER_COOKIE_NAME]);
    return res.json({ authenticated: true, expires_at: data.session.expires_at, user: publicUser(data.user) });
  } catch {
    return res.status(503).json({ error: "Service de connexion momentanément indisponible." });
  }
}

router.post("/session", refreshLimiter, restoreWebSession);
router.post("/refresh-session", refreshLimiter, restoreWebSession);
router.get("/me", async (req, res) => {
  try {
    const token = accessTokenFromRequest(req);
    if (!token) {
      res.status(401).json({ error: "Token manquant" });
      return;
    }

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    
    if (isTemporaryAuthError(userError)) {
      res.status(503).json({ error: "Service d'authentification indisponible." });
      return;
    }
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
