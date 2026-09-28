import { describe, expect, it } from "vitest";
import {
  loyaltyRenewalDiscount,
  renewalOffer,
  sameRenewalItems,
} from "../../src/lib/renewals";

describe("loyalty renewals", () => {
  const now = new Date("2026-09-28T12:00:00.000Z");

  it("propose 10 % pendant les 7 jours précédant l'expiration", () => {
    expect(renewalOffer({
      payment_status: "paid",
      status: "active",
      expires_at: "2026-10-02T12:00:00.000Z",
      items: [{ name: "Netflix Premium 1 mois", quantity: 1 }],
    }, now)).toEqual({
      eligible: true,
      discount_percent: 10,
      subtotal: 600,
      discount_amount: 60,
      total: 540,
    });
  });

  it("laisse 30 jours après l'expiration pour renouveler", () => {
    expect(renewalOffer({
      payment_status: "paid",
      status: "completed",
      expires_at: "2026-09-08T12:00:00.000Z",
      items: [{ name: "Spotify Family 1 mois", quantity: 1 }],
    }, now)?.total).toBe(720);
  });

  it("refuse une offre trop tôt ou trop tard", () => {
    const base = {
      payment_status: "paid",
      status: "active",
      items: [{ name: "Netflix Premium 1 mois", quantity: 1 }],
    };
    expect(renewalOffer({ ...base, expires_at: "2026-10-10T12:00:00.000Z" }, now)).toBeNull();
    expect(renewalOffer({ ...base, expires_at: "2026-08-01T12:00:00.000Z" }, now)).toBeNull();
  });

  it("exige exactement les mêmes produits et quantités", () => {
    expect(sameRenewalItems(
      [{ name: "Netflix Premium 1 mois", quantity: 1 }],
      [{ name: "Netflix Premium 1 mois", quantity: 1, internal_marker: true }],
    )).toBe(true);
    expect(sameRenewalItems(
      [{ name: "Netflix Premium 2 mois", quantity: 1 }],
      [{ name: "Netflix Premium 1 mois", quantity: 1 }],
    )).toBe(false);
  });

  it("arrondit toujours la remise en dinars entiers", () => {
    expect(loyaltyRenewalDiscount(555)).toBe(55);
  });
});
