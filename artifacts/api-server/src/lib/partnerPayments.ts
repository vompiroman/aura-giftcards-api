import { supabaseAdmin as db } from "./supabase";
import { fetchSlickPayInvoice, createSlickPayDepositInvoice } from "./slickpay";

export async function createDeposit(userId: string, email: string, key: string, amount: number) {
  const { data: tx, error } = await db.rpc("begin_wallet_deposit", { p_user:userId, p_key:key, p_amount:amount });
  if (error) throw error;
  if (!tx.create_invoice) {
    if (!tx.payment_url && tx.status === "PENDING") throw new Error("WALLET_INVOICE_IN_PROGRESS");
    return { id:tx.id, status:tx.status, payment_url:tx.status === "PENDING" ? tx.payment_url : null };
  }
  try {
    const invoice = await createSlickPayDepositInvoice(tx.id, email, amount);
    const { data, error: saveError } = await db.from("wallet_transactions")
      .update({ provider_invoice_id:invoice.id, payment_url:invoice.url })
      .eq("id",tx.id).eq("user_id",userId).eq("status","PENDING").is("provider_invoice_id",null).select("id").maybeSingle();
    if (saveError || !data) throw new Error("WALLET_INVOICE_SAVE_FAILED");
    return { id:tx.id, status:"PENDING", payment_url:invoice.url };
  } catch (error) {
    await db.from("wallet_transactions").update({status:"FAILED"}).eq("id",tx.id).is("provider_invoice_id",null);
    throw error;
  }
}

export async function observeDeposit(tx: { id:string; status:string; provider_invoice_id:string | null }) {
  if (!tx.provider_invoice_id || tx.status === "CONFIRMED") return tx.status;
  const provider = await fetchSlickPayInvoice(tx.provider_invoice_id, 8000);
  const { data, error } = await db.rpc("observe_wallet_deposit", {
    p_id:tx.id, p_invoice:tx.provider_invoice_id, p_provider_state:provider.state, p_amount:provider.amount,
  });
  if (error) throw error;
  if (data === "AMOUNT_MISMATCH") throw new Error("WALLET_AMOUNT_MISMATCH");
  return String(data);
}

export async function reconcilePartnerDeposits() {
  const { data, error } = await db.from("wallet_transactions").select("id,status,provider_invoice_id")
    .eq("kind","DEPOSIT").neq("status","CONFIRMED").not("provider_invoice_id","is",null)
    .gt("created_at",new Date(Date.now()-30*86400_000).toISOString())
    .order("checked_at",{ascending:true,nullsFirst:true}).limit(12);
  if (error) throw error;
  let confirmed = 0;
  let errors = 0;
  for (const tx of data || []) {
    try { if (await observeDeposit(tx) === "CONFIRMED") confirmed++; }
    catch {
      errors++;
      await db.from("wallet_transactions").update({checked_at:new Date().toISOString()})
        .eq("id",tx.id).neq("status","CONFIRMED");
    }
  }
  return { checked:data?.length || 0, confirmed, errors };
}
