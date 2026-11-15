import { supabaseAdmin as db } from "../lib/supabase";
import { PARTNER_ENABLED } from "../config/partnerTiers";
import { getPurchaseEmailConfig, sendPartnerRenewalReminder } from "../lib/purchaseEmail";

export async function runPartnerReminders() {
  const counts = { sent: 0, errors: 0 };
  const config = getPurchaseEmailConfig();
  if (!PARTNER_ENABLED() || !config) return counts;
  // Limit the batch so it completes within the existing cron's HTTP timeout.
  const { data, error } = await db.rpc("claim_partner_reminders", { p_limit: 8 });
  if (error?.code === "PGRST202") return counts; // API deployment can precede the migration.
  if (error) throw error;
  await Promise.all((data || []).map(async (reminder: {
    email: string; order_id: string; expires_at: string; days_before: number; language: string; claim_id: string;
  }) => {
    try {
      // An order may have been renewed or opted out since the batch was claimed.
      const [order, settings] = await Promise.all([
        db.from("orders").select("assigned_email").eq("order_id",reminder.order_id)
          .eq("status","active").eq("payment_status","paid").eq("expires_at",reminder.expires_at)
          .gt("expires_at",new Date().toISOString()).maybeSingle(),
        db.from("partner_order_settings").select("language").eq("order_id",reminder.order_id)
          .eq("reminders",true).maybeSingle(),
      ]);
      if (order.error || settings.error) throw order.error || settings.error;
      if (!order.data?.assigned_email || !settings.data) return;
      await sendPartnerRenewalReminder({ ...reminder, email:order.data.assigned_email, language:settings.data.language }, config);
      const { error: finishError } = await db.from("partner_reminder_deliveries")
        .update({ sent_at: new Date().toISOString() }).eq("claim_id",reminder.claim_id)
        .eq("order_id",reminder.order_id).eq("expires_at",reminder.expires_at).eq("days_before",reminder.days_before);
      if (finishError) throw finishError;
      counts.sent++;
    } catch { counts.errors++; }
  }));
  return counts;
}
