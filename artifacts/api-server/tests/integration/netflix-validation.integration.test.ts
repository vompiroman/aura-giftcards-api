import { describe, expect, it } from "vitest";
import {
  extractNetflixCode,
  isAllowedNetflixHostname,
  isAuthenticNetflix,
  isNetflixSenderAddress,
} from "../../src/lib/netflixValidation";

describe("validation des messages Netflix", () => {
  it("refuse les domaines qui contiennent seulement netflix.com", () => {
    expect(isAllowedNetflixHostname("notnetflix.com")).toBe(false);
    expect(isAllowedNetflixHostname("netflix.com.evil.test")).toBe(false);
    expect(isAllowedNetflixHostname("mail.netflix.com")).toBe(true);
    expect(isNetflixSenderAddress("alerts@notnetflix.com")).toBe(false);
    expect(isNetflixSenderAddress("alerts@mail.netflix.com")).toBe(true);
  });

  it("exige un DKIM pass lié à un domaine Netflix", () => {
    const parsed = (value: string) => ({ headers: { get: () => value } });
    expect(isAuthenticNetflix(parsed("dkim=pass header.d=notnetflix.com"))).toBe(false);
    expect(isAuthenticNetflix(parsed("dkim=pass header.d=netflix.com"))).toBe(true);
    expect(isAuthenticNetflix(parsed("dkim=pass; spf=pass header.d=netflix.com"))).toBe(false);
    expect(isAuthenticNetflix(parsed("mx.google.com; dkim=pass header.d=mailer.netflix.com; spf=pass"))).toBe(true);
  });

  it("ne retourne que les URL HTTPS d'un hôte Netflix autorisé", () => {
    const text = "https://notnetflix.com/verify/EMAIL_bad https://www.netflix.com/verify/EMAIL_good";
    expect(extractNetflixCode(text, "").link).toBe("https://www.netflix.com/verify/EMAIL_good");
    expect(extractNetflixCode("http://www.netflix.com/verify/EMAIL_http", "").link).toBeUndefined();
  });
});

