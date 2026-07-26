import crypto from "crypto";

export type PromoType = "fixed" | "percentage";

export interface PromoDefinition {
  discount_type: PromoType;
  discount_value: number;
  starts_at?: string | null;
  ends_at?: string | null;
  services?: string[] | null;
  active?: boolean;
  max_uses?: number | null;
  max_uses_per_client?: number | null;
}

export function normalizePromoCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9_-]{2,63}$/.test(code) ? code : null;
}

export function hashPromoCode(code: string): string {
  return crypto.createHash("sha256").update(code, "utf8").digest("hex");
}

export function clientPromoHash(email: string): string {
  return crypto.createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex");
}

export function promoIsActive(promo: PromoDefinition, now = new Date()): boolean {
  if (promo.active === false) return false;
  if (promo.starts_at && new Date(promo.starts_at).getTime() > now.getTime()) return false;
  if (promo.ends_at && new Date(promo.ends_at).getTime() < now.getTime()) return false;
  return Number.isFinite(Number(promo.discount_value)) && Number(promo.discount_value) > 0;
}

export function promoSupportsItems(promo: PromoDefinition, items: Array<{ name: string }>): boolean {
  const services = (promo.services || []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!services.length) return true;
  return items.every((item) => services.includes(item.name.trim().split(/\s+/)[0].toLowerCase()));
}

export function calculatePromoDiscount(subtotal: number, promo: PromoDefinition): number {
  if (!Number.isFinite(subtotal) || subtotal <= 0 || !promoIsActive(promo)) return 0;
  const value = Number(promo.discount_value);
  const raw = promo.discount_type === "percentage"
    ? subtotal * Math.min(value, 100) / 100
    : value;
  return Math.max(0, Math.min(Math.floor(raw), Math.floor(subtotal)));
}

export function presentPromoCode(row: Record<string, any>, usageCount?: number) {
  const prefix = typeof row.code_prefix === "string" ? row.code_prefix : "";
  const relationCount = Array.isArray(row.promo_redemptions)
    ? Number(row.promo_redemptions[0]?.count || 0)
    : 0;
  return {
    id: row.id,
    masked_code: prefix ? `${prefix}${"•".repeat(Math.max(4, 8 - prefix.length))}` : "••••••••",
    discount_type: row.discount_type,
    discount_value: row.discount_value,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    max_uses: row.max_uses,
    max_uses_per_client: row.max_uses_per_client,
    services: Array.isArray(row.services) ? row.services : [],
    active: Boolean(row.active),
    created_at: row.created_at,
    usage_count: Number.isFinite(usageCount) ? Number(usageCount) : relationCount,
  };
}

export function promoUsageExhausted(
  promo: Pick<PromoDefinition, "max_uses" | "max_uses_per_client"> & Record<string, any>,
  usage: { total_uses?: number | null; client_uses?: number | null } | null | undefined,
): boolean {
  const total = Number(usage?.total_uses || 0);
  const client = Number(usage?.client_uses || 0);
  return (promo.max_uses !== null && promo.max_uses !== undefined && total >= Number(promo.max_uses))
    || (promo.max_uses_per_client !== null && promo.max_uses_per_client !== undefined
      && client >= Number(promo.max_uses_per_client));
}
