import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireAdmin } from "../middleware/requireAdmin";
import { supabaseAdmin } from "../lib/supabase";

const router = Router();
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REPORT_DAYS = 366;
const REPORT_PAGE_SIZE = 1_000;
const ALGIERS_OFFSET = "+01:00";

type PaidOrderRow = {
  amount: number | string | null;
  created_at: string;
};

function parseDateOnly(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : value;
}

function dateRangeDays(startDate: string, endDate: string): number {
  return Math.floor((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / DAY_MS) + 1;
}

function dateKeys(startDate: string, days: number): string[] {
  const firstDay = Date.parse(`${startDate}T00:00:00Z`);
  return Array.from({ length: days }, (_, index) => new Date(firstDay + index * DAY_MS).toISOString().slice(0, 10));
}

function algiersDateKey(value: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Algiers",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type: "year" | "month" | "day") => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

async function loadPaidOrdersForRange(startDate: string, endDate: string) {
  const startAt = new Date(`${startDate}T00:00:00${ALGIERS_OFFSET}`).toISOString();
  const endAt = new Date(Date.parse(`${endDate}T00:00:00${ALGIERS_OFFSET}`) + DAY_MS).toISOString();
  const rows: PaidOrderRow[] = [];

  for (let offset = 0; ; offset += REPORT_PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("orders")
      .select("amount, created_at")
      .eq("payment_status", "paid")
      .gte("created_at", startAt)
      .lt("created_at", endAt)
      .order("created_at", { ascending: true })
      .range(offset, offset + REPORT_PAGE_SIZE - 1);

    if (error) return { rows: null, error };
    const page = (data || []) as PaidOrderRow[];
    rows.push(...page);
    if (page.length < REPORT_PAGE_SIZE) break;
  }

  return { rows, error: null };
}

function buildRevenueRange(rows: PaidOrderRow[], startDate: string, days: number) {
  const totals = new Map(dateKeys(startDate, days).map((date) => [date, { revenue: 0, sales: 0 }]));
  for (const row of rows) {
    const day = algiersDateKey(row.created_at);
    const bucket = totals.get(day);
    if (!bucket) continue;
    bucket.revenue += Number(row.amount || 0);
    bucket.sales += 1;
  }
  return [...totals.entries()].map(([date, values]) => ({ date, ...values }));
}

const adminReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de requêtes administrateur. Réessayez dans une minute." },
});

router.get("/admin/dashboard", adminReadLimiter, requireAdmin, async (req, res) => {
  const requestedStart = req.query.start_date;
  const requestedEnd = req.query.end_date;
  const hasCustomRange = requestedStart !== undefined || requestedEnd !== undefined;
  const startDate = parseDateOnly(requestedStart);
  const endDate = parseDateOnly(requestedEnd);

  if (hasCustomRange && (!startDate || !endDate)) {
    return res.status(400).json({ error: "Sélectionnez une date de début et une date de fin valides." });
  }

  const customDays = startDate && endDate ? dateRangeDays(startDate, endDate) : null;
  if (customDays !== null && (customDays < 1 || customDays > MAX_REPORT_DAYS)) {
    return res.status(400).json({ error: "La période doit contenir entre 1 et 366 jours." });
  }

  const parsedDays = Number.parseInt(String(req.query.days || "30"), 10);
  const days = customDays || (Number.isFinite(parsedDays) ? Math.max(7, Math.min(parsedDays, 365)) : 30);

  const { data, error } = await supabaseAdmin.rpc("get_admin_dashboard_metrics", {
    p_days: days,
  });

  if (error || !data || typeof data !== "object") {
    req.log?.error({ error }, "Admin dashboard metrics failed");
    return res.status(503).json({ error: "Les statistiques administrateur sont momentanément indisponibles." });
  }

  if (startDate && endDate && customDays) {
    const paidOrders = await loadPaidOrdersForRange(startDate, endDate);
    if (paidOrders.error || !paidOrders.rows) {
      req.log?.error({ error: paidOrders.error }, "Admin custom revenue range failed");
      return res.status(503).json({ error: "Les revenus de cette période sont momentanément indisponibles." });
    }

    const revenueByDay = buildRevenueRange(paidOrders.rows, startDate, customDays);
    const revenuePeriod = revenueByDay.reduce((total, row) => total + row.revenue, 0);
    const paidOrdersPeriod = revenueByDay.reduce((total, row) => total + row.sales, 0);
    const dashboard = data as Record<string, unknown>;
    const summary = dashboard.summary && typeof dashboard.summary === "object"
      ? dashboard.summary as Record<string, unknown>
      : {};

    return res.json({
      generated_at: new Date().toISOString(),
      period_days: customDays,
      period_start: startDate,
      period_end: endDate,
      ...dashboard,
      summary: {
        ...summary,
        revenue_period: revenuePeriod,
        paid_orders_period: paidOrdersPeriod,
      },
      revenue_by_day: revenueByDay,
    });
  }

  return res.json({
    generated_at: new Date().toISOString(),
    period_days: days,
    ...(data as Record<string, unknown>),
  });
});

router.get("/admin/audit-logs", adminReadLimiter, requireAdmin, async (req, res) => {
  const parsedLimit = Number.parseInt(String(req.query.limit || "30"), 10);
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 100)) : 30;

  const { data, error } = await supabaseAdmin
    .from("audit_logs")
    .select("id, created_at, action, target_type, target_id, details")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    req.log?.error({ error }, "Admin audit log read failed");
    return res.status(503).json({ error: "Le journal d’activité est momentanément indisponible." });
  }

  return res.json({ events: data || [] });
});

export default router;
