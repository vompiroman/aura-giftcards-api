import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { webSessionSecret } from "./webSession";

export const PASSWORD_RECOVERY_LIFETIME_MINUTES = 15;
const lifetimeMs = PASSWORD_RECOVERY_LIFETIME_MINUTES * 60_000;
const tokenVersion = "v1.";
const nonceBytes = 12;
const tagBytes = 16;
const validHash = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{20,512}$/.test(value);

function recoveryKey() {
  const secret = webSessionSecret();
  if (secret.length < 32) throw new Error("RECOVERY_ENCRYPTION_UNAVAILABLE");
  return createHash("sha256").update(`aura-password-recovery-v1:${secret}`).digest();
}

export function issuePasswordRecoveryToken(hash: unknown, requestedAt: number): string | null {
  if (!validHash(hash)) return null;
  const nonce = randomBytes(nonceBytes);
  const cipher = createCipheriv("aes-256-gcm", recoveryKey(), nonce);
  const cleartext = JSON.stringify({ hash, expiresAt: requestedAt + lifetimeMs });
  const encrypted = Buffer.concat([cipher.update(cleartext, "utf8"), cipher.final()]);
  return tokenVersion + Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url");
}

export function readPasswordRecoveryContext(token: unknown, now = Date.now()) {
  if (typeof token !== "string" || !/^v1\.[A-Za-z0-9_-]{40,800}$/.test(token)) return null;
  const key = recoveryKey();
  try {
    const encoded = token.slice(tokenVersion.length);
    const data = Buffer.from(encoded, "base64url");
    if (data.toString("base64url") !== encoded) return null;
    const nonce = data.subarray(0, nonceBytes);
    const tag = data.subarray(nonceBytes, nonceBytes + tagBytes);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    const cleartext = Buffer.concat([decipher.update(data.subarray(nonceBytes + tagBytes)), decipher.final()]);
    const { hash, expiresAt } = JSON.parse(cleartext.toString("utf8"));
    return validHash(hash) && Number.isSafeInteger(expiresAt) && now < expiresAt
      ? { hash, expiresAt: Number(expiresAt), id: createHash("sha256").update(token).digest("base64url") }
      : null;
  } catch {
    return null;
  }
}

export function readPasswordRecoveryToken(token: unknown, now = Date.now()): string | null {
  return readPasswordRecoveryContext(token, now)?.hash ?? null;
}
