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
    process.env.DISCORD_ADMIN_WEBHOOK_URL = "https://discord.example/admin";
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(notifyAdmin("test", { dedupeKey: "admin-env-test" })).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://discord.example/admin",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
