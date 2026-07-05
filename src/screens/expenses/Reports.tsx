import { useEffect, useMemo, useState } from "react";
import { getSettings, type SubsidyMonthRow } from "../../lib/db";
import type { SettingsMap } from "../../types";
import {
  summaryByCategory, summaryByMonth, revenueByMonth,
  CATEGORY_LABEL,
} from "../../lib/expenses";
import { type YearMode, parseYearMode, currentFiscalYear, fiscalYearBounds, fiscalYearLabel, fiscalMonthOrder } from "../../lib/fiscalYear";

// SubsidyMonthRow re-imported so we can share label patterns
export type _ = SubsidyMonthRow;

type Period = "monthly" | "quarterly" | "yearly";
const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmt(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function yearBounds(y: number, mode: YearMode): { from: string; to: string; label: string; months: Array<{ year: number; month: number }> } {
  if (mode === "fiscal_sep_aug") {
    const b = fiscalYearBounds(y);
    return { from: b.start, to: b.end, label: fiscalYearLabel(y), months: fiscalMonthOrder(y) };
  }
  return {
    from: `${y}-01-01`, to: `${y}-12-31`, label: String(y),
    months: [1,2,3,4,5,6,7,8,9,10,11,12].map((m) => ({ year: y, month: m })),
  };
}

export default function ExpenseReports() {
  const now = new Date();
  const [settings, setSettings] = useState<SettingsMap>({});
  const [mode, setMode] = useState<YearMode>("fiscal_sep_aug");
  const [year, setYear] = useState<number>(currentFiscalYear(now));
  const [period, setPeriod] = useState<Period>("monthly");
  const [loaded, setLoaded] = useState(false);

  const [byMonth, setByMonth] = useState<Array<{ ym: string; total: number; count: number }>>([]);
  const [byCat, setByCat] = useState<Array<{ category: string; total: number; count: number }>>([]);
  const [revenue, setRevenue] = useState<Array<{ ym: string; total: number }>>([]);

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

  const bounds = useMemo(() => yearBounds(year, mode), [year, mode]);

  useEffect(() => {
    if (!loaded) return;
    (async () => {
      const [m, c, rev] = await Promise.all([
        summaryByMonth(bounds.from, bounds.to),
        summaryByCategory(bounds.from, bounds.to),
        revenueByMonth(bounds.from, bounds.to),
      ]);
      setByMonth(m);
      setByCat(c);
      setRevenue(rev);
    })();
  }, [loaded, bounds.from, bounds.to]);

  const expByYm = new Map(byMonth.map((r) => [r.ym, r.total]));
  const revByYm = new Map(revenue.map((r) => [r.ym, r.total]));

  const monthRows = bounds.months.map(({ year: y, month }) => {
    const ym = `${y}-${String(month).padStart(2, "0")}`;
    const exp = expByYm.get(ym) || 0;
    const rev = revByYm.get(ym) || 0;
    return { ym, y, month, exp, rev, net: rev - exp };
  });

  const quarterRows = useMemo(() => {
    // Group into 4 quarters based on order of months (fiscal or calendar).
    const groups = [monthRows.slice(0, 3), monthRows.slice(3, 6), monthRows.slice(6, 9), monthRows.slice(9, 12)];
    return groups.map((g, i) => ({
      label: `Q${i + 1}`,
      months: g.map((x) => MONTH_NAMES[x.month]).join("–"),
      rev: g.reduce((a, x) => a + x.rev, 0),
      exp: g.reduce((a, x) => a + x.exp, 0),
      net: g.reduce((a, x) => a + x.net, 0),
    }));
  }, [monthRows]);

  const yearTotals = {
    rev: monthRows.reduce((a, x) => a + x.rev, 0),
    exp: monthRows.reduce((a, x) => a + x.exp, 0),
    net: monthRows.reduce((a, x) => a + x.net, 0),
  };

  const daycareName = settings.daycare_name || "Echelon Daycare";
  const today = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

  function exportCsv() {
    const lines: string[] = [];
    lines.push(`"${daycareName} — Expense Report (${period}) — ${bounds.label}"`);
    lines.push(`"Printed: ${today}"`);
    lines.push("");

    if (period === "monthly") {
      lines.push("Month,Revenue,Expenses,Net");
      monthRows.forEach((r) => lines.push([`${MONTH_NAMES[r.month]} ${r.y}`, fmt(r.rev), fmt(r.exp), fmt(r.net)].map((v) => `"${v}"`).join(",")));
    } else if (period === "quarterly") {
      lines.push("Quarter,Months,Revenue,Expenses,Net");
      quarterRows.forEach((q) => lines.push([q.label, q.months, fmt(q.rev), fmt(q.exp), fmt(q.net)].map((v) => `"${v}"`).join(",")));
    } else {
      lines.push("Year,Revenue,Expenses,Net");
      lines.push([bounds.label, fmt(yearTotals.rev), fmt(yearTotals.exp), fmt(yearTotals.net)].map((v) => `"${v}"`).join(","));
    }

    lines.push("");
    lines.push('"Totals:"');
    lines.push(["Total", fmt(yearTotals.rev), fmt(yearTotals.exp), fmt(yearTotals.net)].map((v) => `"${v}"`).join(","));
    lines.push("");
    lines.push('"Expenses by Category:"');
    lines.push("Category,Count,Total");
    byCat.forEach((c) => lines.push([CATEGORY_LABEL[c.category] || c.category, c.count, fmt(c.total)].map((v) => `"${v}"`).join(",")));

    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `expense-report-${period}-${bounds.label.replace(/[^\w-]/g, "_")}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ padding: 24, maxWidth: 1200 }}>
      <div className="no-print" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div>
          <h1 style={{ marginTop: 0, marginBottom: 6 }}>Expense Reports</h1>
          <p style={{ color: "var(--muted)", margin: 0 }}>Revenue vs Expenses — monthly, quarterly and yearly views.</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="yearly">Yearly (totals)</option>
          </select>
          <select value={mode} onChange={(e) => setMode(e.target.value as YearMode)}>
            <option value="fiscal_sep_aug">Fiscal (Sep–Aug)</option>
            <option value="calendar">Calendar (Jan–Dec)</option>
          </select>
          <button className="btn secondary" onClick={() => setYear(year - 1)}>‹</button>
          <span style={{ minWidth: 100, textAlign: "center", fontWeight: 600 }}>{bounds.label}</span>
          <button className="btn secondary" onClick={() => setYear(year + 1)}>›</button>
          <button className="btn secondary" onClick={exportCsv}>Export CSV</button>
          <button className="btn" onClick={() => window.print()}>Print</button>
        </div>
      </div>

      <div className="report-sheet" style={{ background: "#fff", padding: 24, border: "1px solid var(--border)", borderRadius: 8 }}>
        <div style={{ textAlign: "center", marginBottom: 18 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{daycareName}</div>
          <div style={{ color: "var(--muted)" }}>Expense Report ({period}) — {bounds.label}</div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>Printed: {today}</div>
        </div>

        {/* P&L summary */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 20 }}>
          <SummaryCard label="Revenue" value={yearTotals.rev} color="#065f46" />
          <SummaryCard label="Expenses" value={yearTotals.exp} color="#b91c1c" />
          <SummaryCard label="Net" value={yearTotals.net} color={yearTotals.net >= 0 ? "#065f46" : "#b91c1c"} />
        </div>

        {/* Detail table */}
        {period === "monthly" && (
          <table style={tbl()}>
            <thead>
              <tr style={hdr()}>
                <th style={th()}>Month</th>
                <th style={{ ...th(), textAlign: "right" }}>Revenue</th>
                <th style={{ ...th(), textAlign: "right" }}>Expenses</th>
                <th style={{ ...th(), textAlign: "right" }}>Net</th>
              </tr>
            </thead>
            <tbody>
              {monthRows.map((r) => (
                <tr key={r.ym}>
                  <td style={td()}>{MONTH_NAMES[r.month]} {r.y}</td>
                  <td style={{ ...td(), textAlign: "right" }}>${fmt(r.rev)}</td>
                  <td style={{ ...td(), textAlign: "right" }}>${fmt(r.exp)}</td>
                  <td style={{ ...td(), textAlign: "right", fontWeight: 600, color: r.net < 0 ? "#b91c1c" : "#065f46" }}>${fmt(r.net)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ ...hdr(), fontWeight: 700 }}>
                <td style={td()}>Total</td>
                <td style={{ ...td(), textAlign: "right" }}>${fmt(yearTotals.rev)}</td>
                <td style={{ ...td(), textAlign: "right" }}>${fmt(yearTotals.exp)}</td>
                <td style={{ ...td(), textAlign: "right", color: yearTotals.net < 0 ? "#b91c1c" : "#065f46" }}>${fmt(yearTotals.net)}</td>
              </tr>
            </tfoot>
          </table>
        )}

        {period === "quarterly" && (
          <table style={tbl()}>
            <thead>
              <tr style={hdr()}>
                <th style={th()}>Quarter</th>
                <th style={th()}>Months</th>
                <th style={{ ...th(), textAlign: "right" }}>Revenue</th>
                <th style={{ ...th(), textAlign: "right" }}>Expenses</th>
                <th style={{ ...th(), textAlign: "right" }}>Net</th>
              </tr>
            </thead>
            <tbody>
              {quarterRows.map((q) => (
                <tr key={q.label}>
                  <td style={td()}>{q.label}</td>
                  <td style={td()}>{q.months}</td>
                  <td style={{ ...td(), textAlign: "right" }}>${fmt(q.rev)}</td>
                  <td style={{ ...td(), textAlign: "right" }}>${fmt(q.exp)}</td>
                  <td style={{ ...td(), textAlign: "right", fontWeight: 600, color: q.net < 0 ? "#b91c1c" : "#065f46" }}>${fmt(q.net)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ ...hdr(), fontWeight: 700 }}>
                <td style={td()} colSpan={2}>Year Total</td>
                <td style={{ ...td(), textAlign: "right" }}>${fmt(yearTotals.rev)}</td>
                <td style={{ ...td(), textAlign: "right" }}>${fmt(yearTotals.exp)}</td>
                <td style={{ ...td(), textAlign: "right", color: yearTotals.net < 0 ? "#b91c1c" : "#065f46" }}>${fmt(yearTotals.net)}</td>
              </tr>
            </tfoot>
          </table>
        )}

        {period === "yearly" && (
          <table style={tbl()}>
            <thead>
              <tr style={hdr()}>
                <th style={th()}>Year</th>
                <th style={{ ...th(), textAlign: "right" }}>Revenue</th>
                <th style={{ ...th(), textAlign: "right" }}>Expenses</th>
                <th style={{ ...th(), textAlign: "right" }}>Net</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={td()}>{bounds.label}</td>
                <td style={{ ...td(), textAlign: "right" }}>${fmt(yearTotals.rev)}</td>
                <td style={{ ...td(), textAlign: "right" }}>${fmt(yearTotals.exp)}</td>
                <td style={{ ...td(), textAlign: "right", fontWeight: 600, color: yearTotals.net < 0 ? "#b91c1c" : "#065f46" }}>${fmt(yearTotals.net)}</td>
              </tr>
            </tbody>
          </table>
        )}

        {/* Breakdown by category */}
        <h3 style={{ marginTop: 26 }}>Expenses by Category</h3>
        {byCat.length === 0 ? (
          <p style={{ color: "var(--muted)" }}>No expenses recorded for this period.</p>
        ) : (
          <table style={tbl()}>
            <thead>
              <tr style={hdr()}>
                <th style={th()}>Category</th>
                <th style={{ ...th(), textAlign: "right" }}>Count</th>
                <th style={{ ...th(), textAlign: "right" }}>Total</th>
                <th style={{ ...th(), textAlign: "right" }}>% of exp</th>
              </tr>
            </thead>
            <tbody>
              {byCat.map((c) => (
                <tr key={c.category}>
                  <td style={td()}>{CATEGORY_LABEL[c.category] || c.category}</td>
                  <td style={{ ...td(), textAlign: "right" }}>{c.count}</td>
                  <td style={{ ...td(), textAlign: "right" }}>${fmt(c.total)}</td>
                  <td style={{ ...td(), textAlign: "right" }}>{yearTotals.exp > 0 ? ((c.total / yearTotals.exp) * 100).toFixed(1) : "0.0"}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ marginTop: 24, fontSize: 11, color: "var(--muted)", textAlign: "center" }}>
          Prepared for internal review and board reporting. Revenue includes issued receipts net of refunds; voided receipts excluded.
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 14, textAlign: "center", background: "#fff" }}>
      <div style={{ fontSize: 12, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color }}>${fmt(value)}</div>
    </div>
  );
}

function tbl(): React.CSSProperties { return { width: "100%", borderCollapse: "collapse", fontSize: 13 }; }
function hdr(): React.CSSProperties { return { background: "#f8fafc" }; }
function th(): React.CSSProperties { return { textAlign: "left", padding: 6, border: "1px solid var(--border)" }; }
function td(): React.CSSProperties { return { padding: 6, border: "1px solid var(--border)" }; }
