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

  it("confirme une transaction SATIM terminée même si le reversement bancaire est en attente", () => {
    const details = slickPayInvoiceDetails({
      success: 1,
      data: JSON.stringify({
        status: "COMPLETED",
        payment_status: "pending",
        payout_status: "pending",
        amount: 600,
      }),
    });

    expect(details.state).toBe("paid");
    expect(details.amount).toBe(600);
  });

  it("refuse toujours une transaction SATIM rejetée", () => {
    const details = slickPayInvoiceDetails({
      data: JSON.stringify({ status: "REJECTED", payment_status: "pending", amount: 600 }),
    });
    expect(details.state).toBe("failed");
  });
});
