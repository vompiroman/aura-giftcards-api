import { describe, expect, it } from "vitest";
import {
  calculatePromoDiscount,
  hashPromoCode,
  normalizePromoCode,
  presentPromoCode,
  promoSupportsItems,
} from "../../src/lib/promos";

describe("codes promo", () => {
  it("normalise et ne stocke jamais le code en clair", () => {
    expect(normalizePromoCode("  aura-10  ")).toBe("AURA-10");
    expect(normalizePromoCode("a")).toBeNull();
    expect(hashPromoCode("AURA-10")).not.toContain("AURA-10");
  });

  it("calcule les remises fixe et pourcentage avec plafond", () => {
    expect(calculatePromoDiscount(800, {
      discount_type: "fixed",
      discount_value: 200,
    })).toBe(200);
    expect(calculatePromoDiscount(800, {
      discount_type: "percentage",
      discount_value: 20,
    })).toBe(160);
    expect(calculatePromoDiscount(100, {
      discount_type: "fixed",
      discount_value: 500,
    })).toBe(100);
  });

  it("limite les services ciblés", () => {
    const promo = { discount_type: "fixed" as const, discount_value: 100, services: ["spotify"] };
    expect(promoSupportsItems(promo, [{ name: "Spotify 1 mois" }])).toBe(true);
    expect(promoSupportsItems(promo, [{ name: "Netflix 1 mois" }])).toBe(false);
  });
  it("présente un code masqué et un compteur sans exposer le hash ni les utilisations", () => {
    const presented = presentPromoCode({
      id: "11111111-1111-4111-8111-111111111111",
      code_prefix: "AURA",
      code_hash: "secret-hash",
      discount_type: "percentage",
      discount_value: 10,
      services: ["netflix"],
      active: true,
      promo_redemptions: [{ count: 7, client_hash: "private" }],
    });

    expect(presented.masked_code).toBe("AURA••••");
    expect(presented.usage_count).toBe(7);
    expect(presented).not.toHaveProperty("code_hash");
    expect(presented).not.toHaveProperty("promo_redemptions");
  });
});
