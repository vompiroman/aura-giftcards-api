import { describe, expect, it } from "vitest";
import { slickPayInvoiceDetails } from "../../src/lib/payments";

describe("normalisation des réponses SlickPay", () => {
  it("lit le montant et le statut quand data est un JSON encodé en texte", () => {
    const details = slickPayInvoiceDetails({
      success: 1,
      completed: 1,
      data: JSON.stringify({ payment_status: "paid", amount: 1750 }),
    });

    expect(details.state).toBe("paid");
    expect(details.amount).toBe(1750);
  });

  it("refuse un montant absent au lieu de le transformer en zéro", () => {
    const details = slickPayInvoiceDetails({ completed: 1, data: "{}" });
    expect(details.state).toBe("paid");
    expect(details.amount).toBeNull();
  });
});
