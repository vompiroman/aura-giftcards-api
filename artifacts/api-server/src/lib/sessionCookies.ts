import type { Session } from "@supabase/supabase-js";
import type { CookieOptions, NextFunction, Request, Response } from "express";

export const ACCESS_COOKIE_NAME = "aura_access";
export const REFRESH_COOKIE_NAME = "aura_refresh";
export const REMEMBER_COOKIE_NAME = "aura_remember";

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_YEAR_MS = 365 * 24 * ONE_HOUR_MS;

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
  return Boolean(req.cookies?.[ACCESS_COOKIE_NAME] || req.cookies?.[REFRESH_COOKIE_NAME]);
}

export function attachCookieAuthorization(req: Request, _res: Response, next: NextFunction): void {
  if (!bearerToken(req)) {
    const accessToken = safeCookieValue(req.cookies?.[ACCESS_COOKIE_NAME]);
    if (accessToken) req.headers.authorization = `Bearer ${accessToken}`;
  }
  next();
}

export function setSessionCookies(res: Response, session: Session, remember: boolean): void {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresInMs = session.expires_at
    ? Math.max(1_000, Math.min(ONE_HOUR_MS, (session.expires_at - nowSeconds) * 1_000))
    : ONE_HOUR_MS;
  const persistent = remember ? { maxAge: ONE_YEAR_MS } : {};

  res.cookie(ACCESS_COOKIE_NAME, session.access_token, {
    ...baseCookieOptions,
    ...(remember ? { maxAge: expiresInMs } : {}),
  });
  res.cookie(REFRESH_COOKIE_NAME, session.refresh_token, {
    ...baseCookieOptions,
    ...persistent,
  });
  res.cookie(REMEMBER_COOKIE_NAME, remember ? "1" : "0", {
    ...baseCookieOptions,
    ...persistent,
  });
}

export function clearSessionCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE_NAME, baseCookieOptions);
  res.clearCookie(REFRESH_COOKIE_NAME, baseCookieOptions);
  res.clearCookie(REMEMBER_COOKIE_NAME, baseCookieOptions);
}
