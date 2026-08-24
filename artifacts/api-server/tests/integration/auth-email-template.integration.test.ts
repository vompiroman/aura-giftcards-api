import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const templatePath = resolve(process.cwd(), "../../supabase/templates/recovery.html");
const template = readFileSync(templatePath, "utf8");

describe("Supabase recovery email template", () => {
  it("contains the Supabase recovery URL and recipient placeholders", () => {
    expect(template).toContain("{{ .ConfirmationURL }}");
    expect(template).toContain("{{ .Email }}");
  });

  it("uses a safe email-compatible document without active content", () => {
    expect(template).toMatch(/^<!doctype html>/i);
    expect(template).not.toMatch(/<script\b/i);
    expect(template).not.toMatch(/<form\b/i);
    expect(template).not.toMatch(/javascript:/i);
    expect(template).not.toMatch(/data:image\//i);
  });

  it("includes the Aura Stream identity and account-safety guidance", () => {
    expect(template).toContain("Aura <span style=\"color:#d93646;\">Stream</span>");
    expect(template).toContain("ne le partage avec personne");
    expect(template).toContain("ton mot de passe actuel restera inchangé");
  });
});
