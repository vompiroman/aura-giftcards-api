export function isTemporaryAuthError(error: { status?: number } | null | undefined): boolean {
  return Boolean(error && (!error.status || error.status >= 500 || error.status === 429));
}

// Used only for renewal scheduling after Supabase has verified the token.
// Unverified claims must never authorize a request.
export function verifiedAccessExpiry(token: string): number | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}
