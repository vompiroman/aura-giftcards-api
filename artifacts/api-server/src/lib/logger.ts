import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
    "access_token",
    "refresh_token",
    "token",
    "password",
    "*.access_token",
    "*.refresh_token",
    "*.token",
    "*.password",
    "err.config.headers.Authorization",
    "err.config.headers.authorization",
    "err.config.data",
    "err.response.config",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
