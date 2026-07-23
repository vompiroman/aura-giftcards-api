import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import rateLimit from "express-rate-limit";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();
// Trust only the configured number of reverse-proxy hops. A hard-coded trust
// value can let a direct client spoof X-Forwarded-For and bypass rate limits.
const trustProxyHops = Number.parseInt(process.env.TRUST_PROXY_HOPS || "1", 10);
app.set("trust proxy", Number.isFinite(trustProxyHops) && trustProxyHops >= 0 ? trustProxyHops : 1);
app.disable("x-powered-by");

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

function buildAllowedOrigins(): Set<string> {
  const configured = [
    process.env.ALLOWED_ORIGINS,
    process.env.FRONTEND_URL,
    "https://aura-stream.vercel.app",
    "https://aura-stream.netlify.app",
  ]
    .filter((v): v is string => Boolean(v))
    .flatMap((v) => v.split(","))
    .map(normalizeOrigin)
    .filter(Boolean);

  const localDevelopment = process.env.NODE_ENV !== "production"
    ? ["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:5173"]
    : [];
  return new Set([...configured, ...localDevelopment].map(normalizeOrigin));
}

const allowedOrigins = buildAllowedOrigins();
const corsSoftMode = process.env.NODE_ENV !== "production" && process.env.CORS_SOFT_MODE === "true";

const corsOptions: cors.CorsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    const normalized = normalizeOrigin(origin);
    let isLocalDevelopmentOrigin = false;
    try {
      const parsed = new URL(normalized);
      isLocalDevelopmentOrigin = process.env.NODE_ENV !== "production"
        && (parsed.protocol === "http:")
        && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    } catch {
      isLocalDevelopmentOrigin = false;
    }
    if (allowedOrigins.has(normalized) || isLocalDevelopmentOrigin) {
      return callback(null, true);
    }
    console.warn(`[CORS] Origine non whitelistÃƒÂ©e : ${origin} (normalisÃƒÂ©e: ${normalized})`);
    if (corsSoftMode) {
      console.warn(`[CORS] SOFT_MODE actif -> origine tolÃƒÂ©rÃƒÂ©e : ${origin}`);
      return callback(null, true);
    }
    return callback(null, false);
  },
  credentials: false,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-webhook-secret", "Accept", "Origin", "X-Requested-With"],
  optionsSuccessStatus: 200,
  maxAge: 86400,
};

app.use(cors(corsOptions));
app.options(/(.*)/, cors(corsOptions));

const globalApiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || "unknown",
  message: { error: "Trop de requÃƒÂªtes. RÃƒÂ©essayez dans quelques minutes." },
});

app.use("/api", globalApiLimiter, (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.append("Vary", "Authorization");
  res.append("Vary", "Origin");
  next();
});
app.use(express.json({ limit: "64kb", strict: true }));
app.use(express.urlencoded({ extended: false, limit: "32kb" }));

app.use("/api", router);

app.use((err: any, req: any, res: any, next: any) => {
  if (res.headersSent) return next(err);
  req.log?.error({ err }, "Unhandled request error");
  return res.status(500).json({ error: "Erreur interne du serveur." });
});

export default app;
