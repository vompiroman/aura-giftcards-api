import crypto from "crypto";

export type PromoType = "fixed" | "percentage";

export interface PromoDefinition {
  discount_type: PromoType;
  discount_value: number;
  starts_at?: string | null;
  ends_at?: string | null;
  services?: string[] | null;
  active?: boolean;
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
