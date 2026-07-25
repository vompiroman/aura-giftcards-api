import { describe, expect, it } from "vitest";
import { summarizeAvailableStock } from "../../src/lib/stockAlerts";

describe("alertes de stock", () => {
  it("compte uniquement les comptes disponibles et inclut les services à zéro", () => {
    const result = summarizeAvailableStock(
      [
        { service: "Netflix", is_used: false },
        { service: "Netflix", is_used: true },
        { service: "Spotify", is_used: false },
        { service: "Spotify", is_used: false },
      ],
      ["Netflix", "Spotify", "Crunchyroll"],
      1,
    );

    expect(result).toEqual([
      { service: "Netflix", available: 1, threshold: 1, low: true },
      { service: "Spotify", available: 2, threshold: 1, low: false },
      { service: "Crunchyroll", available: 0, threshold: 1, low: true },
    ]);
  });
});
