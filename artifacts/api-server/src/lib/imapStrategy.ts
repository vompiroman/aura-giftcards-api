import { decryptInventorySecret } from "./inventoryCredentials";

export interface InventoryMailboxAccount {
  account_email: string;
  account_password?: string;
  imap_host?: string;
  imap_port?: number;
  imap_user?: string;
  imap_password?: string;
}

export interface ImapStrategy {
  host: string;
  port: number;
  user: string;
  pass: string;
}

export function resolveImapStrategy(acc: InventoryMailboxAccount): ImapStrategy {
  const email = acc.account_email;
  const domain = email.toLowerCase().split("@")[1] || "";
  const configuredHost = String(acc.imap_host || "").trim().toLowerCase();
  const globalHost = String(process.env.IMAP_HOST || process.env.IMAP_ADMIN_HOST || "")
    .trim()
    .toLowerCase();
  const configuredPort = Number(process.env.IMAP_PORT || process.env.IMAP_ADMIN_PORT || 993);
  const globalPort = Number.isInteger(configuredPort) && configuredPort === 993 ? configuredPort : 993;
  const isAuraHostingerMailbox = domain === "aura-stream.com"
    && (!configuredHost || configuredHost === "imap.hostinger.com" || configuredHost === globalHost);
  const rowImapPassword = decryptInventorySecret(acc.imap_password);
  const sharedUser = String(process.env.IMAP_ADMIN_USER || "").trim();
  const sharedPassword = process.env.IMAP_ADMIN_PASS || process.env.DEFAULT_IMAP_PASSWORD || "";

  // Les adresses aurastreamXX sont des sous-boîtes/alias livrés dans la boîte
  // centrale Hostinger. Elles servent à filtrer le destinataire du code OTP,
  // mais ne sont pas nécessairement des identifiants IMAP autonomes. Quand la
  // boîte centrale Render est configurée, elle doit donc être utilisée pour
  // toutes les lignes de stock. Un secret propre à une vraie boîte reste pris
  // en charge pour assurer la compatibilité avec d'anciens comptes.
  const useSharedAuraMailbox = isAuraHostingerMailbox && Boolean(sharedUser && sharedPassword) && !rowImapPassword;
  const user = useSharedAuraMailbox ? sharedUser : (acc.imap_user || email);
  const pass = rowImapPassword
    || (useSharedAuraMailbox ? sharedPassword : "")
    || decryptInventorySecret(acc.account_password)
    || (isAuraHostingerMailbox ? sharedPassword : "")
    || "";

  if (isAuraHostingerMailbox) {
    return { host: globalHost || "imap.hostinger.com", port: globalPort, user, pass };
  }
  if (acc.imap_host) {
    return { host: acc.imap_host, port: acc.imap_port || 993, user, pass };
  }
  if (domain === "gmail.com" || domain === "googlemail.com") {
    return { host: "imap.gmail.com", port: 993, user, pass };
  }
  if (domain.startsWith("yahoo.")) return { host: "imap.mail.yahoo.com", port: 993, user, pass };

  const microsoft = ["outlook.fr", "outlook.com", "hotmail.fr", "hotmail.com", "hotmail.co.uk", "live.fr", "live.com", "msn.com"];
  if (microsoft.includes(domain)) return { host: "outlook.office365.com", port: 993, user, pass };
  return { host: "", port: 993, user, pass };
}

export function isAllowedImapTarget(host: string, _email: string, port: number): boolean {
  const normalizedHost = String(host || "").trim().toLowerCase().replace(/\.$/, "");
  const allowed = new Set([
    "imap.hostinger.com",
    "imap.gmail.com",
    "imap.mail.yahoo.com",
    "outlook.office365.com",
    "imap-mail.outlook.com",
    ...(process.env.ALLOWED_IMAP_HOSTS || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  ]);
  return port === 993 && allowed.has(normalizedHost) && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalizedHost);
}
