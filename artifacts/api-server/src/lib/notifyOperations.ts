interface OperationsAlertOptions {
  orderId?: string;
  service?: string;
}

function safeDiscordText(value: string, max: number): string {
  return String(value).replace(/[\r\n`*_~|<>@]/g, " ").slice(0, max);
}

/**
 * Sends non-sensitive fulfillment notifications to the operational Discord
 * channel. Credentials are intentionally never accepted as input or included
 * in the payload; administrators retrieve them through the authenticated panel.
 */
export async function notifyOperations(
  message: string,
  opts: OperationsAlertOptions = {},
): Promise<boolean> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return false;

  const fields = [
    opts.orderId
      ? { name: "Commande", value: safeDiscordText(opts.orderId, 120), inline: true }
      : null,
    opts.service
      ? { name: "Service", value: safeDiscordText(opts.service, 120), inline: true }
      : null,
  ].filter(Boolean);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: safeDiscordText(message, 4000),
        embeds: fields.length
          ? [{ title: "Aura Stream — Activation", fields, timestamp: new Date().toISOString() }]
          : undefined,
        allowed_mentions: { parse: [] },
      }),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
