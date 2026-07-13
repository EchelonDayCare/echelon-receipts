import { useEffect, useState } from "react";
import { getSettings, subsidyReconciliation, type SubsidyMonthRow } from "../../lib/db";
import type { SettingsMap } from "../../types";
import { type YearMode, parseYearMode, currentFiscalYear, fiscalYearLabel, fiscalMonthOrder } from "../../lib/fiscalYear";
import { printCurrentWindow } from "../../lib/print";

const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmt(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function Subsidy() {
  const now = new Date();
  const [settings, setSettings] = useState<SettingsMap>({});
  const [mode, setMode] = useState<YearMode>("fiscal_sep_aug");
  const [year, setYear] = useState<number>(currentFiscalYear(now));
  const [rows, setRows] = useState<SubsidyMonthRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const s = await getSettings();
      setSettings(s);
      const m = parseYearMode(s.reporting_year_mode);
      setMode(m);
      setYear(m === "fiscal_sep_aug" ? currentFiscalYear(now) : now.getFullYear());
      setLoaded(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!loaded) return;
    (async () => {
      const data = mode === "fiscal_sep_aug"
        ? await subsidyReconciliation(undefined, year)
        : await subsidyReconciliation(year);
      setRows(data);
    })();
  }, [loaded, year, mode]);

  const orderedMonths: Array<{ year: number; month: number }> = mode === "fiscal_sep_aug"
    ? fiscalMonthOrder(year)
    : [1,2,3,4,5,6,7,8,9,10,11,12].map((m) => ({ year, month: m }));
  const byMonth = new Map<string, SubsidyMonthRow>();
  rows.forEach((r) => byMonth.set(`${r.year}-${String(r.month).padStart(2, "0")}`, r));

  const displayRows = orderedMonths.map(({ year: y, month: m }) => {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    return byMonth.get(key) || { year: y, month: m, receipt_count: 0, gross_total: 0, ccfri_total: 0, accb_total: 0, parent_paid_total: 0 };
  });

  const totals = displayRows.reduce((a, r) => ({
    receipts: a.receipts + r.receipt_count,
    gross:   a.gross   + r.gross_total,
    ccfri:   a.ccfri   + r.ccfri_total,
    accb:    a.accb    + r.accb_total,
    paid:    a.paid    + r.parent_paid_total,
  }), { receipts: 0, gross: 0, ccfri: 0, accb: 0, paid: 0 });

  const yearLabel = mode === "fiscal_sep_aug" ? fiscalYearLabel(year) : String(year);
  const fileSuffix = mode === "fiscal_sep_aug"
    ? `FY${year}-${String((year + 1) % 100).padStart(2, "0")}`
    : String(year);

  function exportCsv() {
    const lines = ["Month,Receipts,Gross,CCFRI,ACCB,Parent Paid"];
    displayRows.forEach((r) => {
      lines.push([`${r.year}-${String(r.month).padStart(2, "0")} (${MONTH_NAMES[r.month]})`,
        r.receipt_count, fmt(r.gross_total), fmt(r.ccfri_total), fmt(r.accb_total), fmt(r.parent_paid_total)]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
    });
    lines.push(["Totals", totals.receipts, fmt(totals.gross), fmt(totals.ccfri), fmt(totals.accb), fmt(totals.paid)]
      .map((v) => `"${String(v)}"`).join(","));
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `subsidy-reconciliation-${fileSuffix}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const daycareName = settings.daycare_name || "Echelon Daycare";
  const today = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

  return (
    <div style={{ padding: 24, maxWidth: 1100 }}>
      <div className="no-print" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div>
          <h1 style={{ marginTop: 0, marginBottom: 6 }}>Subsidy Reconciliation</h1>
          <p style={{ color: "var(--muted)", margin: 0 }}>
            Gross fees, CCFRI reduction, ACCB benefit and parent-paid amounts month by month.
            Compare against BC Ministry of Education & Child Care CCFRI/ACCB statements.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select value={mode} onChange={(e) => setMode(e.target.value as YearMode)}>
            <option value="fiscal_sep_aug">Fiscal (Sep–Aug)</option>
            <option value="calendar">Calendar (Jan–Dec)</option>
          </select>
          <button className="btn secondary" onClick={() => setYear(year - 1)}>‹</button>
          <span style={{ minWidth: 90, textAlign: "center", fontWeight: 600 }}>{yearLabel}</span>
          <button className="btn secondary" onClick={() => setYear(year + 1)}>›</button>
          <button className="btn secondary" onClick={exportCsv}>Export CSV</button>
          <button className="btn" onClick={() => { void printCurrentWindow(); }}>Print</button>
        </div>
      </div>

      <div className="report-sheet" style={{ background: "#fff", padding: 24, border: "1px solid var(--border)", borderRadius: 8 }}>
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{daycareName}</div>
          <div style={{ color: "var(--muted)" }}>Subsidy Reconciliation — {yearLabel}</div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>Printed: {today}</div>
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#f8fafc" }}>
              <th style={{ textAlign: "left", padding: 6, border: "1px solid var(--border)" }}>Month</th>
              <th style={{ textAlign: "right", padding: 6, border: "1px solid var(--border)" }}>Receipts</th>
              <th style={{ textAlign: "right", padding: 6, border: "1px solid var(--border)" }}>Gross Fees</th>
              <th style={{ textAlign: "right", padding: 6, border: "1px solid var(--border)" }}>CCFRI</th>
              <th style={{ textAlign: "right", padding: 6, border: "1px solid var(--border)" }}>ACCB</th>
              <th style={{ textAlign: "right", padding: 6, border: "1px solid var(--border)" }}>Parent Paid</th>
            </tr>
          </thead>
          <tbody>
            {displayRows.map((r) => (
              <tr key={`${r.year}-${r.month}`}>
                <td style={{ padding: 6, border: "1px solid var(--border)" }}>{MONTH_NAMES[r.month]} {r.year}</td>
                <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>{r.receipt_count}</td>
                <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>${fmt(r.gross_total)}</td>
                <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>${fmt(r.ccfri_total)}</td>
                <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>${fmt(r.accb_total)}</td>
                <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>${fmt(r.parent_paid_total)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ background: "#f8fafc", fontWeight: 700 }}>
              <td style={{ padding: 6, border: "1px solid var(--border)" }}>Totals</td>
              <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>{totals.receipts}</td>
              <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>${fmt(totals.gross)}</td>
              <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>${fmt(totals.ccfri)}</td>
              <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>${fmt(totals.accb)}</td>
              <td style={{ padding: 6, border: "1px solid var(--border)", textAlign: "right" }}>${fmt(totals.paid)}</td>
            </tr>
          </tfoot>
        </table>

        <div style={{ marginTop: 16, fontSize: 11, color: "var(--muted)", borderTop: "1px solid var(--border)", paddingTop: 8 }}>
          CCFRI = Child Care Fee Reduction Initiative (posted daycare deduction). ACCB = Affordable Child Care Benefit (paid directly to daycare per eligible child).
          Parent Paid = amount the family actually paid (Gross − CCFRI − ACCB).
        </div>
      </div>

      <style>{`
        @media print {
          .no-print { display: none !important; }
          .report-sheet { border: none !important; padding: 0 !important; }
          @page { margin: 0.5in; }
        }
      `}</style>
    </div>
  );
}
