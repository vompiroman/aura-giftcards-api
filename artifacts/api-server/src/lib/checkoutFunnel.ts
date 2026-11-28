import { z } from "zod";

const stages = ["product_view", "add_to_cart", "cart_view", "login_view", "customer_info", "summary_view"] as const;
const services = ["netflix", "spotify", "crunchyroll", "snapchat"] as const;

export const checkoutJourneyId = z.string().regex(
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
);

export const checkoutFunnelEvent = z.object({
  journey_id: checkoutJourneyId,
  stage: z.enum(stages),
  services: z.array(z.enum(services)).min(1).max(4),
  occurred_at: z.number().int().positive().optional(),
}).strict();

export const guestLoginExperimentEvent = z.object({
  journey_id: checkoutJourneyId,
  experiment_event: z.enum(["guest_login_exposure", "guest_login_auth_error", "guest_login_checkout_error"]),
  occurred_at: z.number().int().positive(),
  journey_expires_at: z.number().int().positive(),
}).strict();

export function checkoutMeasurement(journey: unknown, items: { name: string }[]) {
  const id = checkoutJourneyId.safeParse(journey);
  if (!id.success) return null;
  const purchased = services.filter(service => items.some(item => item.name.toLowerCase().startsWith(service)));
  return purchased.length ? { p_journey: id.data, p_services: purchased } : null;
}
