import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();
app.set("trust proxy", 1);

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
  const raw = [
    process.env.ALLOWED_ORIGINS,
    process.env.FRONTEND_URL,
    "https://aura-stream.vercel.app",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "null",
  ]
    .filter((v): v is string => Boolean(v))
    .flatMap((v) => v.split(","))
    .map(normalizeOrigin)
    .filter(Boolean);

  return new Set(raw);
}

const allowedOrigins = buildAllowedOrigins();
const corsSoftMode = process.env.CORS_SOFT_MODE !== "false";

const corsOptions: cors.CorsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    const normalized = normalizeOrigin(origin);
    if (
      allowedOrigins.has(normalized) ||
      /\.(vercel\.app|netlify\.app|onrender\.com|replit\.dev|replit\.app)$/i.test(normalized) ||
      normalized.includes("localhost") ||
      normalized.includes("127.0.0.1")
    ) {
      return callback(null, true);
    }
    console.warn(`[CORS] Origine non whitelistée : ${origin} (normalisée: ${normalized})`);
    if (corsSoftMode) {
      console.warn(`[CORS] SOFT_MODE actif -> origine tolérée : ${origin}`);
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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
