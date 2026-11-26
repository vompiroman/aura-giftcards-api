/** Used only with mocked Supabase verification. */
export function adminTestToken(id: string, aal: "aal1" | "aal2" = "aal2"): string {
  return ["test", Buffer.from(JSON.stringify({ sub: id, aal })).toString("base64url"), "test-signature"].join(".");
}
