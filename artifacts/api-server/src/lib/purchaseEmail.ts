import crypto from "crypto";
import { PRICES } from "../config/prices";
import { publicOrderItems } from "./orderItems";
import { buildInvoicePdf, invoiceFilename, type InvoiceOrder } from "./invoicePdf";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface PurchaseEmailConfig {
  apiKey: string;
  fromEmail: string;
  fromName: string;
  replyTo?: string;
}

export interface PurchaseEmailResult {
  providerId: string;
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

function cleanHeader(value: string, max: number): string {
  return String(value).replace(/[\r\n<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char] || char);
}

function amount(value: number | string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function formatDa(value: number | string): string {
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(amount(value))} DA`;
}

export function getPurchaseEmailConfig(): PurchaseEmailConfig | null {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  const fromEmail = String(process.env.TRANSACTIONAL_FROM_EMAIL || "").trim().toLowerCase();
  const fromName = cleanHeader(process.env.TRANSACTIONAL_FROM_NAME || "Aura Stream", 80);
  const replyTo = String(process.env.TRANSACTIONAL_REPLY_TO || "").trim().toLowerCase();
  if (!apiKey || !validEmail(fromEmail) || !fromName || (replyTo && !validEmail(replyTo))) return null;
  return { apiKey, fromEmail, fromName, replyTo: replyTo || undefined };
}

function emailItems(order: InvoiceOrder): Array<{ name: string; quantity: number; total: number }> {
  return publicOrderItems(order.order_items).map((item) => {
    const name = String(item?.name || "Abonnement Aura Stream").replace(/[\r\n]+/g, " ").trim().slice(0, 100);
    const quantity = Number.isInteger(Number(item?.quantity)) ? Math.max(1, Math.min(20, Number(item.quantity))) : 1;
    return { name, quantity, total: amount(PRICES[name] ?? 0) * quantity };
  });
}

export function buildPurchaseEmailContent(order: InvoiceOrder): { subject: string; html: string; text: string } {
  const lines = emailItems(order);
  const itemRows = lines.map((line) => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #e3dad0;color:#23242a;font-size:14px;">${escapeHtml(line.name)} × ${line.quantity}</td>
      <td style="padding:12px 0;border-bottom:1px solid #e3dad0;color:#23242a;font-size:14px;font-weight:700;text-align:right;white-space:nowrap;">${escapeHtml(formatDa(line.total))}</td>
    </tr>`).join("");
  const discount = amount(order.discount_amount);
  const textLines = lines.map((line) => `- ${line.name} × ${line.quantity} : ${formatDa(line.total)}`).join("\n");
  const subject = `Merci pour votre achat — ${cleanHeader(order.job_order_id, 80)}`;
  const html = `<!doctype html>
<html lang="fr"><body style="margin:0;background:#f6f2ec;color:#23242a;font-family:Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Votre paiement Aura Stream est confirmé et votre facture est jointe.</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f2ec;padding:24px 12px;"><tr><td align="center">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid #e0d7ce;border-radius:18px;overflow:hidden;">
      <tr><td style="background:#23242a;padding:30px 34px;border-bottom:5px solid #d93646;">
        <div style="color:#f6f2ec;font-size:22px;font-weight:800;letter-spacing:-0.5px;">Aura <span style="color:#d93646;">Stream</span></div>
      </td></tr>
      <tr><td style="padding:34px;">
        <div style="color:#d93646;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:1.2px;">Paiement confirmé</div>
        <h1 style="margin:12px 0 14px;color:#23242a;font-size:27px;line-height:1.2;">Merci pour votre achat&nbsp;!</h1>
        <p style="margin:0 0 24px;color:#62636a;font-size:15px;line-height:1.65;">Nous avons bien reçu votre paiement. Votre commande est maintenant prise en charge. Netflix est attribué automatiquement selon le stock&nbsp;; Spotify et Crunchyroll sont activés par notre équipe.</p>
        <div style="background:#f6f2ec;border-radius:14px;padding:18px 20px;margin-bottom:24px;">
          <div style="color:#77747a;font-size:12px;">Commande</div>
          <div style="margin-top:5px;color:#23242a;font-size:14px;font-weight:800;word-break:break-all;">${escapeHtml(order.job_order_id)}</div>
        </div>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${itemRows}</table>
        ${discount > 0 ? `<div style="margin-top:16px;text-align:right;color:#d93646;font-size:14px;">Remise&nbsp;: − ${escapeHtml(formatDa(discount))}</div>` : ""}
        <div style="margin-top:8px;text-align:right;color:#23242a;font-size:20px;font-weight:800;">Total payé&nbsp;: ${escapeHtml(formatDa(order.total_amount))}</div>
        <div style="margin-top:28px;padding:17px 20px;border-left:4px solid #d93646;background:#fff8f2;color:#6f543d;font-size:13px;line-height:1.55;">Votre facture PDF est jointe à cet e-mail. Conservez-la comme justificatif de paiement.</div>
        <p style="margin:26px 0 0;color:#62636a;font-size:14px;line-height:1.6;">Besoin d’aide&nbsp;? Répondez simplement à cet e-mail ou contactez notre support.</p>
      </td></tr>
      <tr><td style="padding:20px 34px;background:#23242a;color:#c9c4bd;font-size:12px;text-align:center;">Aura Stream · Abonnements streaming en Algérie</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  const text = `Merci pour votre achat !\n\nVotre paiement Aura Stream est confirmé.\nCommande : ${order.job_order_id}\n\n${textLines}\n${discount > 0 ? `Remise : - ${formatDa(discount)}\n` : ""}Total payé : ${formatDa(order.total_amount)}\n\nVotre facture PDF est jointe à cet e-mail.\n\nAura Stream`;
  return { subject, html, text };
}

async function limitedResponseJson(response: Response): Promise<any> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_RESPONSE_BYTES) throw Object.assign(new Error("RESEND_RESPONSE_TOO_LARGE"), { code: "RESEND_RESPONSE_TOO_LARGE" });
  let body = "";
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw Object.assign(new Error("RESEND_RESPONSE_TOO_LARGE"), { code: "RESEND_RESPONSE_TOO_LARGE" });
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } else {
    body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) throw Object.assign(new Error("RESEND_RESPONSE_TOO_LARGE"), { code: "RESEND_RESPONSE_TOO_LARGE" });
  }
  try { return JSON.parse(body); } catch { return {}; }
}

export async function sendPurchaseConfirmationEmail(
  order: InvoiceOrder,
  config: PurchaseEmailConfig,
): Promise<PurchaseEmailResult> {
  if (!validEmail(order.customer_email)) throw Object.assign(new Error("INVALID_CUSTOMER_EMAIL"), { code: "INVALID_CUSTOMER_EMAIL" });
  const pdf = buildInvoicePdf(order);
  const content = buildPurchaseEmailContent(order);
  const idempotencyKey = `purchase-${crypto.createHash("sha256").update(order.job_order_id).digest("hex").slice(0, 40)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        from: `${config.fromName} <${config.fromEmail}>`,
        to: [order.customer_email],
        reply_to: config.replyTo,
        subject: content.subject,
        html: content.html,
        text: content.text,
        attachments: [{ filename: invoiceFilename(order.job_order_id), content: pdf.toString("base64") }],
        tags: [{ name: "category", value: "purchase-confirmation" }],
      }),
      signal: controller.signal,
    });
    const data = await limitedResponseJson(response);
    if (!response.ok || typeof data?.id !== "string" || !data.id) {
      const code = response.status === 409 ? "RESEND_IDEMPOTENCY_CONFLICT" : `RESEND_HTTP_${response.status}`;
      throw Object.assign(new Error(code), { code });
    }
    return { providerId: data.id.slice(0, 200) };
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw Object.assign(new Error("RESEND_TIMEOUT"), { code: "RESEND_TIMEOUT" });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
