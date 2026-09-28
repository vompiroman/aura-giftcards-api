import { computeCart, type CartItem } from "../config/prices";

export const LOYALTY_RENEWAL_DISCOUNT_PERCENT = 10;
export const RENEWAL_WINDOW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;
export const RENEWAL_GRACE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

interface RenewalOrder {
  payment_status?: unknown;
  status?: unknown;
  expires_at?: unknown;
  items?: unknown;
}

export interface RenewalOffer {
  eligible: true;
  discount_percent: number;
  subtotal: number;
  discount_amount: number;
  total: number;
}

function itemQuantities(items: CartItem[]): Map<string, number> {
  const quantities = new Map<string, number>();
  for (const item of items) {
    quantities.set(item.name, (quantities.get(item.name) || 0) + item.quantity);
  }
  return quantities;
}

export function sameRenewalItems(requestedItems: CartItem[], sourceItems: unknown): boolean {
  const source = computeCart(sourceItems);
  if (!source.ok) return false;
  const requested = itemQuantities(requestedItems);
  const original = itemQuantities(source.cleanItems);
  if (requested.size !== original.size) return false;
  for (const [name, quantity] of requested) {
    if (original.get(name) !== quantity) return false;
  }
  return true;
}

export function loyaltyRenewalDiscount(subtotal: number): number {
  if (!Number.isFinite(subtotal) || subtotal <= 0) return 0;
  return Math.max(0, Math.min(
    Math.floor(subtotal * LOYALTY_RENEWAL_DISCOUNT_PERCENT / 100),
    Math.floor(subtotal),
  ));
}

export function renewalOffer(order: RenewalOrder, now = new Date()): RenewalOffer | null {
  if (order.payment_status !== "paid" || !["active", "completed"].includes(String(order.status))) {
    return null;
  }
  if (typeof order.expires_at !== "string") return null;
  const expiresAt = new Date(order.expires_at).getTime();
  const nowMs = now.getTime();
  if (!Number.isFinite(expiresAt) || !Number.isFinite(nowMs)) return null;
  const timeUntilExpiration = expiresAt - nowMs;
  if (timeUntilExpiration > RENEWAL_WINDOW_BEFORE_MS || timeUntilExpiration < -RENEWAL_GRACE_AFTER_MS) {
    return null;
  }

  const pricing = computeCart(order.items);
  if (!pricing.ok) return null;
  const discount = loyaltyRenewalDiscount(pricing.amount);
  return {
    eligible: true,
    discount_percent: LOYALTY_RENEWAL_DISCOUNT_PERCENT,
    subtotal: pricing.amount,
    discount_amount: discount,
    total: pricing.amount - discount,
  };
}
