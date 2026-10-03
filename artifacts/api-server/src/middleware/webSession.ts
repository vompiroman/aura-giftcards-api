import type { Request, Response, NextFunction } from "express";
import { webSessions } from "../lib/webSessionStore";
import { WEB_SESSION_COOKIE } from "../lib/webSession";

export type SessionRequest = Request & {
  webSession?: NonNullable<Awaited<ReturnType<ReturnType<typeof webSessions>["resolve"]>>> | null;
};

const publicPaths = new Set(["/login", "/register", "/forgot-password", "/reset-password", "/logout", "/healthz", "/client-errors"]);

export async function attachWebSession(req: SessionRequest, res: Response, next: NextFunction): Promise<void> {
  // Explicit bearer clients retain their existing API contract. Cookies never
  // override an explicitly provided token.
  if (!req.cookies?.[WEB_SESSION_COOKIE] || publicPaths.has(req.path) || req.headers.authorization) { next(); return; }
  try {
    req.webSession = await webSessions().resolve(req.cookies[WEB_SESSION_COOKIE]);
    if (req.webSession) req.headers.authorization = `Bearer ${req.webSession.tokens.access_token}`;
    next();
  } catch {
    // Database/Auth outages are unavailable, never anonymous, and never erase cookies.
    res.status(503).json({ error: "Service de connexion momentanément indisponible." });
  }
}
