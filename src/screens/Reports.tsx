import { useEffect, useState } from "react";
import { listReceipts, monthlyTotals } from "../lib/db";
import type { Receipt } from "../types";

export default function Reports() {
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const [monthly, setMonthly] = useState<{ ym: string; count: number; total: number }[]>([]);
  const [all, setAll] = useState<Receipt[]>([]);

  async function refresh() {
    setMonthly(await monthlyTotals(year));
    setAll(await listReceipts({ year }));
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [year]);

  const grand = monthly.reduce((a, m) => a + m.total, 0);
  const count = monthly.reduce((a, m) => a + m.count, 0);
  const outstanding = all.filter((r) => !r.voided && r.pending_amount > 0);

  function exportCsv() {
    const header = ["receipt_no","date","student","description","amount","pending","comments","voided"];
    const lines = [header.join(",")].concat(
      all.map((r) => [
        r.receipt_no, r.date,
        `"${(r.student_name_snapshot || "").replace(/"/g, '""')}"`,
        `"${(r.description || "").replace(/"/g, '""')}"`,
        r.amount.toFixed(2), r.pending_amount.toFixed(2),
        `"${(r.comments || "").replace(/"/g, '""')}"`, r.voided,
      ].join(","))
    );
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `receipts-${year}.csv`; a.click();
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
