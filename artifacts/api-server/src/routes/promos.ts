import { Router } from "express";
import { requireAdmin, type AuthedRequest } from "../middleware/requireAdmin";
import { supabaseAdmin } from "../lib/supabase";
import { hashPromoCode, normalizePromoCode, presentPromoCode } from "../lib/promos";
import { appendAuditLog } from "../lib/auditLog";

const router = Router();
const admin = requireAdmin;
const PROMO_FIELDS = "id, code_prefix, discount_type, discount_value, starts_at, ends_at, max_uses, max_uses_per_client, services, active, created_at";

router.get("/admin/promo-codes", admin, async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from("promo_codes")
    .select(`${PROMO_FIELDS}, promo_redemptions(count)`)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: "Impossible de charger les codes promo." });
  return res.json({ promo_codes: (data || []).map((promo: any) => presentPromoCode(promo)) });
});

router.post("/admin/promo-codes", admin, async (req: AuthedRequest, res) => {
  const code = normalizePromoCode(req.body?.code);
  const type = req.body?.discount_type;
  const value = Number(req.body?.discount_value);
  const maxUses = req.body?.max_uses === null || req.body?.max_uses === undefined
    ? null : Number(req.body.max_uses);
  const maxUsesPerClient = req.body?.max_uses_per_client === null || req.body?.max_uses_per_client === undefined
    ? null : Number(req.body.max_uses_per_client);
  const startsAt = req.body?.starts_at ? new Date(req.body.starts_at) : null;
  const endsAt = req.body?.ends_at ? new Date(req.body.ends_at) : null;
  const services = Array.isArray(req.body?.services)
    ? req.body.services.filter((s: unknown): s is string => typeof s === "string").map((s: string) => s.toLowerCase())
    : [];
  const validServices = new Set(["netflix", "spotify", "crunchyroll"]);
  if (!code || !["fixed", "percentage"].includes(type) || !Number.isFinite(value) || value <= 0
    || (type === "fixed" && value > 1_000_000)
    || (type === "percentage" && value > 100)
    || (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1_000_000))
    || (maxUsesPerClient !== null && (!Number.isInteger(maxUsesPerClient) || maxUsesPerClient < 1 || maxUsesPerClient > 1_000_000))
    || (startsAt && Number.isNaN(startsAt.getTime()))
    || (endsAt && Number.isNaN(endsAt.getTime()))
    || (startsAt && endsAt && startsAt >= endsAt)
    || services.length > 10
    || services.some((service: string) => !validServices.has(service))) {
    return res.status(400).json({ error: "Paramètres du code promo invalides." });
  }
  const { data, error } = await supabaseAdmin.from("promo_codes").insert({
    code_hash: hashPromoCode(code),
    code_prefix: code.slice(0, 4),
    discount_type: type,
    discount_value: value,
    starts_at: startsAt?.toISOString() || null,
    ends_at: endsAt?.toISOString() || null,
    max_uses: maxUses,
    max_uses_per_client: maxUsesPerClient,
    services,
    active: req.body?.active !== false,
  }).select(PROMO_FIELDS).single();
  if (error) return res.status(409).json({ error: "Ce code promo existe déjà ou est invalide." });
  void appendAuditLog({
    action: "admin_promo_create",
    actorUserId: req.adminUserId,
    targetType: "promo_code",
    targetId: data?.id,
    details: { code_prefix: code.slice(0, 4), discount_type: type },
  });
  return res.status(201).json({ code, promo_code: presentPromoCode(data || {}, 0) });
});

async function updatePromo(req: AuthedRequest, res: any) {
  const promoId = String(req.params.id || req.body?.id || "");
  const updates: Record<string, unknown> = {};
  for (const key of ["discount_type", "discount_value", "starts_at", "ends_at", "max_uses", "max_uses_per_client", "services", "active"]) {
    if (req.body?.[key] !== undefined) updates[key] = req.body[key];
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(promoId)
    || Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "Modification du code promo invalide." });
  }
  const { data, error } = await supabaseAdmin.from("promo_codes").update(updates).eq("id", promoId)
    .select(PROMO_FIELDS).single();
  if (error || !data) return res.status(404).json({ error: "Code promo introuvable." });
  const { count } = await supabaseAdmin.from("promo_redemptions")
    .select("id", { count: "exact", head: true })
    .eq("promo_code_id", promoId);
  void appendAuditLog({
    action: "admin_promo_update",
    actorUserId: req.adminUserId,
    targetType: "promo_code",
    targetId: promoId,
    details: { fields: Object.keys(updates) },
  });
  return res.json({ promo_code: presentPromoCode(data, count || 0) });
}

// REST contract, plus compatibility with the current admin UI which sends
// PATCH /admin/promo-codes with { id, active }.
router.patch("/admin/promo-codes", admin, updatePromo);
router.patch("/admin/promo-codes/:id", admin, updatePromo);

router.delete("/admin/promo-codes/:id", admin, async (req: AuthedRequest, res) => {
  const promoId = String(req.params.id || "");
  const { error } = await supabaseAdmin.from("promo_codes").update({ active: false }).eq("id", promoId);
  if (error) return res.status(404).json({ error: "Code promo introuvable." });
  void appendAuditLog({
    action: "admin_promo_deactivate",
    actorUserId: req.adminUserId,
    targetType: "promo_code",
    targetId: promoId,
  });
  return res.json({ success: true });
});

export default router;
