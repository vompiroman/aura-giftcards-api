import { Request, Response, NextFunction } from "express";
import type { User } from "@supabase/supabase-js";
import { supabaseAuth as supabase } from "../lib/supabase";
import { isTemporaryAuthError } from "../lib/authAvailability";
import { accessTokenFromRequest } from "../lib/sessionCookies";

export function isAdmin(user?: Pick<User, "id" | "app_metadata"> | null): boolean {
  return !!user?.id && user.app_metadata?.role === "admin";
}

// Call only with a JWT already verified by Supabase Auth or issued by MFA verification.
export function hasAdminMfa(token: string, userId: string): boolean {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return claims.sub === userId && claims.aal === "aal2";
  } catch {
    return false;
  }
}

export interface AuthedRequest extends Request {
  adminEmail?: string;
  adminUserId?: string;
  adminToken?: string;
}

export async function requireAdminIdentity(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = accessTokenFromRequest(req);
    if (!token) {
      res.status(401).json({ error: "Token manquant." });
      return;
    }

    const { data, error } = await supabase.auth.getUser(token);
    if (isTemporaryAuthError(error)) {
      res.status(503).json({ error: "Service d'authentification indisponible." });
      return;
    }
    const email = data?.user?.email?.toLowerCase();
    if (error || !email) {
      res.status(401).json({ error: "Token invalide ou expiré." });
      return;
    }

    if (!isAdmin(data.user)) {
      res.status(404).json({ error: "Not found." });
      return;
    }

    req.adminEmail = email;
    req.adminUserId = data.user.id;
    req.adminToken = token;
    next();
  } catch (err) {
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
}

export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  return requireAdminIdentity(req, res, () => {
    if (!hasAdminMfa(req.adminToken!, req.adminUserId!)) {
      res.status(403).json({ code: "ADMIN_MFA_REQUIRED", error: "La double authentification administrateur est requise." });
      return;
    }
    next();
  });
}
