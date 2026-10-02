import type { SupabaseClient } from "@supabase/supabase-js";

// Supabase clients share a single in-flight refresh promise. Each token needs
// its own client so concurrent visitors cannot receive each other's session.
// Requests from the same session share the refresh until it finishes.
export function createSessionRefresher(createClient: () => Pick<SupabaseClient, "auth">) {
  const pending = new Map<string, ReturnType<SupabaseClient["auth"]["refreshSession"]>>();
  return function refreshSession(refreshToken: string) {
    const existing = pending.get(refreshToken);
    if (existing) return existing;
    const result = createClient().auth.refreshSession({ refresh_token: refreshToken });
    const tracked = result.finally(() => pending.delete(refreshToken));
    pending.set(refreshToken, tracked);
    return tracked;
  };
}
