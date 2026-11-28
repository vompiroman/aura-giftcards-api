import { Router } from "express";
import rateLimit from "express-rate-limit";
import { checkoutFunnelEvent, guestLoginExperimentEvent } from "../lib/checkoutFunnel";
import { supabaseAdmin } from "../lib/supabase";
import { requireAdmin } from "../middleware/requireAdmin";

const router = Router();
const dayMs = 86_400_000;
const algiersOffsetMs = 3_600_000;
const limiter = rateLimit({
  windowMs: 60_000,
  limit: 45,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/checkout-funnel", limiter, async (req, res) => {
  if (!req.get("origin")) return res.sendStatus(403);
  if (Object.hasOwn(req.body ?? {}, "experiment_event")) {
    const event = guestLoginExperimentEvent.safeParse(req.body);
    if (!event.success) return res.sendStatus(400);
    const { journey_id, experiment_event, occurred_at, journey_expires_at } = event.data;
    const now = Date.now();
    const start = Date.parse(process.env.CHECKOUT_GUEST_LOGIN_AB_START ?? "");
    const end = start + 28 * dayMs;
    const recorded = Math.min(now, occurred_at);
    const remaining = journey_expires_at - occurred_at;
    const exposure = experiment_event === "guest_login_exposure";
    if (remaining <= 0 || remaining > dayMs) return res.sendStatus(400);
    if (!(recorded >= start && recorded < (exposure ? end : end + dayMs)) || recorded < now - dayMs) {
      // A paused or expired experiment must not stall the normal measurement outbox.
      return res.sendStatus(204);
    }
    const { error } = await supabaseAdmin.from("checkout_guest_login_ab_events").upsert({
      journey_id, kind: experiment_event, variant: parseInt(journey_id[0], 16) < 8 ? "A" : "B",
      occurred_at: new Date(recorded).toISOString(),
      journey_expires_at: new Date(recorded + remaining).toISOString(),
    }, { onConflict: "journey_id,kind", ignoreDuplicates: true });
    return res.sendStatus(error ? 503 : 204);
  }
  const event = checkoutFunnelEvent.safeParse(req.body);
  if (!event.success) return res.sendStatus(400);
  const { journey_id, stage, services, occurred_at } = event.data;
  const now = Date.now();
  // Bound client clocks and allow delayed delivery without shifting the cohort.
  const recorded = occurred_at === undefined ? {} : {
    recorded_at: new Date(Math.min(now, Math.max(now - dayMs, occurred_at))).toISOString(),
  };
  const rows = [...new Set(services)].map(service => ({ journey_id, stage, service, ...recorded }));
  const { error } = await supabaseAdmin.from("checkout_funnel_events")
    .upsert(rows, { onConflict: "journey_id,service,stage", ignoreDuplicates: true });
  return res.sendStatus(error ? 503 : 204);
});

router.get("/admin/checkout-funnel", limiter, requireAdmin, async (_req, res) => {
  const today = Math.floor((Date.now() + algiersOffsetMs) / dayMs) * dayMs - algiersOffsetMs;
  const to = today - dayMs;
  const from = to - 30 * dayMs;
  const { data, error } = await supabaseAdmin.rpc("checkout_funnel_report", {
    p_from: new Date(from).toISOString(),
    p_to: new Date(to).toISOString(),
  });
  if (error || !data) return res.sendStatus(503);
  const dateLabel = (timestamp: number) => new Date(timestamp + algiersOffsetMs).toISOString().slice(0, 10);
  return res.json({ ...data, from: dateLabel(from), through: dateLabel(to - dayMs) });
});

export default router;
