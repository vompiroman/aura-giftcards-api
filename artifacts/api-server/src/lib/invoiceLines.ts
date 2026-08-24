import { PRICES } from "../config/prices";
import { publicOrderItems } from "./orderItems";

export interface InvoiceLine {
  name: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

function finiteAmount(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback;
}

function catalogPrice(name: string): number {
  if (PRICES[name] !== undefined) return finiteAmount(PRICES[name]);

  const normalized = name.toLowerCase().replace(/\s+/g, " ").trim();
  const yearly = /(?:1\s*an|12\s*mois)/.test(normalized);
  const twoMonths = /2\s*mois/.test(normalized);
  if (normalized.includes("netflix")) {
    return PRICES[twoMonths ? "Netflix Premium 2 mois" : "Netflix Premium 1 mois"] || 0;
  }
  if (normalized.includes("spotify")) {
    return PRICES[yearly ? "Spotify Family 1 an" : "Spotify Family 1 mois"] || 0;
  }
  if (normalized.includes("crunchyroll")) {
    return PRICES[yearly ? "Crunchyroll Mega Fan 1 an" : "Crunchyroll Mega Fan 1 mois"] || 0;
  }
  return 0;
}

/**
 * Builds invoice lines whose totals always reconcile with the subtotal stored
 * on the paid order. This keeps historical orders correct when a product was
 * renamed or its catalogue price changed after the purchase.
 */
export function resolveInvoiceLines(
  items: unknown,
  subtotalValue: unknown,
  totalValue: unknown,
  discountValue: unknown,
): InvoiceLine[] {
  const grouped = new Map<string, number>();
  for (const item of publicOrderItems(items)) {
    const name = String(item?.name || "Abonnement Aura Stream").replace(/[\r\n]+/g, " ").trim().slice(0, 100);
    const quantity = Number.isInteger(Number(item?.quantity))
      ? Math.max(1, Math.min(20, Number(item.quantity)))
      : 1;
    grouped.set(name, (grouped.get(name) || 0) + quantity);
  }

  const total = finiteAmount(totalValue);
  const discount = finiteAmount(discountValue);
  const subtotal = finiteAmount(subtotalValue, total + discount);
  const seeds = [...grouped.entries()].map(([name, quantity]) => ({
    name,
    quantity,
    hint: catalogPrice(name) * quantity,
  }));
  if (seeds.length === 0) return [];

  const hintedTotal = seeds.reduce((sum, line) => sum + line.hint, 0);
  const weights = hintedTotal > 0 && seeds.every((line) => line.hint > 0)
    ? seeds.map((line) => line.hint)
    : seeds.map((line) => line.quantity);
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);

  let allocated = 0;
  return seeds.map((line, index) => {
    const lineTotal = index === seeds.length - 1
      ? Math.max(0, subtotal - allocated)
      : Math.max(0, Math.floor((subtotal * weights[index]) / weightTotal));
    allocated += lineTotal;
    return {
      name: line.name,
      quantity: line.quantity,
      unitPrice: Math.round(lineTotal / line.quantity),
      total: lineTotal,
    };
  });
}
