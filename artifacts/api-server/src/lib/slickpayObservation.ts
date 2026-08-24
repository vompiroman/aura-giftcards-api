import { supabaseAdmin } from "./supabase";
import type { SlickPayInvoiceDetails } from "./payments";

export type SlickPayObservationResult =
  | "confirmed"
  | "already_paid"
  | "amount_missing"
  | "amount_mismatch"
  | "paid"
  | "unpaid"
  | "failed"
  | "pending";

export interface SlickPayObservation {
  result: SlickPayObservationResult;
  transitioned: boolean;
  payment_status: string;
  order_status: string;
}

export async function observeSlickPayPayment(
  orderId: string,
  invoiceId: string,
  provider: SlickPayInvoiceDetails,
): Promise<SlickPayObservation> {
  const { data, error } = await supabaseAdmin.rpc("observe_slickpay_payment", {
    p_order_id: orderId,
    p_invoice_id: invoiceId,
    p_provider_status: provider.state,
    p_verified_amount: provider.amount,
  });
  if (error) throw error;

  const result = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const observed = String(result.result || "");
  if (![
    "confirmed",
    "already_paid",
    "amount_missing",
    "amount_mismatch",
    "paid",
    "unpaid",
    "failed",
    "pending",
  ].includes(observed)) {
    throw new Error("INVALID_SLICKPAY_OBSERVATION");
  }

  return {
    result: observed as SlickPayObservationResult,
    transitioned: result.transitioned === true,
    payment_status: String(result.payment_status || ""),
    order_status: String(result.order_status || ""),
  };
}
