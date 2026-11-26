import { generateKeyPairSync } from "node:crypto";
import { dkimSign } from "mailauth/lib/dkim/sign.js";
import { expect, it, vi } from "vitest";

const { resolveTxt } = vi.hoisted(() => ({ resolveTxt: vi.fn() }));
vi.mock("node:dns/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:dns/promises")>(),
  Resolver: class { resolveTxt = resolveTxt; },
}));

import { isAuthenticNetflix } from "../../src/lib/netflixValidation";

it("vérifie une signature DKIM réelle avec une clé éphémère et une réponse DNS locale", async () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  resolveTxt.mockImplementation(async host => {
    expect(host).toBe("integration-fixture._domainkey.netflix.com");
    return [[`v=DKIM1; k=rsa; p=${publicKey}`]];
  });
  const source = Buffer.from([
    "From: Fixture <fixture@netflix.com>",
    "To: Client <client@example.invalid>",
    "Subject: Local sign-in fixture",
    "",
    "Local message fixture",
    "",
  ].join("\r\n"));
  const signed = await dkimSign(source, {
    headerList: "From:To:Subject",
    signatureData: [{
      privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
      signingDomain: "netflix.com",
      selector: "integration-fixture",
    }],
  });
  expect(signed.errors).toEqual([]);
  expect(await isAuthenticNetflix(Buffer.concat([Buffer.from(signed.signatures), source]))).toBe(true);
  expect(resolveTxt).toHaveBeenCalledTimes(1);
});
