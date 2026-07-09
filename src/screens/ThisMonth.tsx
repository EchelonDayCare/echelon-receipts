import { showAlert } from "../lib/dialogs";
import { useEffect, useMemo, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  listStudents, listReceipts, nextReceiptNo, createReceipt,
  getSettings, subsidiesEnabled, computeFeeBreakdown, getAccbForMonthBulk, markEmailed,
} from "../lib/db";
import type { Student, Receipt, SettingsMap } from "../types";
import { saveReceiptPdf } from "../lib/receipt";
import { sendReceiptEmail, parseRecipients } from "../lib/email";
import { yieldToUI } from "../lib/lazy";

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

interface RowState {
  student: Student;
  receipt: Receipt | null;       // existing non-voided receipt for this fee month, if any
  parentEmails: string[];
  computedAmount: number;        // what we'd charge if we generated now
  breakdown: { gross: number; ccfri: number; accb: number } | null;
  busy: boolean;
  lastResult: { kind: "ok" | "err"; text: string } | null;
}

function descriptionFor(month: string, year: number): string {
  return `${month} ${year} Tuition Fee`;
}

// Match a receipt to a fee month by description token, fallback to date YYYY-MM
function receiptMatchesFeeMonth(r: Receipt, month: string, year: number): boolean {
  if (r.voided) return false;
  if (r.description && r.description.toLowerCase().includes(`${month.toLowerCase()} ${year}`)) return true;
  // fallback: same Jan-Dec
  const ymPrefix = `${year}-${String(MONTHS.indexOf(month) + 1).padStart(2, "0")}`;
  return r.date.startsWith(ymPrefix);
}

export default function ThisMonth() {
  const today = new Date();
  const [month, setMonth] = useState<string>(MONTHS[today.getMonth()]);
  const [year, setYear] = useState<number>(today.getFullYear());
  const [settings, setSettings] = useState<SettingsMap>({});
  const [rows, setRows] = useState<RowState[]>([]);
  const [loading, setLoading] = useState(true);
  const [showReview, setShowReview] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [batchSending, setBatchSending] = useState(false);

  async function refresh() {
    setLoading(true);
    const monthIdx = MONTHS.indexOf(month) + 1;
    const subsOn = subsidiesEnabled(await getSettings());
    const [studs, s, allReceipts, accbMap] = await Promise.all([
      listStudents(year, true),
      getSettings(),
      listReceipts({ year }),
      subsOn ? getAccbForMonthBulk(year, monthIdx) : Promise.resolve(new Map<number, number>()),
    ]);
    setSettings(s);
    // Bucket receipts per-student so the inner loop is O(1) lookup.
    const receiptByStudent = new Map<number, Receipt>();
    for (const x of allReceipts) {
      if (receiptMatchesFeeMonth(x, month, year)) receiptByStudent.set(x.student_id, x);
    }
    const next: RowState[] = [];
    for (const stu of studs) {
      const r = receiptByStudent.get(stu.id) || null;
      let bk: RowState["breakdown"] = null;
      let amt = parseFloat(s.default_fee || "0") || 0;
      if (subsidiesEnabled(s)) {
        const accb = accbMap.get(stu.id) ?? 0;
        const fb = computeFeeBreakdown(stu, s, accb);
        bk = { gross: fb.gross, ccfri: fb.ccfri, accb: fb.accb };
        if (fb.gross > 0) amt = fb.parent_pays;
      }
      next.push({
        student: stu,
        receipt: r,
        parentEmails: parseRecipients(stu.email || ""),
        computedAmount: amt,
        breakdown: bk,
        busy: false,
        lastResult: null,
      });
    }
    setRows(next);
    setLoading(false);
  }
  useEffect(() => { refresh();   }, [month, year]);

  const counts = useMemo(() => {
    let issued = 0, sent = 0, missingEmail = 0, pending = 0;
    rows.forEach(r => {
      if (r.receipt) {
        issued++;
        if (r.receipt.emailed_at) sent++;
      } else {
        pending++;
        if (r.parentEmails.length === 0) missingEmail++;
      }
    });
    return { issued, sent, missingEmail, pending, total: rows.length };
  }, [rows]);

  async function generateOne(idx: number) {
    setRows(cur => cur.map((r, i) => i === idx ? { ...r, busy: true, lastResult: null } : r));
    try {
      const r = rows[idx]; const stu = r.student;
      const monthIdx = MONTHS.indexOf(month);
      const receiptNo = await nextReceiptNo();
      const date = new Date(year, monthIdx, 1).toISOString().slice(0, 10);
      await createReceipt({
        receipt_no: receiptNo, date, student_id: stu.id,
        student_name_snapshot: stu.name,
        father_name_snapshot: stu.father_name,
        mother_name_snapshot: stu.mother_name,
        description: descriptionFor(month, year),
        amount: r.computedAmount,
        pending_amount: 0,
        comments: null,
        is_refund: 0,
        gross_amount: r.breakdown?.gross ?? null,
        ccfri_amount: r.breakdown?.ccfri ?? null,
        accb_amount:  r.breakdown?.accb ?? null,
      });
      // bumpReceiptNo is done inside createReceipt
      await refresh();
    } catch (e: any) {
      setRows(cur => cur.map((r, i) => i === idx ? { ...r, busy: false, lastResult: { kind: "err", text: e?.message || String(e) } } : r));
    }
  }

  async function openExisting(idx: number) {
    const r = rows[idx].receipt; if (!r) return;
    try {
      const p = await saveReceiptPdf(r, settings);
      if (p) await openPath(p);
      else void showAlert("Set a PDF folder in Settings to archive PDFs.");
    } catch (e: any) { void showAlert("Open failed: " + (e?.message || e)); }
  }

  async function emailOne(idx: number) {
    const r = rows[idx]; if (!r.receipt) return;
    if (r.parentEmails.length === 0) { void showAlert("No email on file."); return; }
    setRows(cur => cur.map((x, i) => i === idx ? { ...x, busy: true, lastResult: null } : x));
    try {
      await sendReceiptEmail({ receipt: r.receipt, recipients: r.parentEmails, settings });
      await markEmailed(r.receipt.id, r.parentEmails);
      await refresh();
    } catch (e: any) {
      setRows(cur => cur.map((x, i) => i === idx ? { ...x, busy: false, lastResult: { kind: "err", text: e?.message || String(e) } } : x));
    }
  }

  // ----- Batch send: open review modal first, then loop -----
  const readyToSend = rows.filter(r => r.receipt && !r.receipt.emailed_at && r.parentEmails.length > 0);
  const skipped = rows.filter(r => r.receipt && !r.receipt.emailed_at && r.parentEmails.length === 0);

  async function doBatchSend() {
    if (batchSending) return;
    setBatchSending(true);
    try {
      setShowReview(false);
      setBatchProgress({ done: 0, total: readyToSend.length, current: readyToSend[0]?.student.name || "" });
      await yieldToUI();
      let done = 0;
      for (let i = 0; i < readyToSend.length; i++) {
        const row = readyToSend[i];
        setBatchProgress({ done, total: readyToSend.length, current: row.student.name });
        await yieldToUI();
        try {
          await sendReceiptEmail({ receipt: row.receipt!, recipients: row.parentEmails, settings });
          await markEmailed(row.receipt!.id, row.parentEmails);
        } catch (e: any) {
          setRows(cur => cur.map(x => x.student.id === row.student.id ? { ...x, lastResult: { kind: "err", text: e?.message || String(e) } } : x));
        }
        done++;
        await yieldToUI();
      }
      setBatchProgress({ done, total: readyToSend.length, current: "" });
      await refresh();
      setTimeout(() => setBatchProgress(null), 2500);
    } finally {
      setBatchSending(false);
    }
  }

  if (loading) return <div><h1>This Month</h1><p className="subtitle">Loading…</p></div>;

  return (
    <div>
      <h1>This Month</h1>
      <p className="subtitle">Issue and send receipts for one fee month, one row at a time or in a batch.</p>

      <div className="toolbar">
        <label style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em" }}>Fee month</label>
        <select value={month} onChange={(e) => setMonth(e.target.value)}>
          {MONTHS.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <input type="number" style={{ width: 100 }} value={year} onChange={(e) => setYear(parseInt(e.target.value || "0", 10))} />
        <div className="grow"></div>
        <button className="btn secondary" onClick={refresh}>Refresh</button>
        <button className="btn"
          disabled={readyToSend.length === 0 || batchSending}
          title={readyToSend.length === 0 ? "Nothing to send (either all are sent, all have no email, or no receipts have been generated)" : ""}
          onClick={() => setShowReview(true)}>
          {batchSending ? "Sending…" : `Send all unsent (${readyToSend.length})`}
        </button>
      </div>

      <div className="month-summary">
        <span><strong>{counts.issued}</strong> issued / {counts.total}</span>
        <span><strong>{counts.sent}</strong> emailed</span>
        <span><strong>{counts.pending}</strong> not started</span>
        {counts.missingEmail > 0 && <span style={{ color: "var(--danger)" }}><strong>{counts.missingEmail}</strong> missing email</span>}
      </div>

      {rows.length === 0 ? (
        <div className="empty">No active students for {year}. Add students on the Students tab.</div>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Student</th>
              <th>Parent email</th>
              <th>Status</th>
              <th style={{ textAlign: "right" }}>Amount</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => {
              const status = r.receipt
                ? (r.receipt.emailed_at ? { key: "sent", label: "Sent" } : { key: "saved", label: "Saved" })
                : (r.parentEmails.length === 0 ? { key: "voided", label: "Missing email" } : { key: "saved", label: "Not started" });
              return (
                <tr key={r.student.id}>
                  <td>{r.student.name}</td>
                  <td>{r.parentEmails.join(", ") || <em style={{ color: "var(--muted)" }}>— none —</em>}</td>
                  <td>
                    <span className={`status-badge ${status.key}`}>{status.label}</span>
                    {r.lastResult?.kind === "err" && <span className="status-badge voided" title={r.lastResult.text} style={{ marginLeft: 4, color: "var(--danger)" }}>Failed</span>}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {r.receipt ? (
                      `$${r.receipt.amount.toFixed(2)}`
                    ) : (
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={r.computedAmount}
                        disabled={r.busy || batchSending}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          const newAmt = isNaN(v) ? 0 : v;
                          setRows((prev) => prev.map((row, i) => {
                            if (i !== idx) return row;
                            // If the user overrode the amount away from the auto-computed
                            // breakdown, drop the breakdown snapshot so the printed receipt
                            // doesn't show gross/CCFRI/ACCB totals that don't add up to the
                            // amount actually charged.
                            const drift = row.breakdown && Math.abs(newAmt - row.computedAmount) > 0.01
                              ? null
                              : row.breakdown;
                            return { ...row, computedAmount: newAmt, breakdown: drift };
                          }));
                        }}
                        style={{ width: 90, textAlign: "right", padding: "4px 6px" }}
                      />
                    )}
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {!r.receipt && (
                      <button className="btn" disabled={r.busy} onClick={() => generateOne(idx)}>
                        {r.busy ? "Generating…" : "Generate"}
                      </button>
                    )}
                    {r.receipt && (
                      <>
                        <button className="btn ghost" onClick={() => openExisting(idx)}>Open PDF</button>
                        {!r.receipt.emailed_at && (
                          <button className="btn ghost"
                            disabled={r.busy || r.parentEmails.length === 0 || batchSending}
                            onClick={() => emailOne(idx)}>
                            {r.busy ? "Sending…" : "Email"}
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {/* Review modal */}
      {showReview && (
        <div className="modal-bg" onClick={() => setShowReview(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>Review before sending</h2>
            <p className="subtitle">
              You are about to email <strong>{readyToSend.length}</strong> receipt(s) for <strong>{month} {year}</strong>.
              {skipped.length > 0 && <> {skipped.length} student(s) will be <strong>skipped</strong> because they have no email on file.</>}
            </p>
            <div style={{ maxHeight: 340, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
              <table className="data" style={{ border: 0 }}>
                <thead>
                  <tr><th>Student</th><th>Will be sent to</th><th style={{ textAlign: "right" }}>Amount</th></tr>
                </thead>
                <tbody>
                  {readyToSend.map(r => (
                    <tr key={r.student.id}>
                      <td>{r.student.name}</td>
                      <td>{r.parentEmails.join(", ")}</td>
                      <td style={{ textAlign: "right" }}>${r.receipt!.amount.toFixed(2)}</td>
                    </tr>
                  ))}
                  {skipped.map(r => (
                    <tr key={"sk-" + r.student.id} style={{ background: "#fffbeb" }}>
                      <td>{r.student.name}</td>
                      <td style={{ color: "var(--danger)" }}>⚠️ skipped — no email</td>
                      <td style={{ textAlign: "right" }}>—</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16 }}>
              <button className="btn secondary" onClick={() => setShowReview(false)} disabled={batchSending}>Cancel</button>
              <button className="btn" onClick={doBatchSend} disabled={batchSending}>
                {batchSending ? "Sending…" : `Send ${readyToSend.length} now`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Progress toast */}
      {batchProgress && (
        <div className="toast">
          <div>
            {batchProgress.done < batchProgress.total
              ? <>📨 Sending {batchProgress.done + 1} of {batchProgress.total}{batchProgress.current ? " — " + batchProgress.current : ""}…</>
              : <>✅ Sent {batchProgress.total} receipt(s).</>}
          </div>
          <div className="progress" aria-label="batch progress">
            <div className="progress-fill" style={{ width: `${batchProgress.total === 0 ? 100 : (batchProgress.done / batchProgress.total) * 100}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}
