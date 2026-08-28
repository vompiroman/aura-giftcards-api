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
  const isAuraHostingerMailbox = domain === "aura-stream.com"
    && (!configuredHost || configuredHost === "imap.hostinger.com");
  const user = acc.imap_user
    || (isAuraHostingerMailbox ? process.env.IMAP_ADMIN_USER : "")
    || email;
  const pass = decryptInventorySecret(acc.imap_password)
    || (isAuraHostingerMailbox ? (process.env.IMAP_ADMIN_PASS || process.env.DEFAULT_IMAP_PASSWORD) : "")
    || decryptInventorySecret(acc.account_password)
    || "";

  if (acc.imap_host) {
    return { host: acc.imap_host, port: acc.imap_port || 993, user, pass };
  }
  if (domain === "aura-stream.com") return { host: "imap.hostinger.com", port: 993, user, pass };
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
