import { describe, expect, it } from "vitest";
import { buildAdminOrdersCsv, subscriptionFollowUp } from "../../src/lib/adminOrderExport";

const now = new Date("2026-08-08T12:00:00.000Z");

describe("export de suivi administrateur", () => {
  it("classe les abonnements expirés et ceux qui expirent bientôt", () => {
    expect(subscriptionFollowUp({ payment_status: "paid", status: "active", activated_at: "2026-07-01T12:00:00.000Z" }, { name: "Netflix Premium 1 mois" }, now).label)
      .toBe("À déconnecter");
    expect(subscriptionFollowUp({ payment_status: "paid", status: "active", activated_at: "2026-07-11T12:00:00.000Z" }, { name: "Netflix Premium 1 mois" }, now).label)
      .toBe("Expire dans 3 jours ou moins");
  });

  it("utilise en priorité la date d’expiration enregistrée sur la commande", () => {
    const result = subscriptionFollowUp({
      payment_status: "paid",
      status: "active",
      activated_at: "2026-01-01T12:00:00.000Z",
      expires_at: "2026-09-01T12:00:00.000Z",
    }, { name: "Netflix Premium 1 mois" }, now);

    expect(result.label).toBe("Actif");
    expect(result.expiresAt).toBe("2026-09-01T12:00:00.000Z");
  });

  it("n’exporte jamais le mot de passe et neutralise les formules Excel", () => {
    const csv = buildAdminOrdersCsv([{
      order_id: "ORD-test",
      assigned_email: "=cmd@example.com",
      amount: 500,
      payment_status: "paid",
      status: "active",
      created_at: "2026-08-01T12:00:00.000Z",
      activated_at: "2026-08-01T12:00:00.000Z",
      items: [{
        name: "Spotify Family 1 mois",
        quantity: 1,
        client_credentials: { whatsapp: "0555000000", password: "super-secret" },
      }],
    }], now);

    expect(csv).toContain("'=cmd@example.com");
    expect(csv).toContain("0555000000");
    expect(csv).not.toContain("super-secret");
  });
});
