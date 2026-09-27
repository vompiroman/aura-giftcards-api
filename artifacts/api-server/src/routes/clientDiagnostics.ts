import { Router } from "express";
import rateLimit from "express-rate-limit";

const router = Router();

const clientErrorLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false, default: false },
  message: { error: "Trop de diagnostics envoyés. Réessayez plus tard." },
});

function safeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[?#].*$/, "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/bearer\s+[a-z0-9._~-]+/gi, "Bearer [redacted]")
    .trim();
  return sanitized ? sanitized.slice(0, maxLength) : undefined;
}

function safeCoordinate(value: unknown): number | undefined {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 10_000_000) return undefined;
  return numeric;
}

router.post("/client-errors", clientErrorLimiter, (req, res) => {
  const diagnostic = {
    event: safeText(req.body?.event, 40) || "runtime",
    message: safeText(req.body?.message, 300) || "Unexpected client error",
    route: safeText(req.body?.route, 160),
    source: safeText(req.body?.source, 160),
    line: safeCoordinate(req.body?.line),
    column: safeCoordinate(req.body?.column),
  };

  req.log?.warn({ clientError: diagnostic }, "Frontend client error reported");
  res.status(202).json({ accepted: true });
});

export default router;
