import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createSessionRefresher } from "../../src/lib/sessionRefresh";

describe("renouvellement avec le SDK Supabase réel", () => {
  it("isole deux clients simultanés et partage uniquement les requêtes du même token", async () => {
    const requests: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const refresh = createSessionRefresher(() => createClient("https://auth.example.com", "test-publishable-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: async (_url, options) => {
        const token = JSON.parse(String(options?.body)).refresh_token;
        requests.push(token);
        await gate;
        const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
        const jwt = `${encode({ alg: "HS256" })}.${encode({ sub: token, exp: 1_900_000_000 })}.signature`;
        return new Response(JSON.stringify({ access_token: jwt, refresh_token: `new-${token}`,
          expires_in: 3600, token_type: "bearer", user: { id: token, email: `${token}@example.com` } }),
        { status: 200, headers: { "Content-Type": "application/json" } });
      } },
    }));
    const first = refresh("customer-one");
    const duplicate = refresh("customer-one");
    const second = refresh("customer-two");
    expect(duplicate).toBe(first);
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(one.data.user?.id).toBe("customer-one");
    expect(two.data.user?.id).toBe("customer-two");
    expect(requests.sort()).toEqual(["customer-one", "customer-two"]);
    await refresh("customer-one");
    expect(requests).toHaveLength(3);
  });
});
