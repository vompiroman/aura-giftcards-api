import { describe, expect, it } from "vitest";
import { normalizeSnapchatUsername } from "../../src/lib/snapchat";
import { manualActivationReady, publicOrderItems } from "../../src/lib/orderItems";
import { durationMonthsFromItems } from "../../src/lib/payments";
import { promoSupportsItems } from "../../src/lib/promos";
describe("Snapchat fulfillment", () => {
  it("normalizes @ and rejects display names, links and invalid lengths", () => {
    expect(normalizeSnapchatUsername(" @Aura-stream ")).toBe("aura-stream");
    for (const value of [null, "ab", "x".repeat(16), "a name", "123name", "name-", "https://snapchat.com/x", "<script>"]) expect(normalizeSnapchatUsername(value)).toBeNull();
  });
  it("requires username and friend confirmation before activation", () => {
    const item={name: "Snapchat+ 3 mois", snapchat_username: "client.snap"};
    expect(manualActivationReady([item])).toBe(false);
    expect(manualActivationReady([{...item,snapchat_friend_added:true}])).toBe(true);
    expect(publicOrderItems([item])[0].snapchat_username).toBe("client.snap");
  });
  it("recognizes both durations and targeted promos", () => {
    expect(durationMonthsFromItems([{name:"Snapchat+ 3 mois"}])).toBe(3);
    expect(durationMonthsFromItems([{name:"Snapchat+ 6 mois"}])).toBe(6);
    expect(promoSupportsItems({discount_type:"percentage",discount_value:10,services:["snapchat"]},[{name:"Snapchat+ 6 mois"}])).toBe(true);
  });
});
