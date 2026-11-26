import { createHash } from "node:crypto";
import { logger } from "./logger";

export const compromisedPasswordMessage = "Ce mot de passe a été compromis. Choisis-en un autre.";

export async function isKnownCompromisedPassword(password: string): Promise<boolean> {
  const hash = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  try {
    const response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { "Add-Padding": "true", Accept: "text/plain" },
      redirect: "error",
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) throw new Error("PASSWORD_RANGE_UNAVAILABLE");
    const body = await response.text();
    return body.split("\n").some(line => {
      const [candidate, count] = line.trim().split(":");
      return candidate === suffix && Number(count) > 0;
    });
  } catch {
    // Account recovery must remain available if the range service is down.
    logger.warn("Compromised-password lookup unavailable");
    return false;
  }
}
