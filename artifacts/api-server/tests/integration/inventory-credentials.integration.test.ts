import { afterEach, describe, expect, it } from "vitest";
import { decryptInventorySecret, encryptInventorySecret } from "../../src/lib/inventoryCredentials";

const original = process.env.INVENTORY_CREDENTIALS_KEY;

describe("chiffrement des identifiants d'inventaire", () => {
  afterEach(() => {
    if (original === undefined) delete process.env.INVENTORY_CREDENTIALS_KEY;
    else process.env.INVENTORY_CREDENTIALS_KEY = original;
  });

  it("refuse une configuration sans clé dédiée suffisamment longue", () => {
    delete process.env.INVENTORY_CREDENTIALS_KEY;
    delete process.env.CLIENT_CREDENTIALS_KEY;
    expect(() => encryptInventorySecret("secret")).toThrow("INVENTORY_CREDENTIALS_KEY");
  });

  it("stocke un ciphertext et conserve la compatibilité des anciennes lignes", () => {
    process.env.INVENTORY_CREDENTIALS_KEY = "inventory-credentials-key-with-at-least-32-chars";
    const encrypted = encryptInventorySecret("secret-imap");
    expect(encrypted).toMatch(/^enc:v1:/);
    expect(encrypted).not.toContain("secret-imap");
    expect(decryptInventorySecret(encrypted)).toBe("secret-imap");
    expect(decryptInventorySecret("legacy-plaintext")).toBe("legacy-plaintext");
  });
});

