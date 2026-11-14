import { slickPayInvoiceDetails, type SlickPayInvoiceDetails } from "./payments";

export const slickPayInvoiceUrl = () => process.env.SLICKPAY_SANDBOX === "true"
  ? "https://devapi.slick-pay.com/api/v2/users/invoices"
  : "https://prodapi.slick-pay.com/api/v2/users/invoices";
const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;

export function isAllowedPaymentUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && (
      url.hostname === "slick-pay.com" || url.hostname.endsWith(".slick-pay.com") || url.hostname === "cib.satim.dz"
    );
  } catch { return false; }
}

export function paymentUrlFromPayload(data: any): unknown {
  return data?.url ?? data?.data?.url ?? data?.payment_url ?? data?.data?.payment_url
    ?? data?.redirect_url ?? data?.data?.redirect_url;
}

export function configuredSlickPayAccount(): string | null {
  const value = String(process.env.SLICKPAY_ACCOUNT_UUID || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

export async function createSlickPayDepositInvoice(depositId: string,email: string,amount: number) {
  const apiKey = process.env.SLICKPAY_PUBLIC_KEY || process.env.SLICKPAY_API_KEY;
  const webhook = new URL(process.env.SLICKPAY_WEBHOOK_URL || "");
  const returnUrl = new URL(process.env.FRONTEND_URL || "https://www.aura-stream.com");
  if (!apiKey || !process.env.WEBHOOK_SECRET || webhook.protocol !== "https:"
      || (process.env.NODE_ENV === "production" && returnUrl.protocol !== "https:")) throw new Error("SLICKPAY_SETUP_MISSING");
  returnUrl.searchParams.set("wallet_deposit",depositId);
  returnUrl.hash = "partner";
  const account = configuredSlickPayAccount();
  if (process.env.SLICKPAY_ACCOUNT_UUID?.trim() && !account) throw new Error("SLICKPAY_SETUP_MISSING");
  const response = await fetch(slickPayInvoiceUrl(),{
    method:"POST",redirect:"error",signal:AbortSignal.timeout(15_000),
    headers:{Accept:"application/json","Content-Type":"application/json",Authorization:`Bearer ${apiKey}`},
    body:JSON.stringify({amount,url:returnUrl.toString(),...(account ? {account} : {}),
      webhook_url:webhook.toString(),webhook_signature:process.env.WEBHOOK_SECRET,
      webhook_meta_data:[{wallet_deposit_id:depositId}],
      firstname:"Client",lastname:"Aura Stream",email,address:"Alger, Algérie",phone:"0550000000",
      items:[{name:"Recharge portefeuille Aura Stream",quantity:1,price:amount}]}),
  });
  if (!response.ok) { await response.body?.cancel().catch(()=>undefined); throw new Error(`SLICKPAY_HTTP_${response.status}`); }
  const result = JSON.parse(await readBoundedText(response));
  const id = String(result?.data?.id ?? result?.id ?? "").trim();
  const url = paymentUrlFromPayload(result);
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id) || !isAllowedPaymentUrl(url)) throw new Error("SLICKPAY_INVALID_INVOICE");
  return {id,url};
}

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
    const response = await fetch(`${slickPayInvoiceUrl()}/${encodeURIComponent(invoiceId)}`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    // Keep the upstream HTTP status even when its error page is HTML.
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`SLICKPAY_HTTP_${response.status}`);
    }
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
    return slickPayInvoiceDetails(body);
  } catch (error) {
    if (controller.signal.aborted) throw new Error("SLICKPAY_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
