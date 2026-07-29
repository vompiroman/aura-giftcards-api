import { describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../../src/lib/supabase", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  supabaseAdmin: { from: vi.fn(), rpc: vi.fn() },
  supabaseAuth: {
    auth: {
      getUser: vi.fn(),
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
    },
  },
}));

import app from "../../src/app";

describe("CORS production", () => {
  it.each([
    "https://aura-stream.com",
    "https://www.aura-stream.com",
    "https://aura-stream-deploy.vercel.app",
    "https://aura-stream-deploy-lm5lvwhsl-vompiromans-projects.vercel.app",
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

  it.each([
    "https://example.invalid",
    "https://another-project-vompiromans-projects.vercel.app",
  ])("ne renvoie pas d'autorisation CORS à une origine inconnue (%s)", async (origin) => {
    const response = await request(app)
      .options("/api/login")
      .set("Origin", origin)
      .set("Access-Control-Request-Method", "POST");

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
