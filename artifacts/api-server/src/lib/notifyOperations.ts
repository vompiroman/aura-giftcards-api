interface OperationsAlertOptions {
  orderId?: string;
  service?: string;
  credentials?: {
    email: string;
    password: string;
    whatsapp: string;
  };
}

function safeDiscordText(value: string, max: number): string {
  return String(value).replace(/[\r\n`*_~|<>]/g, " ").slice(0, max);
}

/** Sends a fulfillment notification to the private operational Discord channel. */
export async function notifyOperations(
  message: string,
  opts: OperationsAlertOptions = {},
): Promise<boolean> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return false;

  let confirmedWebhookUrl: string;
  try {
    const parsed = new URL(webhookUrl);
    if (parsed.protocol !== "https:") return false;
    parsed.searchParams.set("wait", "true");
    confirmedWebhookUrl = parsed.toString();
  } catch {
    return false;
  }

  const fields = [
    opts.orderId
      ? { name: "Commande", value: safeDiscordText(opts.orderId, 120), inline: true }
      : null,
    opts.service
      ? { name: "Service", value: safeDiscordText(opts.service, 120), inline: true }
      : null,
    opts.credentials?.email
      ? { name: "E-mail du compte", value: safeDiscordText(opts.credentials.email, 254), inline: false }
      : null,
    opts.credentials?.password
      ? { name: "Mot de passe temporaire", value: `||${safeDiscordText(opts.credentials.password, 256)}||`, inline: false }
      : null,
    opts.credentials?.whatsapp
      ? { name: "WhatsApp", value: safeDiscordText(opts.credentials.whatsapp, 40), inline: true }
      : null,
  ].filter(Boolean);

  const body = JSON.stringify({
    content: safeDiscordText(message, 4000),
    embeds: fields.length
      ? [{ title: "Aura Stream — Activation", fields, timestamp: new Date().toISOString() }]
      : undefined,
    allowed_mentions: { parse: [] },
  });

  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(confirmedWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
      if (response.ok) return true;
      if (response.status >= 400 && response.status < 500 && response.status !== 429) return false;
    } catch {
      // Une panne réseau transitoire est retentée ci-dessous. Les identifiants
      // restent chiffrés en base pour le rattrapage périodique.
    } finally {
      clearTimeout(timer);
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 300));
  }
  return false;
}
