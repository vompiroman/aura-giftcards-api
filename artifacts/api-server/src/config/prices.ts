// Source de vérité UNIQUE des prix (en DA). Le client ne peut jamais l'influencer.
// Toute route qui touche à l'argent lit depuis ici, jamais depuis req.body.
export const PRICES: Record<string, number> = {
  "Netflix 1 mois": 600,
  "Netflix 2 mois": 1100,
  "Netflix 3 mois": 4000,
  "Netflix 6 mois": 7500,
  "Netflix 12 mois": 14000,
  "Spotify 1 mois": 200,
  "Spotify 2 mois": 900,
  "Spotify 3 mois": 2400,
  "Crunchyroll 1 mois": 500,
  "Crunchyroll 3 mois": 3200,
  "Crunchyroll 1 an": 3000,
};

export interface CartItem {
  name: string;
  quantity: number;
}

export interface PricingResult {
  ok: boolean;
  amount: number;
  cleanItems: CartItem[];
  error?: string;
}

/**
 * Valide un panier client et recalcule le montant à partir de PRICES.
 * N'accepte que { name, quantity } ; ignore tout prix envoyé par le client.
 */
export function computeCart(rawItems: unknown): PricingResult {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { ok: false, amount: 0, cleanItems: [], error: "Panier invalide." };
  }
  if (rawItems.length > 50) {
    return { ok: false, amount: 0, cleanItems: [], error: "Trop d'articles dans le panier." };
  }

  let amount = 0;
  const cleanItems: CartItem[] = [];

  for (const raw of rawItems) {
    const name = typeof raw?.name === "string" ? raw.name : null;
    const quantity = Number(raw?.quantity) || 1;
    const unit = name ? PRICES[name] : undefined;

    if (
      !name ||
      unit === undefined ||
      !Number.isInteger(quantity) ||
      quantity <= 0 ||
      quantity > 20
    ) {
      return { ok: false, amount: 0, cleanItems: [], error: "Article invalide dans le panier." };
    }

    amount += unit * quantity;
    cleanItems.push({ name, quantity });
  }

  return { ok: true, amount, cleanItems };
}
