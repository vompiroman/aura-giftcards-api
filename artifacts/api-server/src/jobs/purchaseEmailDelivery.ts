import { supabaseAdmin } from "../lib/supabase";
import { notifyAdmin } from "../lib/notifyAdmin";
import {
  getPurchaseEmailConfig,
  sendPurchaseConfirmationEmail,
} from "../lib/purchaseEmail";
import type { InvoiceOrder } from "../lib/invoicePdf";

interface PurchaseEmailJob extends InvoiceOrder {
  claim_token: string;
  delivery_attempt: number;
}

interface DeliveryLogger {
  info?: (details: unknown, message?: string) => void;
  warn?: (details: unknown, message?: string) => void;
  error?: (details: unknown, message?: string) => void;
}

export interface PurchaseEmailDeliverySummary {
  claimed: number;
  sent: number;
  failed: number;
  skipped?: boolean;
}

let deliveryRunning = false;
let missingConfigWarned = false;

function errorCode(error: unknown): string {
  const value = String((error as any)?.code || (error as Error)?.name || "UNKNOWN").toUpperCase();
  return value.replace(/[^A-Z0-9_-]/g, "_").slice(0, 100) || "UNKNOWN";
}

async function releaseJob(job: PurchaseEmailJob, code: string): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc("release_purchase_email_job", {
    p_order_id: job.job_order_id,
    p_claim_token: job.claim_token,
    p_error_code: code,
  });
  if (error) throw error;
  return Number(data || job.delivery_attempt || 0);
}

export async function runPurchaseEmailDelivery(
  log: DeliveryLogger = console,
): Promise<PurchaseEmailDeliverySummary> {
  if (deliveryRunning) return { claimed: 0, sent: 0, failed: 0, skipped: true };
  const config = getPurchaseEmailConfig();
  if (!config) {
    if (!missingConfigWarned) {
      log.warn?.({ code: "TRANSACTIONAL_EMAIL_NOT_CONFIGURED" }, "Purchase email delivery is disabled until transactional email variables are configured");
      missingConfigWarned = true;
    }
    return { claimed: 0, sent: 0, failed: 0, skipped: true };
  }
  missingConfigWarned = false;

  deliveryRunning = true;
  try {
    const { data, error } = await supabaseAdmin.rpc("claim_purchase_email_jobs", { p_limit: 5 });
    if (error) {
      log.error?.({ code: error.code }, "Unable to claim purchase email jobs");
      throw new Error("PURCHASE_EMAIL_CLAIM_FAILED");
    }
    const jobs = (Array.isArray(data) ? data : []) as PurchaseEmailJob[];
    const summary: PurchaseEmailDeliverySummary = { claimed: jobs.length, sent: 0, failed: 0 };
    for (const job of jobs) {
      try {
        const result = await sendPurchaseConfirmationEmail(job, config);
        const { data: completed, error: completeError } = await supabaseAdmin.rpc("complete_purchase_email_job", {
          p_order_id: job.job_order_id,
          p_claim_token: job.claim_token,
          p_provider_id: result.providerId,
        });
        if (completeError || completed !== true) throw completeError || Object.assign(new Error("PURCHASE_EMAIL_COMPLETE_REJECTED"), { code: "PURCHASE_EMAIL_COMPLETE_REJECTED" });
        summary.sent += 1;
      } catch (error) {
        summary.failed += 1;
        const code = errorCode(error);
        try {
          const attempts = await releaseJob(job, code);
          if (attempts >= 6) {
            await notifyAdmin("L'e-mail de confirmation et la facture n'ont pas pu être envoyés après plusieurs tentatives.", {
              level: "critical",
              orderId: job.job_order_id,
              dedupeKey: `purchase-email-final-${job.job_order_id}`,
            });
          }
        } catch (releaseError) {
          log.error?.({ orderId: job.job_order_id, code: errorCode(releaseError) }, "Unable to release purchase email job");
        }
        log.warn?.({ orderId: job.job_order_id, code, attempt: job.delivery_attempt }, "Purchase email delivery failed");
      }
    }
    return summary;
  } finally {
    deliveryRunning = false;
  }
}

export function schedulePurchaseEmailDeliveryInterval(): void {
  if (process.env.NODE_ENV === "test") return;
  const run = () => {
    runPurchaseEmailDelivery().then((summary) => {
      if (summary.sent > 0 || summary.failed > 0) console.info("[email] Purchase delivery completed.", summary);
    }).catch((error) => {
      console.error("[email] Purchase delivery cycle failed.", { code: errorCode(error) });
    });
  };
  const startupTimer = setTimeout(run, 8_000);
  startupTimer.unref();
  const interval = setInterval(run, 60_000);
  interval.unref();
  console.info("[email] Purchase confirmation delivery scheduled every minute.");
}
