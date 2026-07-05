import { useEffect, useState } from "react";
import { listReceipts, monthlyTotals, subsidyReconciliation, getSettings,
  type SubsidyMonthRow } from "../lib/db";
import type { Receipt, SettingsMap } from "../types";
import {
  type YearMode, parseYearMode, currentFiscalYear, fiscalYearLabel,
  fiscalMonthOrder, fiscalQuarterOfMonth, fiscalQuarterMonths, FISCAL_QUARTER_LABEL,
} from "../lib/fiscalYear";

const MONTH_NAMES = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

type Quarter = 1 | 2 | 3 | 4;
const CAL_QUARTER_MONTHS: Record<Quarter, number[]> = { 1: [1,2,3], 2: [4,5,6], 3: [7,8,9], 4: [10,11,12] };
const CAL_QUARTER_LABEL: Record<Quarter, string> = { 1: "Q1 (Jan–Mar)", 2: "Q2 (Apr–Jun)", 3: "Q3 (Jul–Sep)", 4: "Q4 (Oct–Dec)" };

export default function Reports() {
  const now = new Date();
  const [mode, setMode] = useState<YearMode>("fiscal_sep_aug");
  const [year, setYear] = useState<number>(currentFiscalYear(now));
  const [monthly, setMonthly] = useState<{ ym: string; count: number; total: number }[]>([]);
  const [all, setAll] = useState<Receipt[]>([]);
  const [settings, setSettings] = useState<SettingsMap>({});
  const [subsidy, setSubsidy] = useState<SubsidyMonthRow[]>([]);
  const [quarter, setQuarter] = useState<Quarter>(fiscalQuarterOfMonth(now.getMonth() + 1));
  const [modeLoaded, setModeLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const s = await getSettings();
      const m = parseYearMode(s.reporting_year_mode);
      setMode(m);
      setYear(m === "fiscal_sep_aug" ? currentFiscalYear(now) : now.getFullYear());
      setQuarter(m === "fiscal_sep_aug"
        ? fiscalQuarterOfMonth(now.getMonth() + 1)
        : ((Math.floor(now.getMonth() / 3) + 1) as Quarter));
      setModeLoaded(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const yearLabel = mode === "fiscal_sep_aug" ? fiscalYearLabel(year) : String(year);
  const fileSuffix = mode === "fiscal_sep_aug"
    ? `FY${year}-${String((year + 1) % 100).padStart(2, "0")}`
    : String(year);

  async function refresh() {
    const filter = mode === "fiscal_sep_aug" ? { fiscalYear: year } : { year };
    const [m, r, s, sub] = await Promise.all([
      mode === "fiscal_sep_aug" ? monthlyTotals(undefined, year) : monthlyTotals(year),
      listReceipts(filter),
      getSettings(),
      mode === "fiscal_sep_aug" ? subsidyReconciliation(undefined, year) : subsidyReconciliation(year),
    ]);
    setMonthly(m);
    setAll(r);
    setSettings(s);
    setSubsidy(sub);
  }
  useEffect(() => { if (modeLoaded) refresh(); /* eslint-disable-next-line */ }, [year, mode, modeLoaded]);

  const monthlyOrdered = (() => {
    if (mode !== "fiscal_sep_aug") return monthly;
    const order = fiscalMonthOrder(year).map(({ year: y, month: m }) => `${y}-${String(m).padStart(2, "0")}`);
    const byYm = new Map(monthly.map((r) => [r.ym, r]));
    return order
      .map((ym) => byYm.get(ym) || { ym, count: 0, total: 0 })
      .filter((r) => r.count > 0 || r.total > 0);
  })();

  const subsidyOrdered = (() => {
    if (mode !== "fiscal_sep_aug") return subsidy;
    const order = fiscalMonthOrder(year);
    const byKey = new Map(subsidy.map((r) => [`${r.year}-${r.month}`, r]));
    return order
      .map(({ year: y, month: m }) => byKey.get(`${y}-${m}`))
      .filter((r): r is SubsidyMonthRow => !!r);
  })();

  const grand = monthly.reduce((a, m) => a + m.total, 0);
  const count = monthly.reduce((a, m) => a + m.count, 0);
  const outstanding = all.filter((r) => !r.voided && r.pending_amount > 0);
  const subsidiesOn = settings.subsidies_enabled === "1";
  const subTot = subsidy.reduce((a, r) => ({
    gross: a.gross + r.gross_total,
    ccfri: a.ccfri + r.ccfri_total,
    accb:  a.accb  + r.accb_total,
    paid:  a.paid  + r.parent_paid_total,
  }), { gross: 0, ccfri: 0, accb: 0, paid: 0 });

  const quarterMonths = mode === "fiscal_sep_aug"
    ? fiscalQuarterMonths(year, quarter).map((qm) => qm.month)
    : CAL_QUARTER_MONTHS[quarter];
  const quarterLabel = mode === "fiscal_sep_aug" ? FISCAL_QUARTER_LABEL[quarter] : CAL_QUARTER_LABEL[quarter];

  function exportCsv() {
    const header = ["receipt_no","date","student","description","amount_paid","pending","gross","ccfri","accb","comments","voided","refund"];
    const lines = [header.join(",")].concat(
      all.map((r) => [
        r.receipt_no, r.date,
        `"${(r.student_name_snapshot || "").replace(/"/g, '""')}"`,
        `"${(r.description || "").replace(/"/g, '""')}"`,
        r.amount.toFixed(2), r.pending_amount.toFixed(2),
        (r.gross_amount ?? 0).toFixed(2),
        (r.ccfri_amount ?? 0).toFixed(2),
        (r.accb_amount  ?? 0).toFixed(2),
        `"${(r.comments || "").replace(/"/g, '""')}"`, r.voided, r.is_refund,
      ].join(","))
    );
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `receipts-${fileSuffix}.csv`; a.click();
    URL.revokeObjectURL(url);
  }
  function exportSubsidyCsv() {
    const header = ["year","month","receipt_count","gross_total","ccfri_total","accb_total","parent_paid_total"];
    const lines = [header.join(",")].concat(
      subsidyOrdered.map((r) => [r.year, r.month, r.receipt_count,
        r.gross_total.toFixed(2), r.ccfri_total.toFixed(2),
        r.accb_total.toFixed(2), r.parent_paid_total.toFixed(2)].join(","))
    );
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `subsidy-reconciliation-${fileSuffix}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  // CCFRI quarterly export — filters subsidy rows to the 3 months in the
  // selected quarter and per-receipt rows for that quarter.
  function exportCcfriQuarter() {
    const months = quarterMonths;
    const qReceipts = all.filter((r) => {
      if (r.voided) return false;
      const m = parseInt(r.date.slice(5, 7), 10);
      return months.includes(m);
    });
    const monthRows = subsidyOrdered
      .filter((r) => months.includes(r.month))
      .sort((a, b) => a.year - b.year || a.month - b.month);

    const csv: string[] = [];
    csv.push(`# CCFRI Quarterly Reconciliation - ${yearLabel} ${quarterLabel}`);
    csv.push(`# Generated ${new Date().toISOString().slice(0, 10)}`);
    csv.push("");
    csv.push("## Monthly summary");
    csv.push("year,month,receipt_count,gross_total,ccfri_total,accb_total,parent_paid_total");
    for (const r of monthRows) {
      csv.push([r.year, r.month, r.receipt_count,
        r.gross_total.toFixed(2), r.ccfri_total.toFixed(2),
        r.accb_total.toFixed(2), r.parent_paid_total.toFixed(2)].join(","));
    }
    const tot = monthRows.reduce((a, r) => ({
      g: a.g + r.gross_total, c: a.c + r.ccfri_total, ac: a.ac + r.accb_total, p: a.p + r.parent_paid_total, n: a.n + r.receipt_count,
    }), { g: 0, c: 0, ac: 0, p: 0, n: 0 });
    csv.push(["QUARTER TOTAL", "", tot.n, tot.g.toFixed(2), tot.c.toFixed(2), tot.ac.toFixed(2), tot.p.toFixed(2)].join(","));
    csv.push("");
    csv.push("## Per-receipt detail");
    csv.push("receipt_no,date,student,description,gross,ccfri_applied,accb_applied,parent_paid,refund,voided");
    for (const r of qReceipts) {
      csv.push([
        r.receipt_no, r.date,
        `"${(r.student_name_snapshot || "").replace(/"/g, '""')}"`,
        `"${(r.description || "").replace(/"/g, '""')}"`,
        (r.gross_amount ?? 0).toFixed(2),
        (r.ccfri_amount ?? 0).toFixed(2),
        (r.accb_amount  ?? 0).toFixed(2),
        (r.is_refund ? -r.amount : r.amount).toFixed(2),
        r.is_refund, r.voided,
      ].join(","));
    }
    const blob = new Blob([csv.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `ccfri-${fileSuffix}-Q${quarter}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  function stepYear(delta: number) { setYear((y) => y + delta); }

  return (
    <div>
      <h1>Reports</h1>
      <p className="subtitle">
        {mode === "fiscal_sep_aug"
          ? "Fiscal-year (Sep–Aug) totals for daycare bookkeeping. CRA annual tax receipts still use calendar year — see Annual Receipts."
          : "Calendar-year (Jan–Dec) totals. Export to CSV for your accountant."}
      </p>

      <div className="toolbar">
        <label style={{ fontSize: 13, color: "var(--muted)" }}>Mode:</label>
        <select value={mode} onChange={(e) => {
          const m = e.target.value as YearMode;
          setMode(m);
          setYear(m === "fiscal_sep_aug" ? currentFiscalYear(now) : now.getFullYear());
          setQuarter(m === "fiscal_sep_aug"
            ? fiscalQuarterOfMonth(now.getMonth() + 1)
            : ((Math.floor(now.getMonth() / 3) + 1) as Quarter));
        }}>
          <option value="fiscal_sep_aug">Fiscal (Sep–Aug)</option>
          <option value="calendar">Calendar (Jan–Dec)</option>
        </select>
        <div style={{ width: 1, height: 24, background: "var(--border)", margin: "0 4px" }} />
        <label style={{ fontSize: 13, color: "var(--muted)" }}>{mode === "fiscal_sep_aug" ? "Fiscal Year:" : "Year:"}</label>
        <button className="btn secondary" onClick={() => stepYear(-1)} style={{ padding: "2px 10px" }}>◀</button>
        <div style={{ minWidth: 100, textAlign: "center", fontWeight: 600 }}>{yearLabel}</div>
        <button className="btn secondary" onClick={() => stepYear(1)} style={{ padding: "2px 10px" }}>▶</button>
        <div className="grow" />
        <button className="btn secondary" onClick={exportCsv}>Export CSV</button>
      </div>

      <div className="kpi">
        <div className="card"><div className="lbl">Receipts in {yearLabel}</div><div className="val">{count}</div></div>
        <div className="card"><div className="lbl">Total Collected</div><div className="val">${grand.toFixed(2)}</div></div>
        <div className="card"><div className="lbl">Outstanding Items</div><div className="val">{outstanding.length}</div></div>
      </div>

      <h3>Monthly Totals</h3>
      {monthlyOrdered.length === 0 ? <div className="empty">No receipts yet for {yearLabel}.</div> : (
        <table className="data">
          <thead><tr><th>Month</th><th>Receipts</th><th style={{ textAlign: "right" }}>Total</th></tr></thead>
          <tbody>
            {monthlyOrdered.map((m) => (
              <tr key={m.ym}>
                <td>{m.ym}</td><td>{m.count}</td>
                <td style={{ textAlign: "right" }}>${m.total.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {subsidiesOn && (
        <>
          <h3 style={{ marginTop: 24 }}>BC Subsidy Reconciliation ({yearLabel})</h3>
          <p className="subtitle" style={{ marginTop: -6 }}>
            Cross-check against your monthly CCFRI claim and ACCB deposits from the Province of BC.
          </p>
          <div style={{ marginBottom: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn secondary" onClick={exportSubsidyCsv} disabled={subsidy.length === 0}>
              Export Subsidy CSV (full {mode === "fiscal_sep_aug" ? "FY" : "year"})
            </button>
            <div style={{ width: 1, height: 24, background: "var(--border)", margin: "0 4px" }} />
            <label style={{ fontSize: 13, color: "var(--muted)" }}>Quarter:</label>
            <select value={quarter} onChange={(e) => setQuarter(parseInt(e.target.value, 10) as Quarter)}>
              {([1,2,3,4] as Quarter[]).map((q) => (
                <option key={q} value={q}>{mode === "fiscal_sep_aug" ? FISCAL_QUARTER_LABEL[q] : CAL_QUARTER_LABEL[q]}</option>
              ))}
            </select>
            <button className="btn" onClick={exportCcfriQuarter} disabled={subsidy.length === 0}>
              Export CCFRI Quarter ({yearLabel} Q{quarter})
            </button>
          </div>
          {subsidy.length === 0 ? (
            <div className="empty">No subsidy data yet for {yearLabel}. Receipts created with subsidies enabled will populate this.</div>
          ) : (
            <table className="data">
              <thead><tr>
                <th>Month</th><th>Receipts</th>
                <th style={{ textAlign: "right" }}>Gross</th>
                <th style={{ textAlign: "right" }}>CCFRI claimed</th>
                <th style={{ textAlign: "right" }}>ACCB claimed</th>
                <th style={{ textAlign: "right" }}>Parent paid</th>
              </tr></thead>
              <tbody>
                {subsidyOrdered.map((r) => (
                  <tr key={`${r.year}-${r.month}`}>
                    <td>{MONTH_NAMES[r.month]} {r.year}</td>
                    <td>{r.receipt_count}</td>
                    <td style={{ textAlign: "right" }}>${r.gross_total.toFixed(2)}</td>
                    <td style={{ textAlign: "right", color: "#15803d" }}>${r.ccfri_total.toFixed(2)}</td>
                    <td style={{ textAlign: "right", color: "#15803d" }}>${r.accb_total.toFixed(2)}</td>
                    <td style={{ textAlign: "right", fontWeight: 600 }}>${r.parent_paid_total.toFixed(2)}</td>
                  </tr>
                ))}
                <tr style={{ borderTop: "2px solid #111", fontWeight: 700 }}>
                  <td>Total</td>
                  <td>{subsidy.reduce((a, r) => a + r.receipt_count, 0)}</td>
                  <td style={{ textAlign: "right" }}>${subTot.gross.toFixed(2)}</td>
                  <td style={{ textAlign: "right", color: "#15803d" }}>${subTot.ccfri.toFixed(2)}</td>
                  <td style={{ textAlign: "right", color: "#15803d" }}>${subTot.accb.toFixed(2)}</td>
                  <td style={{ textAlign: "right" }}>${subTot.paid.toFixed(2)}</td>
                </tr>
              </tbody>
            </table>
          )}
        </>
      )}

      <h3 style={{ marginTop: 24 }}>Outstanding Balances</h3>
      {outstanding.length === 0 ? <div className="empty">No outstanding pending fees recorded. ✅</div> : (
        <table className="data">
          <thead><tr><th>#</th><th>Date</th><th>Student</th><th>Pending</th><th>Notes</th></tr></thead>
          <tbody>
            {outstanding.map((r) => (
              <tr key={r.id}>
                <td>{r.receipt_no}</td><td>{r.date}</td><td>{r.student_name_snapshot}</td>
                <td>${r.pending_amount.toFixed(2)}</td><td>{r.comments || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
