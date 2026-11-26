import type { Request } from "express";
import { accessTokenFromRequest } from "./sessionCookies";
import { supabaseAuth } from "./supabase";

export async function getAuthedOrderUser(req: Request) {
  const token = accessTokenFromRequest(req);
  if (!token) return null;
  const { data, error } = await supabaseAuth.auth.getUser(token);
  if (error || !data?.user?.id || !data.user.email) return null;
  return { id: data.user.id, email: data.user.email.trim().toLowerCase() };
}

export function sameOrderOwner(left: { customer_user_id?: string | null }, right?: { customer_user_id?: string | null } | null): boolean {
  return Boolean(left.customer_user_id && left.customer_user_id === right?.customer_user_id);
}
