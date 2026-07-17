export type SlickPayPaymentState = "paid" | "unpaid" | "failed" | "pending";

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

export function expiresAtFromItems(items: any[]): string {
  const expiresAt = new Date();
  expiresAt.setUTCMonth(expiresAt.getUTCMonth() + durationMonthsFromItems(items));
  return expiresAt.toISOString();
}

export function slickPayPaymentState(payload: any): SlickPayPaymentState {
  const raw = String(
    payload?.data?.payment_status ??
      payload?.payment_status ??
      payload?.data?.status ??
      payload?.status ??
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
