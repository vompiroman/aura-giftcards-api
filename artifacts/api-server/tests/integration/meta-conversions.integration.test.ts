import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import { sendMetaPurchase } from "../../src/lib/metaConversions";

describe("Meta Conversions API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.META_CAPI_ACCESS_TOKEN;
    delete process.env.META_TEST_EVENT_CODE;
  });

  it("ne contacte pas Meta sans jeton serveur", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const sent = await sendMetaPurchase({
      orderId: "ORD-123456",
      amount: 800,
      email: "client@example.com",
      items: [],
    });
    expect(sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("envoie un Purchase dédupliqué et une adresse email hachée", async () => {
    process.env.META_CAPI_ACCESS_TOKEN = "test-token";
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const sent = await sendMetaPurchase({
      orderId: "ORD-123456",
      amount: 800,
      email: " Client@Example.com ",
      items: [{ name: "Spotify 1 mois", quantity: 1 }],
    });

    expect(sent).toBe(true);
    const request = fetchMock.mock.calls[0];
    const payload = JSON.parse(String(request[1]?.body));
    expect(payload.data[0].event_id).toBe("purchase_ORD-123456");
    expect(payload.data[0].custom_data.currency).toBe("DZD");
    expect(payload.data[0].user_data.em[0]).toBe(
      crypto.createHash("sha256").update("client@example.com").digest("hex"),
    );
    expect(JSON.stringify(payload)).not.toContain("Client@Example.com");
  });
});
