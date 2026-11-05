/** Validate destinations before sending private operational data. Never log URLs. */
export function discordWebhookUrl(value: string | undefined, wait = false): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return null;
    if (!["discord.com", "discordapp.com"].includes(url.hostname)) return null;
    if (!/^\/api(?:\/v\d+)?\/webhooks\/\d{16,22}\/[A-Za-z0-9_-]{8,}\/?$/.test(url.pathname)) return null;
    if ([...url.searchParams.keys()].some(key => !["wait", "thread_id"].includes(key))) return null;
    if (url.searchParams.has("thread_id") && !/^\d{16,22}$/.test(url.searchParams.get("thread_id")!)) return null;
    if (wait) url.searchParams.set("wait", "true");
    return url.toString();
  } catch {
    return null;
  }
}
