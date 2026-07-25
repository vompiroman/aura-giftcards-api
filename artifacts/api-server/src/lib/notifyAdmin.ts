import crypto from "crypto";

const recentAlerts = new Map<string, number>();
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

type AlertLevel = "critical" | "warning" | "info";

interface AlertOptions {
  level?: AlertLevel;
  orderId?: string;
  service?: string;
  email?: string;
  dedupeKey?: string;
}

const LEVEL_COLOR: Record<AlertLevel, number> = {
  critical: 0xe11d48, // rouge
  warning: 0xf59e0b, // orange
  info: 0x3b82f6, // bleu
};

const LEVEL_LABEL: Record<AlertLevel, string> = {
  critical: "Ã°Å¸â€Â´ CRITIQUE",
  warning: "Ã°Å¸Å¸Â  ALERTE",
  info: "Ã°Å¸â€Âµ INFO",
};

function pruneDedup(now: number): void {
  for (const [key, ts] of recentAlerts) {
    if (now - ts > DEDUP_WINDOW_MS) recentAlerts.delete(key);
  }
}

function safeDiscordText(value: string, max: number): string {
  return String(value).replace(/[\r\n`*_~|<>@]/g, " ").slice(0, max);
}

export async function notifyAdmin(
  message: string,
  opts: AlertOptions = {}
): Promise<boolean> {
  const level: AlertLevel = opts.level ?? "critical";

  try {
    const webhookUrl = process.env.DISCORD_ADMIN_WEBHOOK_URL;
    if (!webhookUrl) {
      console.error("[notifyAdmin] DISCORD_ADMIN_WEBHOOK_URL non dÃƒÂ©fini.");
      return false;
    }

    const dedupeKey =
      opts.dedupeKey ?? opts.orderId ?? crypto.createHash("sha1").update(message).digest("hex");
    const now = Date.now();
    pruneDedup(now);
    const last = recentAlerts.get(dedupeKey);
    if (last && now - last < DEDUP_WINDOW_MS) {
      return false;
    }
    recentAlerts.set(dedupeKey, now);

    const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
    if (opts.orderId) fields.push({ name: "Commande", value: safeDiscordText(opts.orderId, 120), inline: true });
    if (opts.service) fields.push({ name: "Service", value: safeDiscordText(opts.service, 120), inline: true });
    if (opts.email) fields.push({ name: "Client", value: safeDiscordText(opts.email, 254), inline: false });

    const payload = {
      content: level === "critical" ? "@here Intervention manuelle requise" : undefined,
      embeds: [
        {
          title: `${LEVEL_LABEL[level]} Ã¢â‚¬â€ Aura Stream`,
          description: safeDiscordText(message, 4000),
          color: LEVEL_COLOR[level],
          fields: fields.length ? fields : undefined,
          timestamp: new Date().toISOString(),
          footer: { text: "Aura Stream Ã¢â‚¬Â¢ Webhook de paiement" },
        },
      ],
      allowed_mentions: { parse: [] },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);

    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        console.error(`[notifyAdmin] Discord a rÃƒÂ©pondu ${res.status}`);
        return false;
      }
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.error("[notifyAdmin] Ãƒâ€°chec d'envoi de l'alerte:", (err as Error)?.message);
    return false;
  }
}
