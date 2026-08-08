const NETFLIX_HOST = "netflix.com";

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

export function isAuthenticNetflix(parsed: any): boolean {
  const authResults = String(parsed?.headers?.get?.("authentication-results") || "").toLowerCase();
  return authResults.split(";").some((clause) => {
    if (!/(?:^|\s)dkim\s*=\s*pass\b/i.test(clause)) return false;
    const domain = clause.match(/(?:^|\s)(?:header\.)?d\s*=\s*([a-z0-9.-]+)/i)?.[1] || "";
    return isAllowedNetflixHostname(domain);
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

