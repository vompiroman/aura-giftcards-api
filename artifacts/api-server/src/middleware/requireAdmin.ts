import { Request, Response, NextFunction } from "express";
import { supabaseAuth as supabase } from "../lib/supabase";

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export interface AuthedRequest extends Request {
  adminEmail?: string;
}

export async function requireAdmin(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) {
      res.status(401).json({ error: "Token manquant." });
      return;
    }
    const token = h.slice(7).trim();
    if (!token) {
      res.status(401).json({ error: "Token manquant." });
      return;
    }

    const { data, error } = await supabase.auth.getUser(token);
    const email = data?.user?.email?.toLowerCase();
    if (error || !email) {
      res.status(401).json({ error: "Token invalide ou expiré." });
      return;
    }

    if (!ADMIN_EMAILS.includes(email)) {
      res.status(404).json({ error: "Not found." });
      return;
    }

    req.adminEmail = email;
    next();
  } catch (err) {
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
}
