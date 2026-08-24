import { afterEach, describe, expect, it } from "vitest";
import {
  adminOrderItems,
  customerWhatsappFromItems,
  manualActivationReady,
  setClientCredentials,
} from "../../src/lib/orderItems";

const originalClientCredentialsKey = process.env.CLIENT_CREDENTIALS_KEY;
const originalServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const originalLegacySupabaseKey = process.env.SUPABASE_KEY;

describe("chiffrement des identifiants client", () => {
  afterEach(() => {
    if (originalClientCredentialsKey === undefined) {
      delete process.env.CLIENT_CREDENTIALS_KEY;
    } else {
      process.env.CLIENT_CREDENTIALS_KEY = originalClientCredentialsKey;
    }
    if (originalServiceRoleKey === undefined) {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    } else {
      process.env.SUPABASE_SERVICE_ROLE_KEY = originalServiceRoleKey;
    }
    if (originalLegacySupabaseKey === undefined) {
      delete process.env.SUPABASE_KEY;
    } else {
      process.env.SUPABASE_KEY = originalLegacySupabaseKey;
    }
  });

  it("refuse les clés Supabase comme clé de chiffrement implicite", () => {
    delete process.env.CLIENT_CREDENTIALS_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-that-is-long-enough-to-use";
    process.env.SUPABASE_KEY = "legacy-supabase-key-that-is-long-enough-to-use";

    expect(() => setClientCredentials(
      [{ name: "Spotify 1 mois" }],
      "spotify",
      { email: "client@example.com", password: "secret", whatsapp: "0555000000" },
    )).toThrow("CLIENT_CREDENTIALS_KEY must contain at least 32 characters.");
  });

  it("chiffre et déchiffre avec la clé dédiée", () => {
    process.env.CLIENT_CREDENTIALS_KEY = "dedicated-client-credentials-key-32-chars";
    const items = setClientCredentials(
      [{ name: "Crunchyroll 1 mois" }],
      "crunchyroll",
      { email: "client@example.com", password: "secret", whatsapp: "0555000000" },
    );

    expect(items[0].client_credentials).toBeUndefined();
    expect(items[0].client_credentials_encrypted).toBeDefined();
    expect(adminOrderItems(items)[0].client_credentials).toEqual({
      email: "client@example.com",
      password: "secret",
      whatsapp: "0555000000",
    });
    expect(customerWhatsappFromItems(items)).toBe("0555000000");
    expect(manualActivationReady(items)).toBe(true);
  });

  it("ne considère pas une activation manuelle prête sans identifiants", () => {
    expect(manualActivationReady([{ name: "Spotify Family 1 an" }])).toBe(false);
    expect(manualActivationReady([{ name: "Netflix Premium 1 mois" }])).toBe(true);
  });
});
