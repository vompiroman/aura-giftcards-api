import { notifyAdmin } from "./notifyAdmin";

interface FailureState {
  count: number;
  lastAlertAt: number;
}

const failures = new Map<string, FailureState>();

function threshold(): number {
  const value = Number.parseInt(process.env.PAYMENT_ALERT_THRESHOLD || "3", 10);
  return Number.isFinite(value) ? Math.max(1, Math.min(value, 100)) : 3;
}

function cooldownMs(): number {
  const value = Number.parseInt(process.env.PAYMENT_ALERT_COOLDOWN_MS || "300000", 10);
  return Number.isFinite(value) ? Math.max(10_000, Math.min(value, 86_400_000)) : 300_000;
}

export async function recordPaymentFailure(
  kind: "blocked" | "webhook",
  key: string,
): Promise<void> {
  const safeKey = String(key || "unknown").slice(0, 120);
  const state = failures.get(`${kind}:${safeKey}`) || { count: 0, lastAlertAt: 0 };
  state.count += 1;
  const now = Date.now();
  if (state.count >= threshold() && now - state.lastAlertAt >= cooldownMs()) {
    state.lastAlertAt = now;
    await notifyAdmin(
      kind === "blocked"
        ? "Paiements bloqués à répétition. Vérification manuelle requise."
        : "Échecs répétés du webhook de paiement. Vérification manuelle requise.",
      {
        level: "critical",
        orderId: safeKey === "unknown" ? undefined : safeKey,
        dedupeKey: `payment-${kind}-${safeKey}`,
      },
    );
  }
  failures.set(`${kind}:${safeKey}`, state);
}

export function resetPaymentFailure(kind: "blocked" | "webhook", key: string): void {
  failures.delete(`${kind}:${String(key || "unknown").slice(0, 120)}`);
}
