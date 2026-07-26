import { describe, expect, it } from "vitest";
import {
  calculatePromoDiscount,
  hashPromoCode,
  normalizePromoCode,
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
});
