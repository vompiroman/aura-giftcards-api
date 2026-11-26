import { afterEach, expect, it, vi } from "vitest";
import request from "supertest";

const { getUser, from, fetchMessages, parseMessage } = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  fetchMessages: vi.fn(),
  parseMessage: vi.fn(),
}));

vi.mock("../../src/lib/supabase", () => ({
  supabaseAuth: { auth: { getUser } },
  supabaseAdmin: { from },
}));
vi.mock("mailparser", () => ({ simpleParser: parseMessage }));
vi.mock("imapflow", () => ({
  ImapFlow: class {
    on() {}
    async connect() {}
    async getMailboxLock() { return { release() {} }; }
    async search() { return [1, 2, 3]; }
    fetch = fetchMessages;
    async logout() {}
  },
}));

import app from "../../src/app";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it("applique l’heure de réception réelle et renvoie le contenu d’un seul message", async () => {
  vi.stubEnv("IMAP_HOST", "imap.hostinger.com");
  vi.stubEnv("IMAP_ADMIN_USER", "mailbox@example.invalid");
  vi.stubEnv("IMAP_ADMIN_PASS", "mailbox-test-value");
  getUser.mockResolvedValue({ data: { user: { email: "customer@example.invalid" } }, error: null });
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    single: vi.fn(async () => ({
      data: { assigned_email: "customer@example.invalid", status: "active", payment_status: "paid" },
      error: null,
    })),
    ilike: vi.fn(async () => ({
      data: [{ service: "Netflix", account_email: "fixture@aura-stream.com" }],
      error: null,
    })),
  };
  from.mockReturnValue(query);
  const now = Date.now();
  const envelope = { from: [{ address: "info@netflix.com" }], date: new Date(now) };
  fetchMessages.mockImplementation(async function* () {
    yield { uid: 1, internalDate: new Date(now - 16 * 60_000), envelope, source: Buffer.from("old") };
    yield { uid: 2, internalDate: new Date(now - 2 * 60_000), envelope, source: Buffer.from("code") };
    yield { uid: 3, internalDate: new Date(now - 60_000), envelope, source: Buffer.from("link") };
  });
  parseMessage.mockImplementation(async (source: Buffer) => ({
    to: { value: [{ address: "fixture@aura-stream.com" }] },
    subject: "Connexion Netflix",
    text: String(source) === "link" ? "https://www.netflix.com/verify/EMAIL_test" : "Code 1234",
    headers: new Map([["authentication-results", "mx.example.invalid; dkim=pass header.d=netflix.com"]]),
  }));

  const response = await request(app)
    .post("/api/get-netflix-otp")
    .set("Authorization", "Bearer test-session")
    .send({ order_id: "ORD-netflix-fixture" });

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ success: true, code: null, link: "https://www.netflix.com/verify/EMAIL_test" });
  expect(fetchMessages.mock.calls[0][1]).toMatchObject({ internalDate: true });
  expect(parseMessage.mock.calls.map(([source]) => String(source))).toEqual(["code", "link"]);
});
