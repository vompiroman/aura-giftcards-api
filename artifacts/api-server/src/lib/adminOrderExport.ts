const CSV_FORMULA_PREFIX = /^[\s]*[=+\-@]/;

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");
  if (CSV_FORMULA_PREFIX.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function addUtcMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function monthsFromItemName(name: unknown): number | null {
  const match = /(\d+)\s*(mois|months?|ans?|years?)/i.exec(String(name || ""));
  if (!match) return null;
  const amount = Number.parseInt(match[1], 10);
  if (!Number.isFinite(amount) || amount < 1 || amount > 120) return null;
  return /^(an|year)/i.test(match[2]) ? amount * 12 : amount;
}

function itemService(name: unknown): string {
  const normalized = String(name || "").toLowerCase();
  if (normalized.includes("netflix")) return "Netflix";
  if (normalized.includes("spotify")) return "Spotify";
  if (normalized.includes("crunchyroll")) return "Crunchyroll";
  return "Autre";
}

function itemExpiry(order: Record<string, any>, item: Record<string, any>): Date | null {
  const storedExpiry = new Date(order.expires_at || "");
  if (Number.isFinite(storedExpiry.getTime())) return storedExpiry;

  const activation = new Date(order.activated_at || order.created_at || "");
  const months = monthsFromItemName(item.name);
  if (months && Number.isFinite(activation.getTime())) return addUtcMonths(activation, months);
  return null;
}

export function subscriptionFollowUp(
  order: Record<string, any>,
  item: Record<string, any>,
  now = new Date(),
): { label: string; action: string; expiresAt: string } {
  if (order.payment_status !== "paid") {
    return {
      label: "Paiement non confirmé",
      action: "Ne pas activer et ne pas transmettre d’accès",
      expiresAt: "",
    };
  }
  if (order.status === "cancelled") {
    return { label: "Annulé", action: "Aucune action", expiresAt: "" };
  }
  if (order.status === "completed") {
    return { label: "Déconnecté / clôturé", action: "Aucune action", expiresAt: "" };
  }
  if (order.status === "pending") {
    return { label: "Activation en attente", action: "Vérifier le stock ou finaliser l’activation", expiresAt: "" };
  }

  const expiresAt = itemExpiry(order, item);
  if (!expiresAt) {
    return { label: "Date à vérifier", action: "Contrôler manuellement la date d’expiration", expiresAt: "" };
  }
  const remainingMs = expiresAt.getTime() - now.getTime();
  const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
  if (remainingMs <= 0) {
    return {
      label: "À déconnecter",
      action: "Retirer l’accès puis marquer la commande comme terminée",
      expiresAt: expiresAt.toISOString(),
    };
  }
  if (remainingMs <= threeDaysMs) {
    return {
      label: "Expire dans 3 jours ou moins",
      action: "Proposer le renouvellement au client",
      expiresAt: expiresAt.toISOString(),
    };
  }
  return { label: "Actif", action: "Aucune action", expiresAt: expiresAt.toISOString() };
}

export function buildAdminOrdersCsv(orders: Array<Record<string, any>>, now = new Date()): string {
  const headers = [
    "Commande",
    "Client",
    "WhatsApp",
    "Service",
    "Offre",
    "Quantité",
    "Montant commande (DA)",
    "Paiement",
    "Statut commande",
    "Date commande",
    "Date activation",
    "Date expiration abonnement",
    "Suivi",
    "Action recommandée",
  ];
  const rows: string[][] = [headers];

  for (const order of orders) {
    const items = Array.isArray(order.items) && order.items.length ? order.items : [{ name: "Abonnement" }];
    for (const item of items) {
      const followUp = subscriptionFollowUp(order, item, now);
      const credentials = item?.client_credentials && typeof item.client_credentials === "object"
        ? item.client_credentials
        : {};
      rows.push([
        order.order_id,
        order.assigned_email,
        credentials.whatsapp || "",
        itemService(item.name),
        item.name || "Abonnement",
        Number(item.quantity || 1),
        Number(order.amount || 0),
        order.payment_status || "unpaid",
        order.status || "pending",
        order.created_at || "",
        order.activated_at || "",
        followUp.expiresAt,
        followUp.label,
        followUp.action,
      ].map((value) => String(value ?? "")));
    }
  }

  return rows.map((row) => row.map(csvCell).join(";")).join("\r\n");
}
