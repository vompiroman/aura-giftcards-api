export interface StockRow {
  service?: string | null;
  is_used?: boolean | null;
}

export interface StockSummary {
  service: string;
  available: number;
  threshold: number;
  low: boolean;
}

function canonicalService(value: string, configured: string[]): string | null {
  const normalized = value.trim().toLowerCase();
  return configured.find((service) => service.toLowerCase() === normalized) || null;
}

export function summarizeAvailableStock(
  rows: StockRow[],
  services: string[],
  threshold: number,
): StockSummary[] {
  const cleanServices = Array.from(new Set(services.map((service) => service.trim()).filter(Boolean)));
  const counts = new Map(cleanServices.map((service) => [service, 0]));

  for (const row of rows || []) {
    if (row?.is_used) continue;
    const service = canonicalService(String(row?.service || ""), cleanServices);
    if (service) counts.set(service, (counts.get(service) || 0) + 1);
  }

  return cleanServices.map((service) => ({
    service,
    available: counts.get(service) || 0,
    threshold,
    low: (counts.get(service) || 0) <= threshold,
  }));
}
