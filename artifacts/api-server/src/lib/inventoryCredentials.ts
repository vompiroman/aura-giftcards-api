import crypto from "node:crypto";

const PREFIX = "enc:v1:";

function credentialKey(): Buffer {
  const configured = process.env.INVENTORY_CREDENTIALS_KEY || process.env.CLIENT_CREDENTIALS_KEY || "";
  if (configured.length < 32) {
    throw new Error("INVENTORY_CREDENTIALS_KEY (or CLIENT_CREDENTIALS_KEY) must contain at least 32 characters.");
  }
  return crypto.createHash("sha256").update(`aura-inventory:${configured}`, "utf8").digest();
}

export function encryptInventorySecret(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error("Inventory credentials must be strings.");
  if (value.startsWith(PREFIX)) return value;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", credentialKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${PREFIX}${JSON.stringify({
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  })}`;
}

export function decryptInventorySecret(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return null;
  if (!value.startsWith(PREFIX)) return value; // Backward-compatible read for rows awaiting migration.

  try {
    const payload = JSON.parse(value.slice(PREFIX.length)) as { iv?: string; tag?: string; ciphertext?: string };
    if (!payload.iv || !payload.tag || !payload.ciphertext) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", credentialKey(), Buffer.from(payload.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(payload.tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

