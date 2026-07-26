import { describe, expect, it, vi } from "vitest";
import request from "supertest";

const { fromMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
}));

vi.mock("../../src/lib/supabase", () => ({
  supabase: { from: fromMock },
  supabaseAdmin: { from: fromMock },
  supabaseAuth: { auth: { getUser: vi.fn() } },
}));

import app from "../../src/app";

describe("routes retirées", () => {
  it("ne publie plus l'ancien inventaire de cartes cadeaux", async () => {
    const res = await request(app).get("/api/gift-cards");

    expect(res.status).toBe(404);
    expect(fromMock).not.toHaveBeenCalled();
  });
});
