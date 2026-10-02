import { describe, expect, it } from "vitest";
import { summarizeAvailableStock } from "../../src/lib/stockAlerts";

describe("alertes de stock", () => {
  it("surveille uniquement les profils Netflix disponibles", () => {
    const result = summarizeAvailableStock(
      [
        { service: "Netflix", is_used: false },
        { service: "Netflix", is_used: true },
        { service: "Spotify", is_used: false },
        { service: "Crunchyroll", is_used: false },
        { service: "Spotify", is_used: false },
      ],
      1,
    );

    expect(result).toEqual([
      { service: "Netflix", available: 1, threshold: 1, low: true },
    ]);
  });
  it("signale uniquement Netflix même lorsque tout le stock est vide", () => {
    expect(summarizeAvailableStock([], 2)).toEqual([
      { service: "Netflix", available: 0, threshold: 2, low: true },
    ]);
  });
});
