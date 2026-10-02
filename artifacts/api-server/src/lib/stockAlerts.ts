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

export function summarizeAvailableStock(
  rows: StockRow[],
  threshold: number,
): StockSummary[] {
  const available = (rows || []).filter(row => !row?.is_used
    && String(row?.service || "").trim().toLowerCase() === "netflix").length;
  return [{
    service: "Netflix",
    available,
    threshold,
    low: available <= threshold,
  }];
}
