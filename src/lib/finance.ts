import { invoke } from "@tauri-apps/api/core";
import { db, serializeWrite } from "./db";

export type AccountKind = "bank" | "card" | "clearing" | "income" | "expense" | "asset" | "liability" | "equity";
export interface FinanceAccount { code: string; name: string; kind: AccountKind; balance_cents: number }
export interface FinanceConfig { start_date: string; closed_through: string | null; opening_confirmed: number; funding_confirmed: number }
export interface Statement { id: number; account: string; account_name: string; date_from: string; date_to: string; opening_cents: number; closing_cents: number; status: string; unresolved: number }
export interface FundingReceipt { entry_id: number; program: string; date: string; period_from: string; period_to: string; reference: string; evidence: string; treatment: string; received_cents: number; released_cents: number; refunded_cents: number }
export interface ReportExport { id: number; date_from: string; date_to: string; superseded: number; created_at: string }
export interface DepositBatch { id: number; deposit_date: string; remaining: number }
export interface Snapshot { config: FinanceConfig[]; accounts: FinanceAccount[]; statements: Statement[]; funding: FundingReceipt[]; exports: ReportExport[]; purchase_batches: { id: string; count: number; cents: number; date_from: string; date_to: string }[]; policies: { program: string; treatment: string; rule: string; evidence: string }[]; legacy: { source: string; count: number; earliest: string | null; latest: string | null }[] }
export interface StatementLine { id: number; date: string; description: string; cents: number; remaining: number; bank_id?: string | null }
export interface Allocation { id: number; line_id: number; entry_id: number; cents: number; kind: string; description: string }
export interface JournalEntry { id: number; date: string; description: string; debit: string; credit: string; cents: number; source: string; source_id: string; reversal_of: number | null; remaining?: number; days_apart?: number }
export interface FinanceReport {
  from: string; to: string; basis: string; provisional: boolean; warnings: string[];
  months: { month: string; income_cents: number; expense_cents: number }[];
  categories: FinanceAccount[]; trial_balance: FinanceAccount[]; entries: JournalEntry[];
  audit: { id: number; action: string; detail: string; created_at: string }[];
  cash_flow: { name: string; inflow_cents: number; outflow_cents: number }[];
  funding: FundingReceipt[];
  outstanding: (JournalEntry & { remaining: number; approved: number })[];
}
export function groupFinanceMonths(months: FinanceReport["months"], period: "month" | "quarter" | "year") {
  const groups = new Map<string, { label: string; income_cents: number; expense_cents: number }>();
  for (const m of months) {
    const [year, month] = m.month.split("-").map(Number);
    const fy = year - (month < 9 ? 1 : 0);
    const label = period === "month" ? m.month : period === "year" ? `${fy}–${fy + 1}`
      : `${fy}–${fy + 1} Q${Math.floor(((month + 3) % 12) / 3) + 1}`;
    const group = groups.get(label) ?? { label, income_cents: 0, expense_cents: 0 };
    group.income_cents += m.income_cents;
    group.expense_cents += m.expense_cents;
    groups.set(label, group);
  }
  return [...groups.values()];
}
export async function finance<T>(op: string, data: Record<string, unknown> = {}): Promise<T> {
  await db();
  return serializeWrite(() => invoke<T>("finance", { request: { op, data } }));
}
export const money = (cents: number) => (cents / 100).toLocaleString("en-CA", { style: "currency", currency: "CAD" });
export function toCents(value: string): number {
  if (!/^-?\$?(?:\d+|\d{1,3}(?:,\d{3})+)(\.\d{1,2})?$/.test(value.trim())) {
    throw new Error(`Invalid monetary amount: ${value}. Use dollars with up to two decimal places and correctly grouped thousands.`);
  }
  const s = value.trim().replace(/[$,]/g, "");
  const negative = s.startsWith("-");
  const [whole, fraction = ""] = s.replace(/^-/, "").split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > 9_000_000_000_000) throw new Error("Amount is too large.");
  return negative ? -cents : cents;
}
function csvCells(text: string): string[][] {
  const result: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && quoted && text[i + 1] === '"') { cell += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (c === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); if (row.some((x) => x.trim())) result.push(row);
      row = []; cell = "";
    } else cell += c;
  }
  if (quoted) throw new Error("CSV has an unterminated quoted field.");
  row.push(cell); if (row.some((x) => x.trim())) result.push(row);
  return result;
}
export interface ImportLine { date: string; description: string; cents: number; bank_id?: string | null }
export function parseBankCsv(text: string): ImportLine[] {
  const [headers, ...rows] = csvCells(text.replace(/^\uFEFF/, ""));
  if (!headers) throw new Error("CSV is empty.");
  const keys = headers.map((x) => x.trim().toLowerCase());
  const col = (key: string) => keys.indexOf(key);
  if (col("date") < 0 || col("description") < 0 || (col("amount") < 0 && (col("withdrawal") < 0 || col("deposit") < 0))) {
    throw new Error("CSV headers must be Date,Description,Amount (signed), or Date,Description,Withdrawal,Deposit. Dates: YYYY-MM-DD.");
  }
  return rows.map((r, i) => {
    if (r.length !== headers.length) throw new Error(`CSV row ${i + 2} has the wrong number of columns.`);
    const date = r[col("date")].trim(), description = r[col("description")].trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !description) throw new Error(`CSV row ${i + 2} needs a date and description.`);
    let cents: number;
    if (col("amount") >= 0) cents = toCents(r[col("amount")]);
    else {
      const debit = r[col("withdrawal")].trim() ? toCents(r[col("withdrawal")]) : 0;
      const credit = r[col("deposit")].trim() ? toCents(r[col("deposit")]) : 0;
      if (debit < 0 || credit < 0 || (debit && credit)) throw new Error(`CSV row ${i + 2} has ambiguous debit/credit columns.`);
      cents = credit - debit;
    }
    if (!cents) throw new Error(`CSV row ${i + 2} has a zero amount.`);
    return { date, description, cents, bank_id: col("bank_id") >= 0 ? r[col("bank_id")].trim() || null : null };
  });
}
export async function sourceHash(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(hash), (v) => v.toString(16).padStart(2, "0")).join("");
}
