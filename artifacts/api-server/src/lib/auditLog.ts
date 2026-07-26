import { supabaseAdmin } from "./supabase";

const SENSITIVE_KEY = /pass(word)?|token|secret|credential|authorization|cookie|apikey|access[_-]?token|refresh[_-]?token/i;

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 3) return "[truncated]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) continue;
      result[key.slice(0, 80)] = sanitize(item, depth + 1);
    }
    return result;
  }
  return undefined;
}

export async function appendAuditLog(input: {
  action: string;
  actorUserId?: string | null;
  targetType?: string;
  targetId?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    await supabaseAdmin.from("audit_logs").insert({
      action: input.action.slice(0, 120),
      actor_user_id: input.actorUserId || null,
      target_type: input.targetType?.slice(0, 80) || null,
      target_id: input.targetId?.slice(0, 160) || null,
      details: sanitize(input.details || {}),
    });
  } catch {
    // Audit failures must not change a successful business operation.
    console.error("[audit] append failed");
  }
}
