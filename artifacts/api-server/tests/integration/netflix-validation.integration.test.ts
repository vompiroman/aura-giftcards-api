import { describe, expect, it, vi } from "vitest";
import {
  extractNetflixCode,
  isAllowedNetflixHostname,
  isAuthenticNetflix,
  isNetflixSenderAddress,
} from "../../src/lib/netflixValidation";

const { verify } = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("mailauth/lib/dkim/verify.js", () => ({ dkimVerify: verify }));

describe("validation des messages Netflix", () => {
  it("refuse les domaines qui contiennent seulement netflix.com", () => {
    expect(isAllowedNetflixHostname("notnetflix.com")).toBe(false);
    expect(isAllowedNetflixHostname("netflix.com.evil.test")).toBe(false);
    expect(isAllowedNetflixHostname("mail.netflix.com")).toBe(true);
    expect(isNetflixSenderAddress("alerts@notnetflix.com")).toBe(false);
    expect(isNetflixSenderAddress("alerts@mail.netflix.com")).toBe(true);
  });

  it("exige une signature vérifiée qui couvre l’expéditeur, le destinataire, l’objet et le corps", async () => {
    const fixture = Buffer.from("message fixture");
    const result = {
      signingDomain: "netflix.com",
      status: { result: "pass" },
      signingHeaders: { headers: ["From: sender@netflix.com", "To: fixture@example.invalid", "Subject: Login code"] },
    };
    const verifyWith = (results: object[]) => verify.mockResolvedValueOnce({
      fromFields: 1, headerFrom: ["sender@netflix.com"], headers: { parsed: [{ key: "to" }, { key: "subject" }] }, results,
    });
    verifyWith([]);
    expect(await isAuthenticNetflix(fixture)).toBe(false);
    verifyWith([{ ...result, canonBodyLengthLimited: true }]);
    expect(await isAuthenticNetflix(fixture)).toBe(false);
    verifyWith([result]);
    expect(await isAuthenticNetflix(fixture)).toBe(true);
  });

  it("ne retourne que les URL HTTPS d'un hôte Netflix autorisé", () => {
    const text = "https://notnetflix.com/verify/EMAIL_bad https://www.netflix.com/verify/EMAIL_good";
    expect(extractNetflixCode(text, "").link).toBe("https://www.netflix.com/verify/EMAIL_good");
    expect(extractNetflixCode("http://www.netflix.com/verify/EMAIL_http", "").link).toBeUndefined();
  });

  it.each(["Réinitialisez votre accès", "Actualiza tu contraseña", "أعد تعيين كلمة المرور"])(
    "ignore les messages de récupération quelle que soit la langue",
    subject => {
      const text = "Code 1234 https://www.netflix.com/verify/EMAIL_fixture";
      expect(extractNetflixCode(text, "", subject)).toEqual({});
    },
  );
});

