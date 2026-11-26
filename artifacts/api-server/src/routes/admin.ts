import { Router } from "express";
import rateLimit from "express-rate-limit";
import { hasAdminMfa, requireAdmin, requireAdminIdentity, type AuthedRequest } from "../middleware/requireAdmin";
import type { SessionRequest } from "../middleware/webSession";
import { notifyAdmin } from "../lib/notifyAdmin";
import { createAuthClient } from "../lib/supabase";
import { setSessionCookies } from "../lib/sessionCookies";
import { WEB_SESSION_COOKIE } from "../lib/webSession";
import { webSessions } from "../lib/webSessionStore";
import { appendAuditLog } from "../lib/auditLog";

const router = Router();

const testAlertLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false, default: false },
  message: { error: "Trop de tests d'alerte, patientez une minute." },
});

const mfaLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de tentatives. Réessaie dans quelques minutes." },
});

type AdminWebRequest = AuthedRequest & SessionRequest;

async function adminMfaClient(req: AdminWebRequest) {
  const tokens = req.webSession?.tokens;
  if (!tokens || tokens.access_token !== req.adminToken || req.webSession?.row.user_id !== req.adminUserId) return null;
  const auth = createAuthClient().auth;
  const { error } = await auth.setSession(tokens);
  if (error) throw error;
  return auth.mfa;
}

router.get("/admin/security", requireAdminIdentity, async (req: AdminWebRequest, res) => {
  try {
    if (hasAdminMfa(req.adminToken!, req.adminUserId!)) {
      res.json({ verified: true, factors: [] });
      return;
    }
    const mfa = await adminMfaClient(req);
    if (!mfa) {
      res.status(403).json({ error: "Connecte-toi sur le site pour configurer le deuxième facteur." });
      return;
    }
    const { data, error } = await mfa.listFactors();
    if (error) throw error;
    res.json({ verified: false, factors: data.totp.map(({ id, friendly_name }) => ({ id, name: friendly_name })) });
  } catch {
    res.status(503).json({ error: "La double authentification est momentanément indisponible." });
  }
});

router.post("/admin/security/enroll", mfaLimiter, requireAdminIdentity, async (req: AdminWebRequest, res) => {
  try {
    const mfa = await adminMfaClient(req);
    if (!mfa) {
      res.status(403).json({ error: "Connecte-toi sur le site pour configurer le deuxième facteur." });
      return;
    }
    const { data: factors, error: listError } = await mfa.listFactors();
    if (listError) throw listError;
    if (factors.all.some(factor => factor.status === "verified")) {
      res.status(409).json({ error: "Utilise le facteur déjà configuré." });
      return;
    }
    for (const factor of factors.all) {
      const { error } = await mfa.unenroll({ factorId: factor.id });
      if (error) throw error;
    }
    const { data, error } = await mfa.enroll({ factorType: "totp", issuer: "Aura Stream" });
    if (error) throw error;
    res.status(201).json({ id: data.id, secret: data.totp.secret, qr_code: data.totp.qr_code });
  } catch {
    res.status(503).json({ error: "Impossible de configurer le deuxième facteur pour le moment." });
  }
});

router.post("/admin/security/verify", mfaLimiter, requireAdminIdentity, async (req: AdminWebRequest, res) => {
  const { factor_id, code } = req.body || {};
  if (typeof factor_id !== "string" || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(factor_id)
      || typeof code !== "string" || !/^\d{6}$/.test(code)) {
    res.status(400).json({ error: "Saisis le code à six chiffres de ton application." });
    return;
  }
  try {
    const mfa = await adminMfaClient(req);
    if (!mfa) {
      res.status(403).json({ error: "Connecte-toi sur le site pour vérifier le deuxième facteur." });
      return;
    }
    const { data, error } = await mfa.challengeAndVerify({ factorId: factor_id, code });
    if (error) {
      res.status(error.status && error.status >= 500 ? 503 : 400).json({
        error: "Impossible de valider ce code. Vérifie ton application et réessaie.",
      });
      return;
    }
    if (!hasAdminMfa(data.access_token, req.adminUserId!)) throw new Error("Unexpected MFA session");
    await webSessions().revoke(req.cookies[WEB_SESSION_COOKIE]);
    await setSessionCookies(res, { ...data, expires_at: Math.floor(Date.now() / 1000) + data.expires_in }, req.webSession!.row.remember);
    void appendAuditLog({ action: "admin_mfa_verified", actorUserId: req.adminUserId, targetType: "user", targetId: req.adminUserId });
    res.json({ verified: true });
  } catch {
    res.status(503).json({ error: "Impossible de terminer la double authentification pour le moment." });
  }
});

router.post("/admin/test-alert", testAlertLimiter, requireAdmin, async (req: AuthedRequest, res) => {
  const sent = await notifyAdmin(
    `Test d'alerte déclenché par ${req.adminEmail}. Si tu vois cette notification sur ton téléphone, la chaîne d'alerte fonctionne. ✅`,
    {
      level: "critical",
      orderId: "TEST-" + Date.now(),
      service: "Test",
      email: req.adminEmail,
      dedupeKey: "test-alert-" + Date.now(),
    }
  );

  if (sent) {
    res.json({
      ok: true,
      message: "Alerte envoyée à Discord. Vérifie la notification push sur ton mobile.",
    });
  } else {
    res.status(502).json({
      ok: false,
      message:
        "L'alerte n'a pas pu être envoyée. Vérifie DISCORD_ADMIN_WEBHOOK_URL, la connectivité, ou les logs serveur.",
    });
  }
});

export default router;
