export function normalizeAlgerianMobile(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "";

  let digits = trimmed.replace(/\D/g, "");
  if (digits.startsWith("00213")) digits = digits.slice(5);
  else if (digits.startsWith("213")) digits = digits.slice(3);
  else if (digits.startsWith("0")) digits = digits.slice(1);
  digits = digits.replace(/^0+/, "");

  return /^[5-7]\d{8}$/.test(digits) ? `+213${digits}` : null;
}
