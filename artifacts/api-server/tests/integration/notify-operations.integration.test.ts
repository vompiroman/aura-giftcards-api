import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyOperations } from "../../src/lib/notifyOperations";

describe("webhook Discord opérationnel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.DISCORD_WEBHOOK_URL;
    delete process.env.DISCORD_ADMIN_WEBHOOK_URL;
  });

  afterEach(() => {
    delete process.env.DISCORD_WEBHOOK_URL;
    delete process.env.DISCORD_ADMIN_WEBHOOK_URL;
  });

  it("transmet les identifiants temporaires au canal opérationnel privé", async () => {
    process.env.DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/123456789012345678/operations-test-token";
    process.env.DISCORD_ADMIN_WEBHOOK_URL = "https://discord.com/api/webhooks/123456789012345679/admin-test-token";
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(notifyOperations(
      "Nouveau compte spotify à activer. Ouvre le panneau sécurisé.",
      {
        orderId: "ORD-123456",
        service: "spotify",
        credentials: {
          email: "secret@example.com",
          password: "temporary-password",
          whatsapp: "+213555000000",
        },
      },
    )).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/webhooks/123456789012345678/operations-test-token?wait=true",
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
    const payload = JSON.stringify(fetchMock.mock.calls[0][1]);
    expect(payload).toContain("secret@example.com");
    expect(payload).toContain("||temporary-password||");
    expect(payload).toContain("+213555000000");
  });

  it("retente les erreurs Discord transitoires", async () => {
    process.env.DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/123456789012345678/operations-test-token";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await expect(notifyOperations("test")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ne transmet aucun identifiant à un domaine externe", async () => {
    process.env.DISCORD_WEBHOOK_URL = "https://discord.com.attacker.example/api/webhooks/123456789012345678/operations-test-token";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(notifyOperations("test", { credentials: {
      email: "private@example.com", password: "private-password", whatsapp: "+213555000000",
    } })).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ne bascule pas sur le webhook admin si le canal opérationnel manque", async () => {
    process.env.DISCORD_ADMIN_WEBHOOK_URL = "https://discord.example/admin";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(notifyOperations("test")).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
