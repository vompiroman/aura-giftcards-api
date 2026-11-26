import { Resolver } from "node:dns/promises";
import { dkimVerify } from "mailauth/lib/dkim/verify.js";

const NETFLIX_HOST = "netflix.com";
const dkimResolver = new Resolver({ timeout: 1200, tries: 1 });

export function isAllowedNetflixHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  return normalized === NETFLIX_HOST || normalized.endsWith(`.${NETFLIX_HOST}`);
}

export function isNetflixSenderAddress(address: unknown): boolean {
  if (typeof address !== "string") return false;
  const match = address.match(/<([^>]+)>/) || address.match(/\b([^\s<>@]+@[^\s<>@]+)\b/);
  const email = (match?.[1] || address).trim().toLowerCase();
  const domain = email.split("@").pop() || "";
  return isAllowedNetflixHostname(domain);
}

export async function isAuthenticNetflix(source: Buffer): Promise<boolean> {
  const verification = await dkimVerify(source, {
    rejectRsaSha1: true,
    resolver: async (name, rrtype) => {
      const domain = /\._domainkey\.(.+)$/i.exec(name)?.[1];
      if (rrtype !== "TXT" || !domain || !isAllowedNetflixHostname(domain)) {
        throw Object.assign(new Error("Unexpected DKIM key domain"), { code: "ENODATA" });
      }
      return dkimResolver.resolveTxt(name);
    },
  });
  if (verification.fromFields !== 1 || verification.headerFrom.length !== 1 || !isNetflixSenderAddress(verification.headerFrom[0])) return false;
  if (verification.headers?.parsed.filter(header => header.key === "to").length !== 1) return false;
  if (verification.headers.parsed.filter(header => header.key === "subject").length !== 1) return false;
  return verification.results.some(result => {
    if (result.status.result !== "pass" || result.signatureTimeValid === false || result.canonBodyLengthLimited ||
      !isAllowedNetflixHostname(result.signingDomain || "")) return false;
    const signedHeaders = (result.signingHeaders?.headers || []).map(header => header.split(":")[0].toLowerCase());
    return ["from", "to", "subject"].every(header => signedHeaders.includes(header));
  });
}

function isApprovedNetflixUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !isAllowedNetflixHostname(url.hostname)) return false;
    return /\/(?:account\/travel\/verify|account\/update-primary-location|verify|nftoken|EMAIL_)/i.test(
      `${url.pathname}${url.search}`,
    );
  } catch {
    return false;
  }
}

export function extractNetflixCode(text: string, html: string, subject?: string): { code?: string; link?: string } {
  const lowerSubject = (subject || "").normalize("NFD").toLowerCase();
  const forbiddenKeywords = [
    "mot de passe", "password", "contraseÃ±a", "reinitialis", "reset",
    "restablece", "changement d'adresse", "update your email", "change your email",
  ];
  if (forbiddenKeywords.some((kw) => lowerSubject.includes(kw))) return {};

  const haystack = `${text || ""}\n${html || ""}`;
  const candidates = haystack.match(/https?:\/\/[^\s"'<>]+/gi) || [];
  const link = candidates.find(isApprovedNetflixUrl);
  const codeMatch = haystack.match(/(?:code|cÃ³digo|codice|zugangscode|verification code|code de vÃ©rification|votre code|access code|temporaire|connexion|login)\D{0,40}\b(\d{4})\b/i);
  return { code: codeMatch?.[1], link };
}

