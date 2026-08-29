import { supabaseAdmin } from "./supabase";

export type SlickPayExpirationResult =
  | "deleted"
  | "not_found"
  | "invoice_mismatch"
  | "too_new"
  | "protected_paid"
  | "ineligible"
  | "stale_observation"
  | "protected_inventory";

export interface SlickPayExpiration {
  result: SlickPayExpirationResult;
  provider_status?: string;
}

export async function expireUnpaidSlickPayOrder(
  orderId: string,
  invoiceId: string | null,
  cutoff: string,
): Promise<SlickPayExpiration> {
  const { data, error } = await supabaseAdmin.rpc("expire_unpaid_slickpay_order", {
    p_order_id: orderId,
    p_invoice_id: invoiceId,
    p_cutoff: cutoff,
  });
  if (error) throw error;

  const value = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const result = String(value.result || "") as SlickPayExpirationResult;
  if (![
    "deleted",
    "not_found",
    "invoice_mismatch",
    "too_new",
    "protected_paid",
    "ineligible",
    "stale_observation",
    "protected_inventory",
  ].includes(result)) {
    throw new Error("INVALID_SLICKPAY_EXPIRATION_RESULT");
  }

  return {
    result,
    provider_status: typeof value.provider_status === "string" ? value.provider_status : undefined,
  };
}
