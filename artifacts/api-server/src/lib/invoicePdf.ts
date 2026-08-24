import { resolveInvoiceLines } from "./invoiceLines";

export interface InvoiceOrder {
  job_order_id: string;
  customer_email: string;
  total_amount: number | string;
  subtotal_amount: number | string | null;
  discount_amount: number | string | null;
  order_items: unknown;
  ordered_at: string;
  paid_at: string;
}

const A4_WIDTH = 595;
const A4_HEIGHT = 842;

function finiteAmount(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback;
}

function formatDa(value: number): string {
  const formatted = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 })
    .format(value)
    .replace(/[\u00a0\u202f]/g, " ");
  return `${formatted} DA`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Africa/Algiers",
  }).format(date);
}

function invoiceNumber(orderId: string, paidAt: string): string {
  const year = Number.isFinite(new Date(paidAt).getTime()) ? new Date(paidAt).getUTCFullYear() : new Date().getUTCFullYear();
  const suffix = orderId.replace(/[^a-z0-9]/gi, "").slice(-10).toUpperCase() || "PAIEMENT";
  return `AS-${year}-${suffix}`;
}

function winAnsiByte(char: string): number {
  const code = char.codePointAt(0) || 63;
  if (code <= 255) return code;
  const extras: Record<number, number> = {
    0x0152: 0x8c, 0x0153: 0x9c, 0x0160: 0x8a, 0x0161: 0x9a,
    0x0178: 0x9f, 0x017d: 0x8e, 0x017e: 0x9e, 0x2013: 0x96,
    0x2014: 0x97, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
    0x201d: 0x94, 0x2022: 0x95, 0x2026: 0x85, 0x20ac: 0x80,
  };
  return extras[code] ?? 63;
}

function pdfString(value: string): string {
  let encoded = "";
  for (const char of String(value)) {
    const byte = winAnsiByte(char);
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) encoded += `\\${String.fromCharCode(byte)}`;
    else if (byte >= 32 && byte <= 126) encoded += String.fromCharCode(byte);
    else encoded += `\\${byte.toString(8).padStart(3, "0")}`;
  }
  return encoded;
}

function approximateWidth(text: string, size: number): number {
  return [...text].length * size * 0.52;
}

function truncate(text: string, size: number, maxWidth: number): string {
  if (approximateWidth(text, size) <= maxWidth) return text;
  const maxChars = Math.max(1, Math.floor(maxWidth / (size * 0.52)) - 1);
  return `${text.slice(0, maxChars).trimEnd()}…`;
}

function textCommand(text: string, x: number, y: number, size = 10, font = "F1", color = "0.137 0.141 0.165"): string {
  return `BT /${font} ${size} Tf ${color} rg 1 0 0 1 ${x} ${y} Tm (${pdfString(text)}) Tj ET`;
}

function rightTextCommand(text: string, right: number, y: number, size = 10, font = "F1", color?: string): string {
  const x = Math.max(40, right - approximateWidth(text, size));
  return textCommand(text, x, y, size, font, color);
}

function contentStream(order: InvoiceOrder): string {
  const total = finiteAmount(order.total_amount);
  const subtotal = finiteAmount(order.subtotal_amount, total);
  const discount = finiteAmount(order.discount_amount);
  const lines = resolveInvoiceLines(
    order.order_items,
    order.subtotal_amount,
    order.total_amount,
    order.discount_amount,
  );
  const number = invoiceNumber(order.job_order_id, order.paid_at);
  const commands: string[] = [
    "q 0.965 0.949 0.925 rg 0 0 595 842 re f Q",
    "q 0.137 0.141 0.165 rg 0 692 595 150 re f Q",
    "q 0.851 0.212 0.275 rg 0 686 595 6 re f Q",
    textCommand("AURA", 46, 782, 21, "F2", "0.965 0.949 0.925"),
    textCommand("STREAM", 110, 782, 21, "F2", "0.851 0.212 0.275"),
    textCommand("FACTURE / REÇU DE PAIEMENT", 46, 735, 11, "F2", "0.918 0.839 0.722"),
    rightTextCommand(number, 548, 782, 10, "F2", "0.965 0.949 0.925"),
    rightTextCommand("PAIEMENT CONFIRMÉ", 548, 735, 9, "F2", "0.965 0.949 0.925"),
    textCommand("Facturé à", 46, 638, 9, "F2", "0.851 0.212 0.275"),
    textCommand(truncate(order.customer_email, 12, 230), 46, 616, 12, "F2"),
    textCommand("Commande", 335, 638, 9, "F2", "0.851 0.212 0.275"),
    textCommand(truncate(order.job_order_id, 9, 213), 335, 616, 9, "F1"),
    textCommand("Paiement confirmé le", 335, 590, 9, "F2", "0.851 0.212 0.275"),
    textCommand(formatDate(order.paid_at), 335, 568, 9, "F1"),
    "q 0.851 0.212 0.275 RG 0.8 w 46 538 m 549 538 l S Q",
    textCommand("ABONNEMENT", 46, 510, 8, "F2", "0.353 0.357 0.376"),
    textCommand("QTÉ", 360, 510, 8, "F2", "0.353 0.357 0.376"),
    textCommand("PRIX", 420, 510, 8, "F2", "0.353 0.357 0.376"),
    rightTextCommand("TOTAL", 549, 510, 8, "F2", "0.353 0.357 0.376"),
  ];

  let y = 476;
  for (const line of lines.slice(0, 10)) {
    commands.push(textCommand(truncate(line.name, 10, 285), 46, y, 10, "F2"));
    commands.push(textCommand(String(line.quantity), 365, y, 10, "F1"));
    commands.push(rightTextCommand(formatDa(line.unitPrice), 482, y, 10, "F1"));
    commands.push(rightTextCommand(formatDa(line.total), 549, y, 10, "F2"));
    commands.push(`q 0.855 0.827 0.792 RG 0.5 w 46 ${y - 16} m 549 ${y - 16} l S Q`);
    y -= 42;
  }

  const totalsTop = Math.max(190, y - 4);
  commands.push(textCommand("Sous-total", 350, totalsTop, 10, "F1", "0.353 0.357 0.376"));
  commands.push(rightTextCommand(formatDa(subtotal), 549, totalsTop, 10, "F1"));
  if (discount > 0) {
    commands.push(textCommand("Remise", 350, totalsTop - 25, 10, "F1", "0.353 0.357 0.376"));
    commands.push(rightTextCommand(`- ${formatDa(discount)}`, 549, totalsTop - 25, 10, "F1", "0.851 0.212 0.275"));
  }
  const totalY = discount > 0 ? totalsTop - 64 : totalsTop - 39;
  commands.push("q 0.137 0.141 0.165 rg 335 " + (totalY - 17) + " 214 45 re f Q");
  commands.push(textCommand("TOTAL PAYÉ", 350, totalY, 10, "F2", "0.965 0.949 0.925"));
  commands.push(rightTextCommand(formatDa(total), 535, totalY, 14, "F2", "0.965 0.949 0.925"));

  commands.push(textCommand("Mode de paiement : CIB / Edahabia via SlickPay", 46, 116, 9, "F1", "0.353 0.357 0.376"));
  commands.push(textCommand("Ce document confirme la réception de votre paiement.", 46, 94, 9, "F1", "0.353 0.357 0.376"));
  commands.push(textCommand("Merci pour votre confiance.", 46, 60, 10, "F2", "0.851 0.212 0.275"));
  commands.push(rightTextCommand("www.aura-stream.com", 549, 60, 9, "F2", "0.137 0.141 0.165"));
  return commands.join("\n");
}

function pdfObject(value: string | Buffer): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value, "binary");
}

export function buildInvoicePdf(order: InvoiceOrder): Buffer {
  const content = Buffer.from(contentStream(order), "ascii");
  const objects: Buffer[] = [
    pdfObject("<< /Type /Catalog /Pages 2 0 R >>"),
    pdfObject("<< /Type /Pages /Kids [5 0 R] /Count 1 >>"),
    pdfObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
    pdfObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"),
    pdfObject(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4_WIDTH} ${A4_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents 6 0 R >>`),
    Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`, "ascii"),
      content,
      Buffer.from("\nendstream", "ascii"),
    ]),
  ];
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary")];
  const offsets = [0];
  let offset = parts[0].length;
  objects.forEach((object, index) => {
    offsets.push(offset);
    const wrapped = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, "ascii"),
      object,
      Buffer.from("\nendobj\n", "ascii"),
    ]);
    parts.push(wrapped);
    offset += wrapped.length;
  });
  const xrefOffset = offset;
  const xref = [
    `xref\n0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.slice(1).map((value) => `${String(value).padStart(10, "0")} 00000 n `),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    `startxref\n${xrefOffset}`,
    "%%EOF\n",
  ].join("\n");
  parts.push(Buffer.from(xref, "ascii"));
  return Buffer.concat(parts);
}

export function invoiceFilename(orderId: string): string {
  const safe = orderId.replace(/[^a-z0-9-]/gi, "-").slice(0, 80) || "commande";
  return `facture-aura-stream-${safe}.pdf`;
}
