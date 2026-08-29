import { afterEach, describe, expect, it } from "vitest";
import { isAllowedImapTarget, resolveImapStrategy } from "../../src/lib/imapStrategy";

const originalAdminUser = process.env.IMAP_ADMIN_USER;
const originalAdminPass = process.env.IMAP_ADMIN_PASS;
const originalDefaultPass = process.env.DEFAULT_IMAP_PASSWORD;
const originalImapHost = process.env.IMAP_HOST;
const originalImapPort = process.env.IMAP_PORT;

afterEach(() => {
  if (originalAdminUser === undefined) delete process.env.IMAP_ADMIN_USER;
  else process.env.IMAP_ADMIN_USER = originalAdminUser;
  if (originalAdminPass === undefined) delete process.env.IMAP_ADMIN_PASS;
  else process.env.IMAP_ADMIN_PASS = originalAdminPass;
  if (originalDefaultPass === undefined) delete process.env.DEFAULT_IMAP_PASSWORD;
  else process.env.DEFAULT_IMAP_PASSWORD = originalDefaultPass;
  if (originalImapHost === undefined) delete process.env.IMAP_HOST;
  else process.env.IMAP_HOST = originalImapHost;
  if (originalImapPort === undefined) delete process.env.IMAP_PORT;
  else process.env.IMAP_PORT = originalImapPort;
});

describe("stratégie IMAP de l'inventaire", () => {
  it("utilise la boîte centrale Hostinger pour les alias Aura", () => {
    process.env.IMAP_ADMIN_USER = "admin@aura-stream.com";
    process.env.DEFAULT_IMAP_PASSWORD = "shared-hostinger-secret";
    process.env.IMAP_HOST = "imap.hostinger.com";
    process.env.IMAP_PORT = "993";

    expect(resolveImapStrategy({
      account_email: "netflix01@aura-stream.com",
      account_password: "netflix-password",
      imap_host: "imap.hostinger.com",
      imap_port: 993,
      imap_user: "admin@aura-stream.com",
    })).toEqual({
      host: "imap.hostinger.com",
      port: 993,
      user: "admin@aura-stream.com",
      pass: "shared-hostinger-secret",
    });
  });

  it("préfère un secret IMAP propre au compte", () => {
    process.env.IMAP_ADMIN_USER = "admin@aura-stream.com";
    process.env.DEFAULT_IMAP_PASSWORD = "shared-hostinger-secret";
    expect(resolveImapStrategy({
      account_email: "netflix02@aura-stream.com",
      account_password: "netflix-password",
      imap_user: "netflix02@aura-stream.com",
      imap_password: "per-account-secret",
    })).toMatchObject({
      user: "netflix02@aura-stream.com",
      pass: "per-account-secret",
    });
  });

  it("retombe sur l'adresse du compte lorsque la boîte centrale est absente", () => {
    delete process.env.IMAP_ADMIN_USER;
    delete process.env.IMAP_ADMIN_PASS;
    delete process.env.DEFAULT_IMAP_PASSWORD;
    expect(resolveImapStrategy({
      account_email: "netflix03@aura-stream.com",
      account_password: "legacy-mailbox-password",
    })).toMatchObject({
      user: "netflix03@aura-stream.com",
      pass: "legacy-mailbox-password",
    });
  });

  it("refuse les cibles réseau non autorisées", () => {
    expect(isAllowedImapTarget("127.0.0.1", "client@example.com", 993)).toBe(false);
    expect(isAllowedImapTarget("imap.hostinger.com", "client@example.com", 143)).toBe(false);
    expect(isAllowedImapTarget("imap.hostinger.com", "client@example.com", 993)).toBe(true);
  });
});
