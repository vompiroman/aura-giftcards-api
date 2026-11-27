import { Router } from "express";
import rateLimit from "express-rate-limit";
import { checkoutFunnelEvent } from "../lib/checkoutFunnel";
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
  const event = checkoutFunnelEvent.safeParse(req.body);
  if (!event.success) return res.sendStatus(400);
  const { journey_id, stage, services } = event.data;
  const rows = [...new Set(services)].map(service => ({ journey_id, stage, service }));
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
