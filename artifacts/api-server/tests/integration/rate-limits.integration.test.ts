import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const { signInMock, getUserMock } = vi.hoisted(() => ({
  signInMock: vi.fn(),
  getUserMock: vi.fn(),
}));

vi.mock("../../src/lib/supabase", () => ({
  supabase: { auth: { getUser: getUserMock } },
  supabaseAdmin: { auth: { getUser: getUserMock } },
  supabaseAuth: {
    auth: {
      signInWithPassword: signInMock,
      getUser: getUserMock,
    },
  },
}));

import app from "../../src/app";

describe("rate limits des routes sensibles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signInMock.mockResolvedValue({ data: { session: null, user: null }, error: { message: "Identifiants invalides" } });
  });

  it("retourne 429 après trop de tentatives de connexion sans révéler le compte", async () => {
    let last;
    for (let i = 0; i < 11; i++) {
      last = await request(app).post("/api/login").send({
        email: "client@example.com",
        password: "wrong-password",
      });
    }
    expect(last?.status).toBe(429);
    expect(last?.body).toEqual({ error: "Trop de tentatives de connexion. Réessayez dans quelques minutes." });
  });

  it("protège la soumission répétée d'identifiants", async () => {
    let last;
    for (let i = 0; i < 7; i++) {
      last = await request(app).post("/api/client-credentials").send({});
    }
    expect(last?.status).toBe(429);
    expect(last?.body).toEqual({ error: "Trop de modifications. Réessayez plus tard." });
  });
});
