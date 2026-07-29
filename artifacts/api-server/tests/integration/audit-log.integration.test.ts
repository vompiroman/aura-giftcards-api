import { describe, expect, it, vi } from "vitest";

const { insertMock, fromMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  fromMock: vi.fn(),
}));

vi.mock("../../src/lib/supabase", () => ({
  supabaseAdmin: { from: fromMock },
}));

import { appendAuditLog } from "../../src/lib/auditLog";

describe("audit logs", () => {
  it("exclut les secrets et credentials", async () => {
    insertMock.mockResolvedValue({ error: null });
    fromMock.mockReturnValue({ insert: insertMock });
    await appendAuditLog({
      action: "admin_inventory_update",
      actorUserId: "00000000-0000-0000-0000-000000000001",
      details: {
        service: "spotify",
        password: "do-not-store",
        client_credentials: { email: "secret@example.com", password: "secret" },
        token: "bearer-secret",
      },
    });
    const payload = insertMock.mock.calls[0][0];
    expect(JSON.stringify(payload)).not.toContain("do-not-store");
    expect(JSON.stringify(payload)).not.toContain("secret@example.com");
    expect(JSON.stringify(payload)).not.toContain("bearer-secret");
    expect(payload.details.service).toBe("spotify");
  });
});
