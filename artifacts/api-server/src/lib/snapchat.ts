/** Snapchat username, not display name; accept an optional leading @. */
export function normalizeSnapchatUsername(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const username = value.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z][a-z0-9._-]{1,13}[a-z0-9]$/.test(username)) return null;
  return username;
}

export function snapchatActivationReady(item: any): boolean {
  return normalizeSnapchatUsername(item?.snapchat_username) !== null && item?.snapchat_friend_added === true;
}
