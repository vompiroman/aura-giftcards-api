import { Router, type Response } from "express";
import rateLimit from "express-rate-limit";
import { requireAdmin, type AuthedRequest } from "../middleware/requireAdmin";
import { supabaseAdmin, supabaseAuth } from "../lib/supabase";
import { computeCart } from "../config/prices";
import {
  calculatePromoDiscount,
  clientPromoHash,
  hashPromoCode,
  normalizePromoCode,
  presentPromoCode,
  promoIsActive,
  promoSupportsItems,
  promoUsageExhausted,
  type PromoDefinition,
} from "../lib/promos";
import { appendAuditLog } from "../lib/auditLog";

const router = Router();
const PROMO_FIELDS = [
  "id",
  "code_prefix",
  "discount_type",
  "discount_value",
  "starts_at",
  "ends_at",
  "max_uses",
  "max_uses_per_client",
  "services",
  "active",
  "created_at",
  "created_by",
].join(", ");
const PROMO_UPDATE_FIELDS = new Set([
  "discount_type",
  "discount_value",
  "starts_at",
  "ends_at",
  "max_uses",
  "max_uses_per_client",
  "services",
  "active",
]);
const VALID_SERVICES = new Set(["netflix", "spotify", "crunchyroll"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const promoValidationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de validations de codes promo. Réessayez dans une minute." },
});

const adminPromoWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de modifications. Réessayez dans une minute." },
});

function parseNullablePositiveInteger(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000_000) return undefined;
  return parsed;
}

function parsePromoDefinition(
  input: Record<string, unknown>,
  current?: Record<string, unknown>,
): { ok: true; value: PromoDefinition & { active: boolean } } | { ok: false } {
  const merged = { ...(current || {}), ...input };
  const rawType = merged.discount_type === "percent" ? "percentage" : merged.discount_type;
  const discountType = rawType === "fixed" || rawType === "percentage" ? rawType : null;
  const discountValue = Number(merged.discount_value);
  const maxUses = parseNullablePositiveInteger(merged.max_uses);
  const maxUsesPerClient = parseNullablePositiveInteger(merged.max_uses_per_client);
  const startsAt = merged.starts_at ? new Date(String(merged.starts_at)) : null;
  const endsAt = merged.ends_at ? new Date(String(merged.ends_at)) : null;
  const services = Array.isArray(merged.services)
    ? [...new Set(merged.services
      .filter((service): service is string => typeof service === "string")
      .map((service) => service.trim().toLowerCase())
      .filter(Boolean))]
    : [];

  if (!discountType
    || !Number.isFinite(discountValue)
    || discountValue <= 0
    || (discountType === "fixed" && discountValue > 1_000_000)
    || (discountType === "percentage" && discountValue > 100)
    || (merged.max_uses !== undefined && maxUses === undefined)
    || (merged.max_uses_per_client !== undefined && maxUsesPerClient === undefined)
    || (startsAt && Number.isNaN(startsAt.getTime()))
    || (endsAt && Number.isNaN(endsAt.getTime()))
    || (startsAt && endsAt && startsAt >= endsAt)
    || services.length > VALID_SERVICES.size
    || services.some((service) => !VALID_SERVICES.has(service))
    || (merged.active !== undefined && typeof merged.active !== "boolean")) {
    return { ok: false };
  }

  return {
    ok: true,
    value: {
      discount_type: discountType,
      discount_value: discountValue,
      starts_at: startsAt?.toISOString() || null,
      ends_at: endsAt?.toISOString() || null,
      max_uses: maxUses ?? null,
      max_uses_per_client: maxUsesPerClient ?? null,
      services,
      active: merged.active !== false,
    },
  };
}

async function getPromoEmail(req: AuthedRequest): Promise<string | null> {
  const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  if (!authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice(7).trim();
  if (!token) return null;
  const { data, error } = await supabaseAuth.auth.getUser(token);
  return error || !data.user?.email ? null : data.user.email.trim().toLowerCase();
}

async function getPromoStatsMap(): Promise<Map<string, Record<string, unknown>>> {
  const { data, error } = await supabaseAdmin.rpc("get_admin_promo_stats");
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  return new Map(rows.map((row: any) => [String(row.promo_code_id), row]));
}

function presentPromoWithStats(row: Record<string, any>, stats?: Record<string, any>) {
  return {
    ...presentPromoCode(row, Number(stats?.sales_count || 0)),
    sales_count: Number(stats?.sales_count || 0),
    revenue_amount: Number(stats?.revenue_amount || 0),
    gross_revenue: Number(stats?.gross_revenue || 0),
    discount_total: Number(stats?.discount_total || 0),
    last_used_at: stats?.last_used_at || null,
  };
}

router.post("/validate-promo", promoValidationLimiter, async (req, res) => {
  const email = await getPromoEmail(req);
  if (!email) return res.status(401).json({ error: "Token invalide ou expiré." });
  const code = normalizePromoCode(req.body?.code);
  const pricing = computeCart(req.body?.items);
  if (!code || !pricing.ok) {
    return res.status(400).json({ valid: false, error: "Code promo ou panier invalide." });
  }

  const { data: promo, error } = await supabaseAdmin
    .from("promo_codes")
    .select("id, discount_type, discount_value, starts_at, ends_at, max_uses, max_uses_per_client, services, active")
    .eq("code_hash", hashPromoCode(code))
    .eq("active", true)
    .single();
  if (error || !promo || !promoIsActive(promo) || !promoSupportsItems(promo, pricing.cleanItems)) {
    return res.status(400).json({ valid: false, error: "Code promo invalide ou non applicable." });
  }

  const { data: usageRows, error: usageError } = await supabaseAdmin.rpc("get_promo_usage", {
    p_promo_code_id: promo.id,
    p_client_hash: clientPromoHash(email),
  });
  const usage = Array.isArray(usageRows) ? usageRows[0] : usageRows;
  if (usageError || promoUsageExhausted(promo, usage)) {
    return res.status(400).json({ valid: false, error: "Code promo épuisé." });
  }

  const discount = calculatePromoDiscount(pricing.amount, promo);
  return res.json({
    valid: true,
    code,
    discount_amount: discount,
    total: Math.max(0, pricing.amount - discount),
    subtotal: pricing.amount,
    message: "Code promo appliqué.",
  });
});

router.get("/admin/promo-codes", requireAdmin, async (req, res) => {
  try {
    const [{ data, error }, statsMap] = await Promise.all([
      supabaseAdmin.from("promo_codes").select(PROMO_FIELDS).order("created_at", { ascending: false }),
      getPromoStatsMap(),
    ]);
    if (error) throw error;
    return res.json({
      promo_codes: (data || []).map((promo: any) =>
        presentPromoWithStats(promo, statsMap.get(String(promo.id)))),
    });
  } catch (error) {
    req.log?.error({ error }, "Admin promo list failed");
    return res.status(503).json({ error: "Impossible de charger les codes promo." });
  }
});

router.post("/admin/promo-codes", adminPromoWriteLimiter, requireAdmin, async (req: AuthedRequest, res) => {
  const code = normalizePromoCode(req.body?.code);
  const parsed = parsePromoDefinition(req.body || {});
  if (!code || !parsed.ok) {
    return res.status(400).json({ error: "Paramètres du code promo invalides." });
  }

  const { data, error } = await supabaseAdmin.from("promo_codes").insert({
    code_hash: hashPromoCode(code),
    code_prefix: code.slice(0, 4),
    ...parsed.value,
    created_by: req.adminUserId,
  }).select(PROMO_FIELDS).single();
  if (error || !data) {
    return res.status(409).json({ error: "Ce code promo existe déjà ou est invalide." });
  }
  const createdPromo = data as unknown as Record<string, any>;

  void appendAuditLog({
    action: "admin_promo_create",
    actorUserId: req.adminUserId,
    targetType: "promo_code",
    targetId: createdPromo.id,
    details: {
      code_prefix: code.slice(0, 4),
      discount_type: parsed.value.discount_type,
      discount_value: parsed.value.discount_value,
    },
  });
  return res.status(201).json({
    code,
    promo_code: presentPromoWithStats(createdPromo),
  });
});

async function updatePromo(req: AuthedRequest, res: Response) {
  const promoId = String(req.params.id || req.body?.id || "");
  if (!UUID_PATTERN.test(promoId)) {
    return res.status(400).json({ error: "Identifiant du code promo invalide." });
  }

  const requestedUpdates = Object.fromEntries(
    Object.entries(req.body || {}).filter(([key]) => PROMO_UPDATE_FIELDS.has(key)),
  );
  if (!Object.keys(requestedUpdates).length) {
    return res.status(400).json({ error: "Aucune modification valide n’a été fournie." });
  }

  const { data: current, error: lookupError } = await supabaseAdmin
    .from("promo_codes")
    .select(PROMO_FIELDS)
    .eq("id", promoId)
    .single();
  if (lookupError || !current) return res.status(404).json({ error: "Code promo introuvable." });

  const parsed = parsePromoDefinition(
    requestedUpdates,
    current as unknown as Record<string, unknown>,
  );
  if (!parsed.ok) return res.status(400).json({ error: "Modification du code promo invalide." });

  const { data, error } = await supabaseAdmin
    .from("promo_codes")
    .update(parsed.value)
    .eq("id", promoId)
    .select(PROMO_FIELDS)
    .single();
  if (error || !data) return res.status(404).json({ error: "Code promo introuvable." });

  const statsMap = await getPromoStatsMap();
  void appendAuditLog({
    action: "admin_promo_update",
    actorUserId: req.adminUserId,
    targetType: "promo_code",
    targetId: promoId,
    details: { fields: Object.keys(requestedUpdates) },
  });
  return res.json({ promo_code: presentPromoWithStats(data, statsMap.get(promoId)) });
}

router.patch("/admin/promo-codes", adminPromoWriteLimiter, requireAdmin, updatePromo);
router.patch("/admin/promo-codes/:id", adminPromoWriteLimiter, requireAdmin, updatePromo);

router.delete("/admin/promo-codes/:id", adminPromoWriteLimiter, requireAdmin, async (req: AuthedRequest, res) => {
  const promoId = String(req.params.id || "");
  if (!UUID_PATTERN.test(promoId)) {
    return res.status(400).json({ error: "Identifiant du code promo invalide." });
  }
  const { data, error } = await supabaseAdmin
    .from("promo_codes")
    .update({ active: false })
    .eq("id", promoId)
    .select("id")
    .single();
  if (error || !data) return res.status(404).json({ error: "Code promo introuvable." });

  void appendAuditLog({
    action: "admin_promo_deactivate",
    actorUserId: req.adminUserId,
    targetType: "promo_code",
    targetId: promoId,
  });
  return res.json({ success: true });
});

export default router;
