import { useEffect, useState } from "react";
import { listReceipts, monthlyTotals, subsidyReconciliation, getSettings,
  type SubsidyMonthRow } from "../lib/db";
import type { Receipt, SettingsMap } from "../types";

const MONTH_NAMES = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

type Quarter = 1 | 2 | 3 | 4;
const QUARTER_MONTHS: Record<Quarter, number[]> = { 1: [1,2,3], 2: [4,5,6], 3: [7,8,9], 4: [10,11,12] };
const QUARTER_LABEL: Record<Quarter, string> = { 1: "Q1 (Jan–Mar)", 2: "Q2 (Apr–Jun)", 3: "Q3 (Jul–Sep)", 4: "Q4 (Oct–Dec)" };

export default function Reports() {
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const [monthly, setMonthly] = useState<{ ym: string; count: number; total: number }[]>([]);
  const [all, setAll] = useState<Receipt[]>([]);
  const [settings, setSettings] = useState<SettingsMap>({});
  const [subsidy, setSubsidy] = useState<SubsidyMonthRow[]>([]);
  const [quarter, setQuarter] = useState<Quarter>(((Math.floor(new Date().getMonth() / 3) + 1) as Quarter));

  async function refresh() {
    const [m, r, s, sub] = await Promise.all([
      monthlyTotals(year),
      listReceipts({ year }),
      getSettings(),
      subsidyReconciliation(year),
    ]);
    setMonthly(m);
    setAll(r);
    setSettings(s);
    setSubsidy(sub);
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [year]);

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
    a.href = url; a.download = `receipts-${year}.csv`; a.click();
    URL.revokeObjectURL(url);
  }
  function exportSubsidyCsv() {
    const header = ["year","month","receipt_count","gross_total","ccfri_total","accb_total","parent_paid_total"];
    const lines = [header.join(",")].concat(
      subsidy.map((r) => [r.year, r.month, r.receipt_count,
        r.gross_total.toFixed(2), r.ccfri_total.toFixed(2),
        r.accb_total.toFixed(2), r.parent_paid_total.toFixed(2)].join(","))
    );
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `subsidy-reconciliation-${year}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  // CCFRI quarterly export — filters subsidy rows to the 3 months in the
  // selected quarter and per-receipt rows for that quarter. The exact
  // column shape required by the BC Ministry can vary by intake form;
  // this CSV captures everything they typically ask for so it can be
  // copy-pasted or reshaped into the official template.
  function exportCcfriQuarter() {
    const months = QUARTER_MONTHS[quarter];
    const qReceipts = all.filter((r) => {
      if (r.voided) return false;
      const m = parseInt(r.date.slice(5, 7), 10);
      return months.includes(m);
    });
    const monthRows = subsidy
      .filter((r) => months.includes(r.month))
      .sort((a, b) => a.month - b.month);

    const csv: string[] = [];
    csv.push(`# CCFRI Quarterly Reconciliation - ${year} ${QUARTER_LABEL[quarter]}`);
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
    a.href = url; a.download = `ccfri-${year}-Q${quarter}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <h1>Reports</h1>
      <p className="subtitle">Yearly totals and outstanding balances. Export to CSV for your accountant.</p>

      <div className="toolbar">
        <label style={{ fontSize: 13, color: "var(--muted)" }}>Year:</label>
        <input type="number" value={year} onChange={(e) => setYear(parseInt(e.target.value || "0", 10))} style={{ width: 100 }} />
        <div className="grow" />
        <button className="btn secondary" onClick={exportCsv}>Export CSV</button>
      </div>

      <div className="kpi">
        <div className="card"><div className="lbl">Receipts in {year}</div><div className="val">{count}</div></div>
        <div className="card"><div className="lbl">Total Collected</div><div className="val">${grand.toFixed(2)}</div></div>
        <div className="card"><div className="lbl">Outstanding Items</div><div className="val">{outstanding.length}</div></div>
      </div>

      <h3>Monthly Totals</h3>
      {monthly.length === 0 ? <div className="empty">No receipts yet for {year}.</div> : (
        <table className="data">
          <thead><tr><th>Month</th><th>Receipts</th><th style={{ textAlign: "right" }}>Total</th></tr></thead>
          <tbody>
            {monthly.map((m) => (
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
          <h3 style={{ marginTop: 24 }}>BC Subsidy Reconciliation ({year})</h3>
          <p className="subtitle" style={{ marginTop: -6 }}>
            Cross-check against your monthly CCFRI claim and ACCB deposits from the Province of BC.
          </p>
          <div style={{ marginBottom: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn secondary" onClick={exportSubsidyCsv} disabled={subsidy.length === 0}>
              Export Subsidy CSV (full year)
            </button>
            <div style={{ width: 1, height: 24, background: "var(--border)", margin: "0 4px" }} />
            <label style={{ fontSize: 13, color: "var(--muted)" }}>Quarter:</label>
            <select value={quarter} onChange={(e) => setQuarter(parseInt(e.target.value, 10) as Quarter)}>
              {([1,2,3,4] as Quarter[]).map((q) => <option key={q} value={q}>{QUARTER_LABEL[q]}</option>)}
            </select>
            <button className="btn" onClick={exportCcfriQuarter} disabled={subsidy.length === 0}>
              Export CCFRI Quarter ({year} Q{quarter})
            </button>
          </div>
          {subsidy.length === 0 ? (
            <div className="empty">No subsidy data yet for {year}. Receipts created with subsidies enabled will populate this.</div>
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
                {subsidy.map((r) => (
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
