import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyAdmin } from "../../src/lib/notifyAdmin";

describe("configuration Discord admin", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.DISCORD_ADMIN_WEBHOOK_URL;
    delete process.env.DISCORD_WEBHOOK_URL;
  });

  afterEach(() => {
    delete process.env.DISCORD_ADMIN_WEBHOOK_URL;
    delete process.env.DISCORD_WEBHOOK_URL;
  });

  it("n'utilise pas l'ancienne variable DISCORD_WEBHOOK_URL", async () => {
    process.env.DISCORD_WEBHOOK_URL = "https://discord.example/legacy";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(notifyAdmin("test", { dedupeKey: "legacy-env-test" })).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("envoie via DISCORD_ADMIN_WEBHOOK_URL", async () => {
    process.env.DISCORD_ADMIN_WEBHOOK_URL = "https://discord.com/api/webhooks/123456789012345678/admin-test-token";
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(notifyAdmin("test", { dedupeKey: "admin-env-test" })).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/webhooks/123456789012345678/admin-test-token",
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
  });

  it("refuse une destination externe avant toute transmission", async () => {
    process.env.DISCORD_ADMIN_WEBHOOK_URL = "https://example.com/api/webhooks/123456789012345678/admin-test-token";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(notifyAdmin("test", { dedupeKey: "external-test" })).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ne journalise jamais un lien secret inclus dans une erreur réseau", async () => {
    const secretUrl = "https://discord.com/api/webhooks/123456789012345678/admin-test-token";
    process.env.DISCORD_ADMIN_WEBHOOK_URL = secretUrl;
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error(`Network failure: ${secretUrl}`)));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(notifyAdmin("test", { dedupeKey: "secret-log-test" })).resolves.toBe(false);
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain(secretUrl);
    expect(JSON.stringify(log.mock.calls)).not.toContain("admin-test-token");
  });
});
