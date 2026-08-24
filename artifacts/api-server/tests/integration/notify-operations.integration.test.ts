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
    process.env.DISCORD_WEBHOOK_URL = "https://discord.example/operations";
    process.env.DISCORD_ADMIN_WEBHOOK_URL = "https://discord.example/admin";
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
      "https://discord.example/operations",
      expect.objectContaining({ method: "POST" }),
    );
    const payload = JSON.stringify(fetchMock.mock.calls[0][1]);
    expect(payload).toContain("secret@example.com");
    expect(payload).toContain("||temporary-password||");
    expect(payload).toContain("+213555000000");
  });

  it("ne bascule pas sur le webhook admin si le canal opérationnel manque", async () => {
    process.env.DISCORD_ADMIN_WEBHOOK_URL = "https://discord.example/admin";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(notifyOperations("test")).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
