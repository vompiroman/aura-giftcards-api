import { describe, expect, it } from "vitest";
import { slickPayInvoiceDetails } from "../../src/lib/payments";

describe("normalisation des réponses SlickPay", () => {
  it.each(["Spotify Family 1 mois", "Crunchyroll Mega Fan 1 mois"])(
    "lit le montant de transaction imbriqué pour %s", (service) => {
      const details = slickPayInvoiceDetails({ success: 1, completed: 1, data: JSON.stringify({
        payment_status: "pending", transaction: { status: "COMPLETED", amount: "1000.00" },
        items: [{ name: service }],
      }) });
      expect(details.state).toBe("paid");
      expect(details.amount).toBe(1000);
    },
  );

  it("donne priorité au rejet de la transaction sur completed au niveau facture", () => {
    const details = slickPayInvoiceDetails({ success: 1, completed: 1, data: {
      status: "completed", transaction: { status: "REJECTED", amount: "1100.00" },
    } });
    expect(details.state).toBe("failed");
    expect(details.amount).toBe(1100);
  });

  it.each([null, "", " ", true, false, {}, [], "NaN", "Infinity", -1])(
    "ne transforme pas un montant malformé (%j) en montant valide", (amount) => {
      expect(slickPayInvoiceDetails({ completed: 1, data: { transaction: { amount } } }).amount).toBeNull();
    },
  );

  it("ne confirme pas une transaction en attente même si la facture porte completed", () => {
    expect(slickPayInvoiceDetails({ completed: 1, data: {
      transaction: { status: "PENDING", amount: "500.00" },
    } }).state).toBe("pending");
  });

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
