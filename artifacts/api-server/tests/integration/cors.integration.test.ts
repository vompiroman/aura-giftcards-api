import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../../src/app";

describe("CORS production", () => {
  it.each([
    "https://aura-stream.com",
    "https://www.aura-stream.com",
    "https://aura-stream-deploy.vercel.app",
  ])("autorise le frontend %s", async (origin) => {
    const response = await request(app)
      .options("/api/login")
      .set("Origin", origin)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type");

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(origin);
    expect(response.headers["access-control-allow-methods"]).toContain("POST");
  });

  it("ne renvoie pas d'autorisation CORS à une origine inconnue", async () => {
    const response = await request(app)
      .options("/api/login")
      .set("Origin", "https://example.invalid")
      .set("Access-Control-Request-Method", "POST");

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
