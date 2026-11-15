import { PARTNER_ENABLED } from "../config/partnerTiers";
import { getPurchaseEmailConfig, sendPartnerStockAlert } from "../lib/purchaseEmail";
import { supabaseAdmin as db } from "../lib/supabase";

export async function runPartnerStockAlerts() {
  const counts={sent:0,errors:0};
  if (!PARTNER_ENABLED()) return counts;
  const config=getPurchaseEmailConfig();
  if (!config) return counts;
  const {data,error}=await db.rpc("claim_partner_stock_alerts",{p_limit:8});
  if (error?.code==="PGRST202") return counts;
  if (error) throw error;
  await Promise.all((data || []).map(async (alert:{
    user_id:string; claim_id:string; subscription_id:string; language:string;
  })=>{
    try {
      const [subscription, user] = await Promise.all([
        db.from("partner_stock_alerts").select("user_id").eq("user_id",alert.user_id)
          .eq("claim_id",alert.claim_id).maybeSingle(),
        db.auth.admin.getUserById(alert.user_id),
      ]);
      if (subscription.error || user.error) throw subscription.error || user.error;
      if (!subscription.data || !user.data.user?.email) return;
      await sendPartnerStockAlert({...alert,email:user.data.user.email},config);
      const {error:finishError}=await db.from("partner_stock_alerts").delete()
        .eq("user_id",alert.user_id).eq("claim_id",alert.claim_id);
      if (finishError) throw finishError;
      counts.sent++;
    } catch { counts.errors++; }
  }));
  return counts;
}
