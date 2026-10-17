import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { parseBankCsv, toCents, groupFinanceMonths } from "./finance";
describe("finance money and statement intake", () => {
  it("converts decimal money without binary rounding", () => {
    expect(toCents("1.01")).toBe(101);
    expect(toCents("-$2,345.60")).toBe(-234560);
    expect(() => toCents("1.001")).toThrow();
    expect(() => toCents("NaN")).toThrow();
    expect(() => toCents("")).toThrow();
    expect(() => toCents("1,23.00")).toThrow();
    expect(() => toCents("1$23")).toThrow();
  });
  it("keeps identical transactions as separate occurrences", () => {
    const rows = parseBankCsv('Date,Description,Withdrawal,Deposit\r\n2026-09-01,"Payment, first",,100.50\r\n2026-09-01,"Payment, first",,100.50');
    expect(rows).toHaveLength(2);
    expect(rows[0].cents).toBe(10050);
    expect(rows[0].description).toBe("Payment, first");
  });
  it("preserves negative movements and rejects ambiguous CSV", () => {
    expect(parseBankCsv("Date,Description,Amount\n2026-09-02,Fee,-4.95")[0].cents).toBe(-495);
    expect(() => parseBankCsv("Date,Description,Withdrawal,Deposit\n2026-09-02,x,1,1")).toThrow();
    expect(() => parseBankCsv('Date,Description,Amount\n2026-09-02,"bad,2')).toThrow();
    expect(() => parseBankCsv("Date,Description,Amount\n2026-09-02,x,1,extra")).toThrow();
  });
  it("groups September fiscal quarters and years without resetting balances", () => {
    const rows = [
      { month: "2026-09", income_cents: 101, expense_cents: 0 },
      { month: "2026-11", income_cents: 102, expense_cents: 2 },
      { month: "2026-12", income_cents: 103, expense_cents: 3 },
      { month: "2027-08", income_cents: 104, expense_cents: 4 },
      { month: "2027-09", income_cents: 105, expense_cents: 5 },
    ];
    expect(groupFinanceMonths(rows, "quarter").map((r) => r.label)).toEqual(["2026–2027 Q1", "2026–2027 Q2", "2026–2027 Q4", "2027–2028 Q1"]);
    expect(groupFinanceMonths(rows, "year")[0].income_cents).toBe(410);
  });
});
