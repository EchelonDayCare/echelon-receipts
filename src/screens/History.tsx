import { useEffect, useMemo, useState } from "react";
import { getSettings, listReceipts, voidReceipt } from "../lib/db";
import type { Receipt, SettingsMap } from "../types";
import { printReceipt, saveReceiptPdf } from "../lib/receipt";

const MONTHS = ["All","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export default function History() {
  const [rows, setRows] = useState<Receipt[]>([]);
  const [search, setSearch] = useState("");
  const [year, setYear] = useState<number | "">("");
  const [month, setMonth] = useState<number | "">("");
  const [settings, setSettings] = useState<SettingsMap>({});

  async function refresh() {
    setRows(await listReceipts({
      search: search || undefined,
      year: year === "" ? undefined : year,
      month: month === "" ? undefined : month,
    }));
    setSettings(await getSettings());
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [search, year, month]);

  const total = useMemo(
    () => rows.filter((r) => !r.voided).reduce((acc, r) => acc + r.amount, 0),
    [rows]
  );
  const years = useMemo(() => {
    const ys = new Set<number>();
    rows.forEach((r) => ys.add(parseInt(r.date.slice(0, 4), 10)));
    return Array.from(ys).sort((a, b) => b - a);
  }, [rows]);

  return (
    <div>
      <h1>Receipt History</h1>
      <p className="subtitle">{rows.length} receipt(s) · Total: ${total.toFixed(2)}</p>

      <div className="toolbar">
        <input className="grow" placeholder="Search by student, description, comment, receipt #" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={year} onChange={(e) => setYear(e.target.value ? parseInt(e.target.value, 10) : "")}>
          <option value="">All years</option>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <select value={month} onChange={(e) => setMonth(e.target.value === "" ? "" : parseInt(e.target.value, 10))}>
          {MONTHS.map((m, i) => <option key={m} value={i === 0 ? "" : i}>{m}</option>)}
        </select>
      </div>

      {rows.length === 0 ? (
        <div className="empty">No receipts match the current filters.</div>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>#</th><th>Date</th><th>Student</th><th>Description</th>
              <th style={{ textAlign: "right" }}>Amount</th>
              <th>Comments</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.voided ? "voided" : ""}>
                <td>{r.receipt_no}</td>
                <td>{r.date}</td>
                <td>{r.student_name_snapshot}</td>
                <td>{r.description}</td>
                <td style={{ textAlign: "right" }}>${r.amount.toFixed(2)}</td>
                <td>{r.comments || ""}{r.pending_amount > 0 ? ` (Pending $${r.pending_amount.toFixed(2)})` : ""}</td>
                <td style={{ textAlign: "right" }}>
                  <button className="btn ghost" onClick={() => printReceipt(r, settings)}>Print</button>
                  <button className="btn ghost" onClick={async () => {
                    try {
                      const p = await saveReceiptPdf(r, settings);
                      alert(p ? "Saved PDF:\n" + p : "Set a PDF folder in Settings first.");
                    } catch (e) { alert("Save failed: " + e); }
                  }}>Save PDF</button>
                  {!r.voided && (
                    <button className="btn ghost" style={{ color: "var(--danger)" }}
                      onClick={async () => { if (confirm(`Void receipt #${r.receipt_no}?`)) { await voidReceipt(r.id); refresh(); } }}>
                      Void
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
