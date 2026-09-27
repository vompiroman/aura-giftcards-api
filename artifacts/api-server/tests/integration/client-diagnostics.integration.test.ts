import { describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../../src/lib/supabase", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  supabaseAdmin: { from: vi.fn(), rpc: vi.fn() },
  supabaseAuth: { auth: { getUser: vi.fn(), signInWithPassword: vi.fn(), signUp: vi.fn() } },
}));

import app from "../../src/app";

describe("POST /api/client-errors", () => {
  it("accepte un diagnostic frontend minimal sans exposer de données sensibles", async () => {
    const response = await request(app)
      .post("/api/client-errors")
      .set("Origin", "https://www.aura-stream.com")
      .send({
        event: "checkout",
        message: "Erreur pour client@example.com?token=secret",
        route: "/spotify-family-algerie?campaign=secret",
        source: "payment#private",
        line: 42,
        column: 7,
        ignored: "field",
      });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ accepted: true });
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});
