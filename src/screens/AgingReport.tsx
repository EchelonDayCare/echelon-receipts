import { useEffect, useState } from "react";
import { computeAging, agingToCsv, settleAllForStudent, type AgingReport } from "../lib/aging";
import { getSettings } from "../lib/db";
import { h } from "../lib/html";
import { printHtmlDocument } from "../lib/print";
import { todayLocalIso } from "../lib/localDate";

function todayIso() { return todayLocalIso(); }

export default function AgingReportScreen() {
  const [asOf, setAsOf] = useState(todayIso());
  const [rep, setRep] = useState<AgingReport | null>(null);
  const [daycareName, setDaycareName] = useState<string>("");
  const [settlingId, setSettlingId] = useState<number | null>(null);
  const [confirmSettle, setConfirmSettle] = useState<{ studentId: number; name: string; total: number } | null>(null);

  async function refresh() {
    setRep(await computeAging(asOf));
    setDaycareName((await getSettings()).daycare_name || "");
  }
  useEffect(() => { refresh();   }, [asOf]);

  function exportCsv() {
    if (!rep) return;
    const blob = new Blob(["\uFEFF" + agingToCsv(rep)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `aging-${asOf}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  function printReport() {
    if (!rep) return;
    const rowsHtml = rep.rows.map((r) => `<tr>
      <td>${h(r.student_name)}<div style="font-size:10px;color:#666">${h(r.father_name || r.mother_name || "")}</div></td>
      <td>${h(r.oldest_unpaid_date)}</td>
      <td style="text-align:right;color:${r.bucket.future > 0 ? "#b45309" : "#000"}">$${r.bucket.future.toFixed(2)}</td>
      <td style="text-align:right">$${r.bucket.current.toFixed(2)}</td>
      <td style="text-align:right">$${r.bucket.d31_60.toFixed(2)}</td>
      <td style="text-align:right">$${r.bucket.d61_90.toFixed(2)}</td>
      <td style="text-align:right;color:#b91c1c">$${r.bucket.d90plus.toFixed(2)}</td>
      <td style="text-align:right;font-weight:600">$${r.bucket.total.toFixed(2)}</td>
    </tr>`).join("");
    const futureBanner = rep.totals.future > 0
      ? `<div style="background:#fef3c7;border:1px solid #f59e0b;padding:6px 8px;margin:6px 0;font-size:11px">⚠ $${rep.totals.future.toFixed(2)} is future-dated (data-entry errors). Verify receipt dates before follow-up.</div>`
      : "";
    const html = `<!doctype html><html><head><meta charset="utf-8">
      <title>Aging A/R — as of ${h(asOf)}</title>
      <style>
        body { font-family: -apple-system, system-ui, sans-serif; margin: 24px; color: #111; }
        h1 { margin: 0; font-size: 18px; }
        .sub { color: #555; font-size: 12px; margin: 4px 0 12px; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th, td { border: 1px solid #999; padding: 4px 6px; text-align: left; }
        th { background: #eee; }
        @media print { @page { size: letter landscape; margin: 0.4in; } }
      </style></head><body>
      <h1>${h(daycareName)} — Outstanding Balances (Aging)</h1>
      <div class="sub">As of ${h(asOf)} • ${rep.rows.length} families with balance • Total $${rep.totals.total.toFixed(2)}</div>
      ${futureBanner}
      <table>
        <thead><tr>
          <th>Family / Child</th><th>Oldest unpaid</th>
          <th style="text-align:right">Future ⚠</th>
          <th style="text-align:right">Current (0-30)</th>
          <th style="text-align:right">31-60</th>
          <th style="text-align:right">61-90</th>
          <th style="text-align:right">90+</th>
          <th style="text-align:right">Total</th>
        </tr></thead>
        <tbody>${rowsHtml}
        <tr style="border-top:2px solid #111;font-weight:700">
          <td colspan="2">TOTAL</td>
          <td style="text-align:right;color:${rep.totals.future > 0 ? "#b45309" : "#000"}">$${rep.totals.future.toFixed(2)}</td>
          <td style="text-align:right">$${rep.totals.current.toFixed(2)}</td>
          <td style="text-align:right">$${rep.totals.d31_60.toFixed(2)}</td>
          <td style="text-align:right">$${rep.totals.d61_90.toFixed(2)}</td>
          <td style="text-align:right;color:#b91c1c">$${rep.totals.d90plus.toFixed(2)}</td>
          <td style="text-align:right">$${rep.totals.total.toFixed(2)}</td>
        </tr></tbody>
      </table>
      </body></html>`;
    void printHtmlDocument(html);
  }

  return (
    <div>
      <h1>Aging Report (A/R)</h1>
      <p className="subtitle">Outstanding balances by family, bucketed by age. Use for follow-up calls and bad-debt review.</p>

      <div className="toolbar">
        <label style={{ fontSize: 13, color: "var(--muted)" }}>As of:</label>
        <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        <button className="btn secondary" onClick={() => setAsOf(todayIso())}>Today</button>
        <div className="grow" />
        <button className="btn secondary" onClick={exportCsv} disabled={!rep || rep.rows.length === 0}>Export CSV</button>
        <button className="btn" onClick={printReport} disabled={!rep || rep.rows.length === 0}>Print PDF</button>
      </div>

      {rep && (
        <div className="kpi">
          <div className="card"><div className="lbl">Families with balance</div><div className="val">{rep.rows.length}</div></div>
          <div className="card"><div className="lbl">Total outstanding</div><div className="val">${rep.totals.total.toFixed(2)}</div></div>
          <div className="card"><div className="lbl">90+ days</div><div className="val" style={{ color: rep.totals.d90plus > 0 ? "#b91c1c" : undefined }}>${rep.totals.d90plus.toFixed(2)}</div></div>
        </div>
      )}

      {rep && rep.totals.future > 0 && (
        <div style={{ background: "#fef3c7", border: "1px solid #f59e0b", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
          ⚠ ${rep.totals.future.toFixed(2)} in unpaid receipts is <strong>dated after {asOf}</strong>. These are almost certainly data-entry errors (typo in the receipt date). Review the flagged rows below and correct the receipt date before relying on the aging totals.
        </div>
      )}

      {rep && rep.rows.length === 0 ? (
        <div className="empty">No outstanding balances as of {asOf}. ✅</div>
      ) : rep && (
        <table className="data">
          <thead><tr>
            <th>Family / Child</th>
            <th>Email</th>
            <th>Oldest unpaid</th>
            <th>#</th>
            <th style={{ textAlign: "right" }}>Future ⚠</th>
            <th style={{ textAlign: "right" }}>Current (0-30)</th>
            <th style={{ textAlign: "right" }}>31-60</th>
            <th style={{ textAlign: "right" }}>61-90</th>
            <th style={{ textAlign: "right" }}>90+</th>
            <th style={{ textAlign: "right" }}>Total</th>
            <th></th>
          </tr></thead>
          <tbody>
            {rep.rows.map((r) => (
              <tr key={r.student_id}>
                <td>
                  <div style={{ fontWeight: 600 }}>{r.student_name}</div>
                  <div style={{ fontSize: 11, color: "var(--muted)" }}>
                    {r.father_name || r.mother_name || ""}
                  </div>
                </td>
                <td style={{ fontSize: 12 }}>{r.email || ""}</td>
                <td>{r.oldest_unpaid_date}</td>
                <td>{r.receipt_count}</td>
                <td style={{ textAlign: "right", color: r.bucket.future > 0 ? "#b45309" : undefined, fontWeight: r.bucket.future > 0 ? 600 : undefined }}>${r.bucket.future.toFixed(2)}</td>
                <td style={{ textAlign: "right" }}>${r.bucket.current.toFixed(2)}</td>
                <td style={{ textAlign: "right" }}>${r.bucket.d31_60.toFixed(2)}</td>
                <td style={{ textAlign: "right" }}>${r.bucket.d61_90.toFixed(2)}</td>
                <td style={{ textAlign: "right", color: r.bucket.d90plus > 0 ? "#b91c1c" : undefined, fontWeight: r.bucket.d90plus > 0 ? 600 : undefined }}>
                  ${r.bucket.d90plus.toFixed(2)}
                </td>
                <td style={{ textAlign: "right", fontWeight: 600 }}>${r.bucket.total.toFixed(2)}</td>
                <td>
                  <button
                    className="btn secondary"
                    style={{ fontSize: 11, padding: "2px 8px" }}
                    disabled={settlingId === r.student_id}
                    onClick={() => setConfirmSettle({ studentId: r.student_id, name: r.student_name, total: r.bucket.total })}
                    title="Mark this family's pending balances as settled (as of today)"
                  >
                    Settle
                  </button>
                </td>
              </tr>
            ))}
            <tr style={{ borderTop: "2px solid #111", fontWeight: 700 }}>
              <td colSpan={4}>TOTAL</td>
              <td style={{ textAlign: "right", color: rep.totals.future > 0 ? "#b45309" : undefined }}>${rep.totals.future.toFixed(2)}</td>
              <td style={{ textAlign: "right" }}>${rep.totals.current.toFixed(2)}</td>
              <td style={{ textAlign: "right" }}>${rep.totals.d31_60.toFixed(2)}</td>
              <td style={{ textAlign: "right" }}>${rep.totals.d61_90.toFixed(2)}</td>
              <td style={{ textAlign: "right", color: rep.totals.d90plus > 0 ? "#b91c1c" : undefined }}>${rep.totals.d90plus.toFixed(2)}</td>
              <td style={{ textAlign: "right" }}>${rep.totals.total.toFixed(2)}</td>
              <td></td>
            </tr>
          </tbody>
        </table>
      )}

      {confirmSettle && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
          }}
          onClick={() => setConfirmSettle(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: "#fff", borderRadius: 8, padding: 20, maxWidth: 460, boxShadow: "0 12px 40px rgba(0,0,0,0.2)" }}
          >
            <h3 style={{ marginTop: 0 }}>Mark ${confirmSettle.total.toFixed(2)} as settled?</h3>
            <p style={{ fontSize: 13, color: "var(--muted)" }}>
              This will clear the pending balance for <strong>{confirmSettle.name}</strong> across
              all of their currently-outstanding receipts. The receipts themselves will remain
              in the archive with a <code>settled_at</code> stamp of today so historical
              aging reports for past dates stay accurate.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
              <button className="btn secondary" onClick={() => setConfirmSettle(null)}>Cancel</button>
              <button
                className="btn"
                disabled={settlingId !== null}
                onClick={async () => {
                  const t = confirmSettle;
                  setSettlingId(t.studentId);
                  try {
                    await settleAllForStudent(t.studentId);
                    await refresh();
                  } catch (e) {
                    console.error("[aging] settle failed", e);
                    alert("Failed to settle balance — see console for details.");
                  } finally {
                    setSettlingId(null);
                    setConfirmSettle(null);
                  }
                }}
              >
                Yes, mark settled
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
