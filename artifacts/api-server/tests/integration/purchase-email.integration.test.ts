import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPurchaseEmailContent,
  getPurchaseEmailConfig,
  sendPasswordRecoveryEmail,
  sendPurchaseConfirmationEmail,
} from "../../src/lib/purchaseEmail";
import { buildInvoicePdf, type InvoiceOrder } from "../../src/lib/invoicePdf";

const order: InvoiceOrder = {
  job_order_id: "ORD-12345678-ABCD",
  customer_email: "client@example.com",
  total_amount: 1000,
  subtotal_amount: 1100,
  discount_amount: 100,
  order_items: [
    { name: "Netflix Premium 1 mois", quantity: 1 },
    {
      name: "Spotify Family 1 mois",
      quantity: 1,
      client_credentials: { email: "spotify@example.com", password: "super-secret", whatsapp: "+213555000000" },
      client_credentials_encrypted: { ciphertext: "also-secret" },
    },
  ],
  ordered_at: "2026-08-24T12:00:00.000Z",
  paid_at: "2026-08-24T12:05:00.000Z",
};

describe("e-mail de confirmation d'achat et facture", () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test_api_key";
    process.env.TRANSACTIONAL_FROM_EMAIL = "support@aura-stream.com";
    process.env.TRANSACTIONAL_FROM_NAME = "Aura Stream";
    process.env.TRANSACTIONAL_REPLY_TO = "support@aura-stream.com";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.RESEND_API_KEY;
    delete process.env.TRANSACTIONAL_FROM_EMAIL;
    delete process.env.TRANSACTIONAL_FROM_NAME;
    delete process.env.TRANSACTIONAL_REPLY_TO;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASSWORD;
    delete process.env.IMAP_ADMIN_PASS;
    delete process.env.OUTLOOK_PASSWORD;
  });

  it("génère une facture PDF valide sans identifiants client", () => {
    const pdf = buildInvoicePdf(order);
    expect(pdf.subarray(0, 8).toString("ascii")).toBe("%PDF-1.4");
    expect(pdf.toString("ascii")).toContain("xref");
    expect(pdf.toString("ascii")).toContain("%%EOF");
    expect(pdf.toString("utf8")).not.toContain("super-secret");
    expect(pdf.toString("utf8")).not.toContain("also-secret");
    expect(pdf.length).toBeGreaterThan(1500);
  });

  it("crée un message humain avec le récapitulatif et la facture annoncée", () => {
    const content = buildPurchaseEmailContent(order);
    expect(content.subject).toContain(order.job_order_id);
    expect(content.html).toContain("Merci pour votre achat");
    expect(content.html).toContain("facture PDF");
    expect(content.text).toContain("Total payé : 1 000 DA");
    expect(content.html).not.toContain("super-secret");
  });

  it("envoie via Resend avec une clé d'idempotence et la facture jointe", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "email-provider-123" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const config = getPurchaseEmailConfig();
    expect(config).not.toBeNull();

    const result = await sendPurchaseConfirmationEmail(order, config!);

    expect(result.providerId).toBe("email-provider-123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(request?.headers).toMatchObject({
      Authorization: "Bearer re_test_api_key",
      "Idempotency-Key": expect.stringMatching(/^purchase-[a-f0-9]{40}$/),
    });
    const payload = JSON.parse(String(request?.body));
    expect(payload.from).toBe("Aura Stream <support@aura-stream.com>");
    expect(payload.to).toEqual(["client@example.com"]);
    expect(payload.attachments[0].filename).toMatch(/^facture-aura-stream-.*\.pdf$/);
    const attachment = Buffer.from(payload.attachments[0].content, "base64");
    expect(attachment.subarray(0, 8).toString("ascii")).toBe("%PDF-1.4");
    expect(JSON.stringify(payload)).not.toContain("super-secret");
  });

  it("désactive l'envoi si la configuration professionnelle est incomplète", () => {
    delete process.env.TRANSACTIONAL_FROM_EMAIL;
    expect(getPurchaseEmailConfig()).toBeNull();
  });

  it("utilise le SMTP Hostinger lorsque Resend n'est pas configuré", () => {
    delete process.env.RESEND_API_KEY;
    process.env.SMTP_HOST = "smtp.hostinger.com";
    process.env.SMTP_PORT = "465";
    process.env.SMTP_USER = "admin@aura-stream.com";
    process.env.OUTLOOK_PASSWORD = "existing-render-mailbox-secret";
    process.env.TRANSACTIONAL_FROM_EMAIL = "admin@aura-stream.com";

    expect(getPurchaseEmailConfig()).toMatchObject({
      provider: "smtp",
      host: "smtp.hostinger.com",
      port: 465,
      secure: true,
      user: "admin@aura-stream.com",
      fromEmail: "admin@aura-stream.com",
    });
  });

  it("envoie le lien de récupération via le fournisseur transactionnel", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "recovery-provider-123" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const link = "https://test-project.supabase.co/auth/v1/verify?token=opaque&type=recovery";

    const result = await sendPasswordRecoveryEmail("client@example.com", link, getPurchaseEmailConfig()!);

    expect(result.providerId).toBe("recovery-provider-123");
    const [, request] = fetchMock.mock.calls[0];
    const payload = JSON.parse(String(request?.body));
    expect(payload.from).toBe("Aura Stream <support@aura-stream.com>");
    expect(payload.subject).toContain("mot de passe");
    expect(payload.html).toContain(link.replace(/&/g, "&amp;"));
    expect(payload.attachments).toBeUndefined();
  });

  it("rejette une réponse fournisseur invalide sans exposer son corps", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>provider error</html>", { status: 502 })));
    await expect(sendPurchaseConfirmationEmail(order, getPurchaseEmailConfig()!))
      .rejects.toMatchObject({ code: "RESEND_HTTP_502" });
  });
});
