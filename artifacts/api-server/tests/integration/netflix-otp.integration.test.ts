import { afterEach, expect, it, vi } from "vitest";
import request from "supertest";

const { getUser, from, rpc, fetchMessages, parseMessage, verifyDkim } = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  fetchMessages: vi.fn(),
  parseMessage: vi.fn(),
  rpc: vi.fn(),
  verifyDkim: vi.fn(),
}));

vi.mock("../../src/lib/supabase", () => ({
  supabaseAuth: { auth: { getUser } },
  supabaseAdmin: { from, rpc },
}));
vi.mock("mailparser", () => ({ simpleParser: parseMessage }));
vi.mock("mailauth/lib/dkim/verify.js", () => ({ dkimVerify: verifyDkim }));
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
  getUser.mockResolvedValue({ data: { user: { id: "customer-id", email: "new-address@example.invalid" } }, error: null });
  const requestId = "550e8400-e29b-41d4-a716-446655440000";
  const now = Date.now();
  const expiresAt = new Date(now + 30_000).toISOString();
  const startedAt = new Date(now - 150_000).toISOString();
  const attempt = {
    select: vi.fn(() => attempt),
    eq: vi.fn(() => attempt),
    gt: vi.fn(() => attempt),
    maybeSingle: vi.fn(async () => ({ data: { started_at: startedAt }, error: null })),
  };
  rpc.mockResolvedValueOnce({ data: { request_id: requestId, expires_at: expiresAt }, error: null })
    .mockResolvedValueOnce({ data: true, error: null });
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    single: vi.fn(async () => ({
      data: { customer_user_id: "customer-id", status: "active", payment_status: "paid" },
      error: null,
    })),
    ilike: vi.fn(async () => ({
      data: [{ id: "netflix-fixture", service: "Netflix", account_email: "fixture@aura-stream.com" }],
      error: null,
    })),
  };
  from.mockImplementation(table => table === "netflix_login_requests" ? attempt : query);
  verifyDkim.mockResolvedValue({
    fromFields: 1, headerFrom: ["info@netflix.com"], headers: { parsed: [{ key: "to" }, { key: "subject" }] },
    results: [{
      signingDomain: "netflix.com", status: { result: "pass" },
      signingHeaders: { headers: ["From: info@netflix.com", "To: fixture@aura-stream.com", "Subject: Connexion Netflix"] },
    }],
  });
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
  }));

  const prepared = await request(app).post("/api/get-netflix-otp")
    .set("Authorization", "Bearer test-session").send({ order_id: "ORD-netflix-fixture" }).expect(202);
  expect(prepared.body).toEqual({ request_id: requestId, expires_at: expiresAt });
  expect(fetchMessages).not.toHaveBeenCalled();
  const response = await request(app)
    .post("/api/get-netflix-otp")
    .set("Authorization", "Bearer test-session")
    .send({ order_id: "ORD-netflix-fixture", login_request_id: requestId });

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ success: true, code: null, link: "https://www.netflix.com/verify/EMAIL_test" });
  expect(fetchMessages.mock.calls[0][1]).toMatchObject({ internalDate: true });
  expect(parseMessage.mock.calls.map(([source]) => String(source))).toEqual(["code", "link"]);
  expect(rpc).toHaveBeenLastCalledWith("finish_netflix_login_request", { p_request_id: requestId, p_user: "customer-id" });
});
