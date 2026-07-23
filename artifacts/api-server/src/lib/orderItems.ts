import crypto from "crypto";

export interface ClientCredentials {
  email: string;
  password: string;
  whatsapp: string;
}

interface EncryptedValue {
  v: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

function credentialKey(): Buffer {
  const configured = process.env.CLIENT_CREDENTIALS_KEY
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || process.env.SUPABASE_KEY
    || "";
  if (configured.length < 32) {
    throw new Error("CLIENT_CREDENTIALS_KEY must contain at least 32 characters.");
  }
  return crypto.createHash("sha256").update(configured, "utf8").digest();
}

function encryptCredentials(value: ClientCredentials): EncryptedValue {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", credentialKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return {
    v: 1,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function decryptCredentials(value: unknown): ClientCredentials | null {
  if (!value || typeof value !== "object") return null;
  const encrypted = value as Partial<EncryptedValue>;
  if (
    encrypted.v !== 1 ||
    typeof encrypted.iv !== "string" ||
    typeof encrypted.tag !== "string" ||
    typeof encrypted.ciphertext !== "string"
  ) return null;

  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      credentialKey(),
      Buffer.from(encrypted.iv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(encrypted.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext);
    if (
      typeof parsed?.email !== "string" ||
      typeof parsed?.password !== "string" ||
      typeof parsed?.whatsapp !== "string"
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function parseOrderItems(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function setClientCredentials(
  itemsValue: unknown,
  service: string,
  credentials: ClientCredentials,
): any[] {
  const encrypted = encryptCredentials(credentials);
  return parseOrderItems(itemsValue).map((item) => {
    if (typeof item?.name === "string" && item.name.toLowerCase().includes(service)) {
      const { client_credentials: _legacy, client_credentials_encrypted: _old, ...safeItem } = item;
      return {
        ...safeItem,
        client_credentials_encrypted: encrypted,
        client_credentials_submitted: true,
      };
    }
    return item;
  });
}

export function publicOrderItems(itemsValue: unknown): any[] {
  return parseOrderItems(itemsValue).map((item) => {
    if (!item || typeof item !== "object") return item;
    const {
      client_credentials: legacy,
      client_credentials_encrypted: encrypted,
      ...safeItem
    } = item;
    return {
      ...safeItem,
      client_credentials_submitted: Boolean(
        safeItem.client_credentials_submitted || legacy || encrypted,
      ),
    };
  });
}

export function adminOrderItems(itemsValue: unknown): any[] {
  return parseOrderItems(itemsValue).map((item) => {
    if (!item || typeof item !== "object") return item;
    const {
      client_credentials: legacy,
      client_credentials_encrypted: encrypted,
      ...safeItem
    } = item;
    const credentials = decryptCredentials(encrypted) || (
      legacy && typeof legacy === "object" ? legacy as ClientCredentials : null
    );
    return {
      ...safeItem,
      client_credentials_submitted: Boolean(credentials),
      client_credentials: credentials || undefined,
    };
  });
}

export function orderItemSummary(itemsValue: unknown): string {
  return publicOrderItems(itemsValue)
    .map((item) => {
      const name = String(item?.name || "Article").replace(/[\r\n`*_~|<>@]/g, " ").slice(0, 120);
      const quantity = Number.isInteger(Number(item?.quantity))
        ? Math.max(1, Math.min(100, Number(item.quantity)))
        : 1;
      return `${name} x${quantity}`;
    })
    .join(", ")
    .slice(0, 900);
}
