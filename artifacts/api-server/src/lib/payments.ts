export type SlickPayPaymentState = "paid" | "unpaid" | "failed" | "pending";

export interface SlickPayInvoiceDetails {
  state: SlickPayPaymentState;
  amount: number | null;
  payload: any;
}

function parseNestedData(payload: any): any {
  if (typeof payload?.data !== "string") return payload?.data;
  try {
    return JSON.parse(payload.data);
  } catch {
    return null;
  }
}

export function slickPayInvoiceDetails(payload: any): SlickPayInvoiceDetails {
  const nested = parseNestedData(payload);
  const normalized = nested && typeof nested === "object"
    ? { ...payload, data: nested }
    : payload;
  // Completed production invoices include the charged amount under transaction.
  // Never substitute the local order amount: the provider must prove it.
  const rawAmount = normalized?.data?.amount ?? normalized?.data?.transaction?.amount
    ?? normalized?.amount ?? normalized?.transaction?.amount;
  const amountText = typeof rawAmount === "string" ? rawAmount.trim() : "";
  // Accept strict decimal amounts and grouped thousands, never arbitrary comma
  // removal ("10,00" must not silently become 1000).
  const amount = typeof rawAmount === "number" ? rawAmount
    : /^\d+(?:\.\d+)?$/.test(amountText) ? Number(amountText)
    : /^\d{1,3}(?:,\d{3})+(?:\.\d{2})?$/.test(amountText)
      ? Number(amountText.replace(/,/g, "")) : Number.NaN;
  return {
    state: slickPayPaymentState(normalized),
    amount: Number.isFinite(amount) && amount >= 0 ? amount : null,
    payload: normalized,
  };
}

export function durationMonthsFromItems(items: any[]): number {
  let maxMonths = 1;

  for (const item of items || []) {
    const name = String(item?.name || "").trim().toLowerCase();
    const explicit = /(\d+)\s*(mois|months?|ans?|years?)/i.exec(name);

    if (explicit) {
      let value = Number.parseInt(explicit[1], 10);
      if (explicit[2].startsWith("an") || explicit[2].startsWith("year")) {
        value *= 12;
      }
      maxMonths = Math.max(maxMonths, value);
      continue;
    }

    if (name.includes("سنة")) maxMonths = Math.max(maxMonths, 12);
    else if (name.includes("شهران")) maxMonths = Math.max(maxMonths, 2);
  }

  return maxMonths;
}

export function expiresAtFromItems(items: any[], baseDate: string | Date = new Date()): string {
  const parsedBase = baseDate instanceof Date ? new Date(baseDate) : new Date(baseDate);
  const now = new Date();
  const expiresAt = Number.isFinite(parsedBase.getTime()) && parsedBase > now ? parsedBase : now;
  expiresAt.setUTCMonth(expiresAt.getUTCMonth() + durationMonthsFromItems(items));
  return expiresAt.toISOString();
}

export function slickPayPaymentState(payload: any): SlickPayPaymentState {
  // L'export SlickPay distingue le statut de la transaction SATIM du statut
  // du reversement bancaire. Une transaction COMPLETED est encaissée même si
  // le reversement vers le compte marchand est encore « en attente ».
  const transactionStatus = String(
    payload?.data?.transaction?.status ??
      payload?.transaction?.status ??
      payload?.data?.transaction_status ??
      payload?.transaction_status ??
      payload?.data?.status ??
      payload?.status ??
      "",
  )
    .trim()
    .toLowerCase();

  if (["completed", "paid", "success", "successful"].includes(transactionStatus)) {
    return "paid";
  }
  if (["rejected", "failed", "cancelled", "canceled", "declined", "expired"].includes(transactionStatus)) {
    return "failed";
  }
  if (payload?.data?.transaction?.status != null || payload?.transaction?.status != null) {
    return ["unpaid", "0", "false"].includes(transactionStatus) ? "unpaid" : "pending";
  }

  const raw = String(
    payload?.data?.payment_status ??
      payload?.payment_status ??
      payload?.data?.completed ??
      payload?.completed ??
      "",
  )
    .trim()
    .toLowerCase();

  if (["paid", "completed", "success", "successful", "1", "true"].includes(raw)) {
    return "paid";
  }
  if (["failed", "cancelled", "canceled", "declined", "expired"].includes(raw)) {
    return "failed";
  }
  if (["unpaid", "0", "false"].includes(raw)) return "unpaid";
  return "pending";
}
