import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireAdmin } from "../middleware/requireAdmin";
import { supabaseAdmin } from "../lib/supabase";

const router = Router();

const adminReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de requêtes administrateur. Réessayez dans une minute." },
});

router.get("/admin/dashboard", adminReadLimiter, requireAdmin, async (req, res) => {
  const parsedDays = Number.parseInt(String(req.query.days || "30"), 10);
  const days = Number.isFinite(parsedDays) ? Math.max(7, Math.min(parsedDays, 365)) : 30;

  const { data, error } = await supabaseAdmin.rpc("get_admin_dashboard_metrics", {
    p_days: days,
  });

  if (error || !data || typeof data !== "object") {
    req.log?.error({ error }, "Admin dashboard metrics failed");
    return res.status(503).json({ error: "Les statistiques administrateur sont momentanément indisponibles." });
  }

  return res.json({
    generated_at: new Date().toISOString(),
    period_days: days,
    ...(data as Record<string, unknown>),
  });
});

router.get("/admin/audit-logs", adminReadLimiter, requireAdmin, async (req, res) => {
  const parsedLimit = Number.parseInt(String(req.query.limit || "30"), 10);
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 100)) : 30;

  const { data, error } = await supabaseAdmin
    .from("audit_logs")
    .select("id, created_at, action, target_type, target_id, details")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    req.log?.error({ error }, "Admin audit log read failed");
    return res.status(503).json({ error: "Le journal d’activité est momentanément indisponible." });
  }

  return res.json({ events: data || [] });
});

export default router;
