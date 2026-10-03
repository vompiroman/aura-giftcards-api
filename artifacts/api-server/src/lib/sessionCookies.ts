import type { Session } from "@supabase/supabase-js";
import { WEB_SESSION_COOKIE, WEB_SESSION_LIFETIME_MS } from "./webSession";
import { webSessions } from "./webSessionStore";
import type { CookieOptions, NextFunction, Request, Response } from "express";

export const ACCESS_COOKIE_NAME = "aura_access";
export const REFRESH_COOKIE_NAME = "aura_refresh";
export const REMEMBER_COOKIE_NAME = "aura_remember";


const baseCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/api",
  priority: "high",
};

function safeCookieValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 4096 || /[\r\n]/.test(normalized)) return null;
  return normalized;
}

function bearerToken(req: Request): string | null {
  const value = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  if (!/^Bearer\s+/i.test(value)) return null;
  return safeCookieValue(value.replace(/^Bearer\s+/i, ""));
}

export function accessTokenFromRequest(req: Request): string | null {
  return bearerToken(req) || safeCookieValue(req.cookies?.[ACCESS_COOKIE_NAME]);
}

export function refreshTokenFromRequest(req: Request): string | null {
  return safeCookieValue(req.cookies?.[REFRESH_COOKIE_NAME]);
}

export function rememberSessionFromRequest(req: Request): boolean {
  return req.cookies?.[REMEMBER_COOKIE_NAME] === "1";
}

export function requestUsesAuthCookies(req: Request): boolean {
  return Boolean(req.cookies?.[WEB_SESSION_COOKIE] || req.cookies?.[ACCESS_COOKIE_NAME] || req.cookies?.[REFRESH_COOKIE_NAME]);
}

export function attachCookieAuthorization(req: Request, _res: Response, next: NextFunction): void {
  if (!bearerToken(req)) {
    const accessToken = safeCookieValue(req.cookies?.[ACCESS_COOKIE_NAME]);
    if (accessToken) req.headers.authorization = `Bearer ${accessToken}`;
  }
  next();
}

export async function setSessionCookies(res: Response, session: Session, remember: boolean): Promise<void> {
  if (!session.user?.id || !session.expires_at) throw new Error("Session without verified user or expiry");
  const cookie = await webSessions().create({
    access_token: session.access_token, refresh_token: session.refresh_token, expires_at: session.expires_at,
  }, session.user.id, remember);
  res.cookie(WEB_SESSION_COOKIE, cookie, {
    ...baseCookieOptions, ...(remember ? { maxAge: WEB_SESSION_LIFETIME_MS } : {}),
  });
  clearLegacySessionCookies(res);
}

export function clearLegacySessionCookies(res: Response): void {
  for (const name of [ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME, REMEMBER_COOKIE_NAME]) {
    res.clearCookie(name, baseCookieOptions);
    // Also retire cookie paths used before the same-origin API proxy.
    res.clearCookie(name, { ...baseCookieOptions, path: "/" });
  }
}

export function clearSessionCookies(res: Response): void {
  res.clearCookie(WEB_SESSION_COOKIE, baseCookieOptions);
  clearLegacySessionCookies(res);
}