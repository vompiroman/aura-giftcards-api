import { describe, expect, it } from "vitest";
import { discordWebhookUrl } from "../../src/lib/discordWebhook";

const valid = "https://discord.com/api/v10/webhooks/123456789012345678/unit-test-token";

describe("Discord destination validation", () => {
  it("preserves official webhook destinations and confirms delivery", () => {
    expect(discordWebhookUrl(valid, true)).toBe(`${valid}?wait=true`);
    expect(discordWebhookUrl(`${valid}?thread_id=123456789012345679`, true)).toBe(`${valid}?thread_id=123456789012345679&wait=true`);
  });

  it.each([
    undefined, "invalid", valid.replace("https:", "http:"),
    valid.replace("discord.com", "discord.com.attacker.example"),
    valid.replace("discord.com", "localhost"),
    valid.replace("discord.com", "user:password@discord.com"),
    `${valid}?redirect=https://attacker.example`, `${valid}#fragment`,
    `${valid}?thread_id=invalid`, valid.replace("/api/v10/", "/api/users/"),
  ])("rejects unsafe destination %s", value => {
    expect(discordWebhookUrl(value)).toBeNull();
  });
});
