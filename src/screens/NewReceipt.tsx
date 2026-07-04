import { showAlert } from "../lib/dialogs";
import { useEffect, useMemo, useState } from "react";
import {
  listStudents, listYears, nextReceiptNo, createReceipt, getSettings,
  computeFeeBreakdown, getAccbForMonth, subsidiesEnabled,
} from "../lib/db";
import type { Student, SettingsMap, FeeBreakdown, Receipt } from "../types";
import { printReceipt, saveReceiptPdf, buildReceiptHtml } from "../lib/receipt";
import { sendReceiptEmail, parseRecipients } from "../lib/email";
import { markEmailed } from "../lib/db";

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

export default function NewReceipt() {
  const today = new Date();
  const [years, setYears] = useState<number[]>([]);
  const [year, setYear] = useState<number>(today.getFullYear());
  const [students, setStudents] = useState<Student[]>([]);
  const [studentId, setStudentId] = useState<number | "">("");
  const [receiptNo, setReceiptNo] = useState<number>(1001);
  const [date, setDate] = useState<string>(today.toISOString().slice(0, 10));
  const [month, setMonth] = useState<string>(MONTHS[today.getMonth()]);
  const [feeYear, setFeeYear] = useState<number>(today.getFullYear());
  const [amount, setAmount] = useState<string>("485");
  const [pending, setPending] = useState<string>("0");
  const [comments, setComments] = useState<string>("");
  const [description, setDescription] = useState<string>("");
  const [descTouched, setDescTouched] = useState(false);
  const [isRefund, setIsRefund] = useState<boolean>(false);
  const [settings, setSettings] = useState<SettingsMap>({});
  const [accbThisMonth, setAccbThisMonth] = useState<number>(0);
  const [amountTouched, setAmountTouched] = useState(false);
  const [preview, setPreview] = useState<{ html: string; receipt: Receipt; recipients: string[]; settings: SettingsMap } | null>(null);
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);

  async function refresh() {
    const ys = await listYears();
    setYears(ys.length ? ys : [today.getFullYear()]);
    const useYear = ys.includes(year) ? year : (ys[0] ?? today.getFullYear());
    setYear(useYear);
    const ss = await listStudents(useYear);
    setStudents(ss);
    const s = await getSettings();
    setSettings(s);
    setAmount(s.default_fee || "485");
    setReceiptNo(await nextReceiptNo());
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, []);
  useEffect(() => { (async () => setStudents(await listStudents(year)))(); }, [year]);
  useEffect(() => {
    if (!descTouched) setDescription(`${month} ${feeYear} Tuition Fee`);
  }, [month, feeYear, descTouched]);

  const student = useMemo(() => students.find((s) => s.id === studentId) || null, [students, studentId]);

  // ACCB lookup whenever student / fee month / fee year changes
  useEffect(() => {
    (async () => {
      if (!student) { setAccbThisMonth(0); return; }
      const monthIdx = MONTHS.indexOf(month) + 1;
      const v = await getAccbForMonth(student.id, feeYear, monthIdx);
      setAccbThisMonth(v);
    })();
  }, [student, month, feeYear]);

  const breakdown: FeeBreakdown | null = useMemo(() => {
    if (!subsidiesEnabled(settings)) return null;
    if (!student) return null;
    return computeFeeBreakdown(student, settings, accbThisMonth);
  }, [student, settings, accbThisMonth]);

  // Auto-fill amount with parent_pays unless the user has typed something
  useEffect(() => {
    if (breakdown && !amountTouched && !isRefund) {
      setAmount(breakdown.parent_pays.toFixed(2));
    }
  }, [breakdown, isRefund]); // eslint-disable-line

  async function onSave(action: "print" | "email" | "save") {
    if (saving || sending) return;
    if (!student) { void showAlert("Pick a student first."); return; }
    if (!description.trim()) { void showAlert("Description is required."); return; }
    const amt = parseFloat(amount); if (!(amt >= 0)) { void showAlert("Invalid amount."); return; }
    const pen = parseFloat(pending || "0") || 0;
    const bk = (breakdown && !isRefund) ? breakdown : null;

    // CRA-correctness guard: if subsidies are enabled and a breakdown is
    // computed, the parent-pays amount on the receipt must equal the breakdown,
    // otherwise the printed PDF shows an inconsistent total vs. the breakdown
    // table. Block the save and tell the user to use the Refund flow.
    if (bk && Math.abs(amt - bk.parent_pays) > 0.01) {
      void showAlert(
        `Amount ($${amt.toFixed(2)}) does not match the subsidy breakdown (parent pays $${bk.parent_pays.toFixed(2)}).\n\n` +
        `When subsidies are enabled, the receipt amount must equal gross − CCFRI − ACCB.\n\n` +
        `To record a different amount, issue a Refund receipt instead.`
      );
      return;
    }

    setSaving(true);
    try {
      const newId = await createReceipt({
        receipt_no: receiptNo, date, student_id: student.id,
        student_name_snapshot: student.name,
        father_name_snapshot: student.father_name,
        mother_name_snapshot: student.mother_name,
        description, amount: amt, pending_amount: pen, comments: comments || null,
        is_refund: isRefund ? 1 : 0,
        gross_amount: bk ? bk.gross : null,
        ccfri_amount: bk ? bk.ccfri : null,
        accb_amount:  bk ? bk.accb : null,
      });
      const settingsLatest = await getSettings();
      const r = {
        id: newId, receipt_no: receiptNo, date, student_id: student.id,
        student_name_snapshot: student.name,
        father_name_snapshot: student.father_name,
        mother_name_snapshot: student.mother_name,
        description, amount: amt, pending_amount: pen, comments: comments || null,
        voided: 0, created_at: new Date().toISOString(),
        emailed_at: null, emailed_to: null,
        is_refund: isRefund ? 1 : 0,
        gross_amount: bk ? bk.gross : null,
        ccfri_amount: bk ? bk.ccfri : null,
        accb_amount:  bk ? bk.accb : null,
        void_reason: null,
        voided_at: null,
        issuer_snapshot_json: null,
      };
      let savedPath: string | null = null;
      try { savedPath = await saveReceiptPdf(r, settingsLatest); }
      catch (e) { console.error(e); void showAlert("Receipt saved, but PDF auto-save failed:\n" + e); }

      if (action === "email") {
        const recipients = parseRecipients(student.email);
        if (recipients.length === 0) {
          void showAlert(`Receipt #${receiptNo} saved.${savedPath ? "\nPDF: " + savedPath : ""}\n⚠️ No email on file for this student — not sent.`);
        } else {
          // Show preview modal; actual send happens from confirmSendEmail().
          const html = buildReceiptHtml(r, settingsLatest);
          setPreview({ html, receipt: r, recipients, settings: settingsLatest });
        }
        setReceiptNo((n) => n + 1);
        setComments(""); setPending(""); setIsRefund(false); setAmountTouched(false);
        return;
      }

      if (action === "print") printReceipt(r, settingsLatest);
      setReceiptNo((n) => n + 1);
      setComments(""); setPending(""); setIsRefund(false); setAmountTouched(false);
      void showAlert(`Receipt #${receiptNo} saved.${savedPath ? "\nPDF: " + savedPath : ""}`);
    } finally {
      setSaving(false);
    }
  }

  async function confirmSendEmail() {
    if (!preview || sending) return;
    setSending(true);
    try {
      await sendReceiptEmail({ receipt: preview.receipt, recipients: preview.recipients, settings: preview.settings });
      await markEmailed(preview.receipt.id, preview.recipients);
      const recips = preview.recipients.join(", ");
      setPreview(null);
      void showAlert(`✉️ Sent to ${recips}`);
    } catch (e: any) {
      void showAlert("❌ Email failed: " + (e?.message || e));
    } finally {
      setSending(false);
    }
  }

  return (
    <div>
      <h1>New Receipt</h1>
      <p className="subtitle">Creates an entry in Receipt History and opens the macOS print dialog (use "Save as PDF" to keep a copy).</p>

      <div className="card">
        <div className="row">
          <div className="field">
            <label>Receipt #</label>
            <input value={receiptNo} onChange={(e) => setReceiptNo(parseInt(e.target.value || "0", 10))} />
          </div>
          <div className="field">
            <label>Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>

        <div className="row">
          <div className="field">
            <label>Roster Year</label>
            <select value={year} onChange={(e) => { setYear(parseInt(e.target.value, 10)); setStudentId(""); }}>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Student</label>
            <select value={studentId} onChange={(e) => setStudentId(e.target.value ? parseInt(e.target.value, 10) : "")}>
              <option value="">— select —</option>
              {students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        </div>

        {student && (
          <div className="card" style={{ background: "#f8fafc", padding: 12, marginBottom: 14 }}>
            <div style={{ fontSize: 13 }}>
              <div><b>Father:</b> {student.father_name || "—"}</div>
              <div><b>Mother:</b> {student.mother_name || "—"}</div>
              <div><b>Email:</b> {student.email || "—"}</div>
            </div>
          </div>
        )}

        <div className="row">
          <div className="field">
            <label>Fee Month</label>
            <select value={month} onChange={(e) => { setMonth(e.target.value); setDescTouched(false); }}>
              {MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Fee Year</label>
            <input type="number" value={feeYear} onChange={(e) => { setFeeYear(parseInt(e.target.value || "0", 10)); setDescTouched(false); }} />
          </div>
        </div>

        <div className="field">
          <label>Description</label>
          <input value={description} onChange={(e) => { setDescription(e.target.value); setDescTouched(true); }} />
        </div>

        {breakdown && breakdown.gross > 0 && !isRefund && (
          <div className="card" style={{ background: "#eff6ff", border: "1px solid #bfdbfe", padding: 12, marginBottom: 14 }}>
            <div style={{ fontWeight: 600, marginBottom: 6, color: "#1e40af" }}>Fee Breakdown (auto-calculated)</div>
            <table style={{ width: "100%", fontSize: 13 }}>
              <tbody>
                <tr><td>Gross monthly fee</td><td style={{ textAlign: "right" }}>${breakdown.gross.toFixed(2)}</td></tr>
                {breakdown.ccfri > 0 && (
                  <tr><td>BC CCFRI reduction</td><td style={{ textAlign: "right", color: "#15803d" }}>−${breakdown.ccfri.toFixed(2)}</td></tr>
                )}
                {breakdown.accb > 0 && (
                  <tr><td>ACCB subsidy ({month} {feeYear})</td><td style={{ textAlign: "right", color: "#15803d" }}>−${breakdown.accb.toFixed(2)}</td></tr>
                )}
                <tr style={{ borderTop: "1px solid #bfdbfe", fontWeight: 700 }}>
                  <td style={{ paddingTop: 4 }}>Parent pays out-of-pocket</td>
                  <td style={{ textAlign: "right", paddingTop: 4 }}>${breakdown.parent_pays.toFixed(2)}</td>
                </tr>
              </tbody>
            </table>
            {breakdown.accb === 0 && student && (
              <div style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>
                No ACCB on file for {month} {feeYear}. Add it on the Students page → ACCB… if this family qualifies.
              </div>
            )}
          </div>
        )}

        <div className="row">
          <div className="field">
            <label>Amount Received ($)</label>
            <input value={amount} onChange={(e) => { setAmount(e.target.value); setAmountTouched(true); }} />
          </div>
          <div className="field">
            <label>Pending Fees ($)</label>
            <input value={pending} onChange={(e) => setPending(e.target.value)} />
          </div>
        </div>

        <div className="field">
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={isRefund} onChange={(e) => setIsRefund(e.target.checked)} />
            <span>Mark as <b>Refund</b> (amount is deducted from annual totals; receipt shows as negative)</span>
          </label>
        </div>

        <div className="field">
          <label>Comments</label>
          <textarea value={comments} onChange={(e) => setComments(e.target.value)} placeholder="Optional notes (e.g., Pending Fees CAD120)" />
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
          <button className="btn" onClick={() => onSave("print")} disabled={saving || sending}>
            {saving ? "Saving…" : "Save & Print"}
          </button>
          <button className="btn" onClick={() => onSave("email")}
            disabled={saving || sending || !student || parseRecipients(student?.email).length === 0}
            title={!student ? "Pick a student" : parseRecipients(student.email).length === 0 ? "No email on file for this student" : ""}>
            {saving ? "Saving…" : "Save & Email"}
          </button>
          <button className="btn secondary" onClick={() => onSave("save")} disabled={saving || sending}>
            {saving ? "Saving…" : "Save Only"}
          </button>
        </div>
      </div>

      {preview && (
        <div
          onClick={() => !sending && setPreview(null)}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 24,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--bg, #1a1a1a)", color: "var(--text)",
              borderRadius: 10, maxWidth: 900, width: "100%", maxHeight: "90vh",
              display: "flex", flexDirection: "column", overflow: "hidden",
              border: "1px solid var(--border)",
            }}
          >
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <strong>Preview before sending</strong>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>
                  To: {preview.recipients.join(", ")}
                </div>
              </div>
              <button className="btn ghost" onClick={() => setPreview(null)} disabled={sending}>✕</button>
            </div>
            <iframe
              title="Receipt preview"
              srcDoc={preview.html}
              style={{ flex: 1, border: 0, background: "white", minHeight: 400 }}
            />
            <div style={{ padding: 12, borderTop: "1px solid var(--border)", display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button className="btn secondary" onClick={() => setPreview(null)} disabled={sending}>Cancel</button>
              <button className="btn" onClick={confirmSendEmail} disabled={sending}>
                {sending ? "Sending…" : `Send to ${preview.recipients.length} recipient${preview.recipients.length === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
