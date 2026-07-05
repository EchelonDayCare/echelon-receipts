// Fiscal Year helpers for Echelon Daycare Society
// Fiscal Year runs Sep 1 → Aug 31.
// Internal numeric key = start year: FY 2025-26 → 2025.
// CRA Annual Tax Receipts intentionally do NOT use this — they remain calendar year.

export type YearMode = "calendar" | "fiscal_sep_aug";
export const FISCAL_START_MONTH = 9; // September

/** Given an ISO date string "YYYY-MM-DD" (or Date), returns FY start year. */
export function fiscalYearOf(dateInput: string | Date): number {
  const d = typeof dateInput === "string" ? new Date(dateInput + "T00:00:00") : dateInput;
  const y = d.getFullYear();
  const m = d.getMonth() + 1; // 1..12
  return m >= FISCAL_START_MONTH ? y : y - 1;
}

/** Returns the current fiscal year (start year). */
export function currentFiscalYear(now: Date = new Date()): number {
  return fiscalYearOf(now);
}

/** Human label: "FY 2025-26" */
export function fiscalYearLabel(fy: number): string {
  const end = (fy + 1) % 100;
  return `FY ${fy}-${end.toString().padStart(2, "0")}`;
}

/** Inclusive ISO date bounds for a fiscal year: Sep 1 fy → Aug 31 fy+1 */
export function fiscalYearBounds(fy: number): { start: string; end: string } {
  return { start: `${fy}-09-01`, end: `${fy + 1}-08-31` };
}

/** Ordered (year, month) pairs for a fiscal year: Sep..Dec of fy, then Jan..Aug of fy+1 */
export function fiscalMonthOrder(fy: number): Array<{ year: number; month: number }> {
  const out: Array<{ year: number; month: number }> = [];
  for (let m = FISCAL_START_MONTH; m <= 12; m++) out.push({ year: fy, month: m });
  for (let m = 1; m <= FISCAL_START_MONTH - 1; m++) out.push({ year: fy + 1, month: m });
  return out;
}

/** Which fiscal quarter (1..4) does calendar month (1..12) belong to? */
export function fiscalQuarterOfMonth(month: number): 1 | 2 | 3 | 4 {
  // Q1 Sep-Nov, Q2 Dec-Feb, Q3 Mar-May, Q4 Jun-Aug
  if (month === 9 || month === 10 || month === 11) return 1;
  if (month === 12 || month === 1 || month === 2) return 2;
  if (month >= 3 && month <= 5) return 3;
  return 4;
}

export const FISCAL_QUARTER_LABEL: Record<1 | 2 | 3 | 4, string> = {
  1: "Q1 (Sep–Nov)",
  2: "Q2 (Dec–Feb)",
  3: "Q3 (Mar–May)",
  4: "Q4 (Jun–Aug)",
};

/** Ordered (year, month) pairs for a fiscal quarter within FY start year `fy`. */
export function fiscalQuarterMonths(fy: number, q: 1 | 2 | 3 | 4): Array<{ year: number; month: number }> {
  switch (q) {
    case 1: return [{year: fy, month: 9}, {year: fy, month: 10}, {year: fy, month: 11}];
    case 2: return [{year: fy, month: 12}, {year: fy + 1, month: 1}, {year: fy + 1, month: 2}];
    case 3: return [{year: fy + 1, month: 3}, {year: fy + 1, month: 4}, {year: fy + 1, month: 5}];
    case 4: return [{year: fy + 1, month: 6}, {year: fy + 1, month: 7}, {year: fy + 1, month: 8}];
  }
}

/** Parse setting value defensively; default is fiscal_sep_aug. */
export function parseYearMode(val: string | undefined | null): YearMode {
  return val === "calendar" ? "calendar" : "fiscal_sep_aug";
}
