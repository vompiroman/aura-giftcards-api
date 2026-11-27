import { z } from "zod";
import { supabaseAdmin } from "./supabase";

const stages = ["product_view", "add_to_cart", "cart_view", "login_view", "customer_info", "summary_view"] as const;
const services = ["netflix", "spotify", "crunchyroll", "snapchat"] as const;

export const checkoutJourneyId = z.string().regex(
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
);

export const checkoutFunnelEvent = z.object({
  journey_id: checkoutJourneyId,
  stage: z.enum(stages),
  services: z.array(z.enum(services)).min(1).max(4),
}).strict();

export async function linkCheckoutOrder(journey: unknown, orderId: string, items: { name: string }[]) {
  const id = checkoutJourneyId.safeParse(journey);
  if (!id.success) return;
  const purchased = services.filter(service => items.some(item => item.name.toLowerCase().startsWith(service)));
  if (!purchased.length) return;
  // Commerce still succeeds if analytics is unavailable.
  try {
    await supabaseAdmin.from("checkout_funnel_orders")
      .upsert({ order_id: orderId, journey_id: id.data, services: purchased }, {
        onConflict: "order_id", ignoreDuplicates: true,
      }).abortSignal(AbortSignal.timeout(1500));
  } catch { /* Analytics is best effort. */ }
}
