import { slickPayInvoiceDetails, type SlickPayInvoiceDetails } from "./payments";

const SLICKPAY_INVOICE_URL = "https://prodapi.slick-pay.com/api/v2/users/invoices";
const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;

async function readBoundedText(response: globalThis.Response): Promise<string> {
  const announcedLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(announcedLength) && announcedLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new Error("SLICKPAY_RESPONSE_TOO_LARGE");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("SLICKPAY_RESPONSE_TOO_LARGE");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export async function fetchSlickPayInvoice(
  invoiceId: string,
  timeoutMs = 12_000,
): Promise<SlickPayInvoiceDetails> {
  const apiKey = process.env.SLICKPAY_PUBLIC_KEY || process.env.SLICKPAY_API_KEY || "";
  if (!apiKey) throw new Error("SLICKPAY_API_KEY_MISSING");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${SLICKPAY_INVOICE_URL}/${encodeURIComponent(invoiceId)}`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    let body: any;
    if (response.body) {
      const text = await readBoundedText(response);
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error("SLICKPAY_INVALID_JSON");
      }
    } else if (typeof response.json === "function") {
      body = await response.json();
    } else {
      throw new Error("SLICKPAY_EMPTY_RESPONSE");
    }
    if (!response.ok) throw new Error(`SLICKPAY_HTTP_${response.status}`);
    return slickPayInvoiceDetails(body);
  } finally {
    clearTimeout(timeout);
  }
}
