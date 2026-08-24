import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const { fetchSlickPayInvoiceMock, fromMock, getUserMock } = vi.hoisted(() => ({
  fetchSlickPayInvoiceMock: vi.fn(),
  fromMock: vi.fn(),
  getUserMock: vi.fn(),
}));

vi.mock("../../src/lib/slickpay", () => ({
  fetchSlickPayInvoice: fetchSlickPayInvoiceMock,
}));

vi.mock("../../src/lib/supabase", () => ({
  supabase: { from: fromMock },
  supabaseAdmin: { from: fromMock },
  supabaseAuth: { auth: { getUser: getUserMock } },
}));

import app from "../../src/app";

function existingOrderBuilder() {
  const builder: Record<string, any> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.single = vi.fn(async () => ({
    data: {
      order_id: "ORD-existing-invoice",
      assigned_email: "client@example.com",
      amount: 600,
      status: "pending",
      payment_status: "unpaid",
      promo_code_id: null,
      slickpay_invoice_id: "invoice-123",
      items: [{ name: "Netflix Premium 1 mois", quantity: 1 }],
    },
    error: null,
  }));
  return builder;
}

describe("POST /api/create-invoice retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserMock.mockResolvedValue({
      data: { user: { id: "user-123", email: "client@example.com" } },
      error: null,
    });
    fromMock.mockReturnValue(existingOrderBuilder());
  });

  it("réutilise la facture SlickPay existante au lieu de créer une nouvelle commande", async () => {
    fetchSlickPayInvoiceMock.mockResolvedValue({
      state: "pending",
      amount: 600,
      payload: { data: { url: "https://cib.satim.dz/checkout/invoice-123" } },
    });

    const response = await request(app)
      .post("/api/create-invoice")
      .set("Authorization", "Bearer valid-test-token")
      .send({ order_id: "ORD-existing-invoice" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      payment_url: "https://cib.satim.dz/checkout/invoice-123",
      invoice_id: "invoice-123",
      order_id: "ORD-existing-invoice",
      amount: 600,
      reused: true,
    });
    expect(fetchSlickPayInvoiceMock).toHaveBeenCalledWith("invoice-123", 15_000);
  });

  it("ne renvoie jamais une URL de redirection hors des domaines de paiement autorisés", async () => {
    fetchSlickPayInvoiceMock.mockResolvedValue({
      state: "pending",
      amount: 600,
      payload: { data: { url: "https://evil.example/checkout" } },
    });

    const response = await request(app)
      .post("/api/create-invoice")
      .set("Authorization", "Bearer valid-test-token")
      .send({ order_id: "ORD-existing-invoice" });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/déjà été initialisé/);
  });
});
