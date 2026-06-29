import { useEffect, useMemo, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { writeFile, exists, mkdir } from "@tauri-apps/plugin-fs";
import { tempDir, join } from "@tauri-apps/api/path";
import { getSettings, listReceipts, voidReceipt, markEmailed, listStudents } from "../lib/db";
import type { Receipt, SettingsMap, Student } from "../types";
import { printReceipt, saveReceiptPdf } from "../lib/receipt";
import { sendReceiptEmail, parseRecipients, sendSubsidyStatementEmail } from "../lib/email";
import {
  renderSubsidyStatementPdf, saveSubsidyStatementPdf,
  renderSubsidyEmailTemplate, monthLabelFromDate,
} from "../lib/subsidyStmt";
import RowMenu from "../components/RowMenu";

const MONTHS = ["All","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

type StatusKey = "sent" | "saved" | "voided" | "refund";
function statusFor(r: Receipt): { key: StatusKey; label: string } {
  if (r.voided) return { key: "voided", label: "Voided" };
  if (r.is_refund) return { key: "refund", label: "Refund" };
  if (r.emailed_at) return { key: "sent", label: "Sent" };
  return { key: "saved", label: "Saved" };
}

export default function History() {
  const [rows, setRows] = useState<Receipt[]>([]);
  const [search, setSearch] = useState("");
  const [year, setYear] = useState<number | "">("");
  const [month, setMonth] = useState<number | "">("");
  const [settings, setSettings] = useState<SettingsMap>({});
  const [studentEmails, setStudentEmails] = useState<Map<number, string>>(new Map());

  async function refresh() {
    setRows(await listReceipts({
      search: search || undefined,
      year: year === "" ? undefined : year,
      month: month === "" ? undefined : month,
    }));
    setSettings(await getSettings());
    const all = await listStudents(undefined, false);
    const m = new Map<number, string>();
    all.forEach((s: Student) => { if (s.email) m.set(s.id, s.email); });
    setStudentEmails(m);
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
              <th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const recipients = parseRecipients(studentEmails.get(r.student_id));
              const st = statusFor(r);
              const subsidyAvailable = settings.subsidies_enabled === "1" && r.gross_amount != null && r.gross_amount > 0;

              const doOpenPdf = async () => {
                try {
                  let p = await saveReceiptPdf(r, settings);
                  if (!p) {
                    // fallback temp file (use print as it generates html)
                    await printReceipt(r, settings);
                    return;
                  }
                  await openPath(p);
                } catch (e: any) { alert("Open failed: " + (e?.message || e)); }
              };

              const doSavePdf = async () => {
                try {
                  const p = await saveReceiptPdf(r, settings);
                  alert(p ? "Saved PDF:\n" + p : "Set a PDF folder in Settings first.");
                } catch (e) { alert("Save failed: " + e); }
              };

              const doSubsidyPdf = async () => {
                try {
                  let target = await saveSubsidyStatementPdf(r, settings);
                  if (!target) {
                    const bytes = await renderSubsidyStatementPdf(r, settings);
                    const dir = await join(await tempDir(), "echelon-receipts");
                    if (!(await exists(dir))) await mkdir(dir, { recursive: true });
                    target = await join(dir, `SUB_${r.receipt_no}_${r.date}.pdf`);
                    await writeFile(target, bytes);
                  }
                  await openPath(target);
                } catch (e: any) { alert("Statement failed: " + (e?.message || e)); }
              };

              const doEmailSubsidy = async () => {
                if (!confirm(`Email subsidy statement for receipt #${r.receipt_no} to:\n  ${recipients.join("\n  ")}`)) return;
                try {
                  const bytes = await renderSubsidyStatementPdf(r, settings);
                  const { year: y, label } = monthLabelFromDate(r.date);
                  const subjTpl = settings.subsidy_stmt_subject || "Monthly Fee Breakdown - {{student}} - {{month_label}} {{year}}";
                  const bodyTpl = settings.subsidy_stmt_body || "Please find attached the monthly fee breakdown.";
                  await sendSubsidyStatementEmail({
                    pdfBytes: bytes,
                    filename: `Subsidy_${r.receipt_no}_${r.student_name_snapshot.replace(/[^\w]+/g, "_")}.pdf`,
                    subject: renderSubsidyEmailTemplate(subjTpl, r, settings),
                    body: renderSubsidyEmailTemplate(bodyTpl, r, settings),
                    recipients, settings,
                  });
                  alert(`✉️ Subsidy statement (${label} ${y}) sent to ${recipients.join(", ")}`);
                } catch (e: any) { alert("Email failed:\n" + (e?.message || e)); }
              };

              const doEmail = async () => {
                if (!confirm(`Email receipt #${r.receipt_no} to:\n  ${recipients.join("\n  ")}`)) return;
                try {
                  await sendReceiptEmail({ receipt: r, recipients, settings });
                  await markEmailed(r.id, recipients);
                  alert(`✉️ Sent to ${recipients.join(", ")}`);
                  refresh();
                } catch (e: any) { alert("Email failed:\n" + (e?.message || e)); }
              };

              const doVoid = async () => {
                const reason = prompt(
                  `Void receipt #${r.receipt_no}?\n\nThis marks the receipt as cancelled. The record stays in your history for audit but parents will see it is voided.\n\nReason (required):`,
                  ""
                );
                if (reason == null) return; // cancelled
                const trimmed = reason.trim();
                if (!trimmed) { alert("A reason is required to void a receipt."); return; }
                await voidReceipt(r.id, trimmed);
                refresh();
              };

              return (
              <tr key={r.id} className={r.voided ? "voided" : ""}>
                <td>{r.receipt_no}</td>
                <td>{r.date}</td>
                <td>
                  {r.student_name_snapshot}
                  {r.emailed_at && (
                    <span title={`Emailed ${r.emailed_at} to ${r.emailed_to}`} style={{ marginLeft: 6 }}>✉️</span>
                  )}
                </td>
                <td>{r.description}</td>
                <td style={{ textAlign: "right" }}>${r.amount.toFixed(2)}</td>
                <td>
                  <span className={`status-badge ${st.key}`} title={r.voided && r.void_reason ? `Voided: ${r.void_reason}` : ""}>{st.label}</span>
                  {r.pending_amount > 0 && !r.voided && (
                    <span className="status-badge saved" style={{ marginLeft: 4 }} title={`Pending $${r.pending_amount.toFixed(2)}`}>Partial</span>
                  )}
                </td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  <button className="btn ghost" onClick={doOpenPdf}>Open PDF</button>
                  <button className="btn ghost"
                    disabled={recipients.length === 0 || !!r.voided}
                    title={r.voided ? "Receipt is voided" : recipients.length === 0 ? "No email on file for this student" : ""}
                    onClick={doEmail}>
                    Email
                  </button>
                  <RowMenu items={[
                    { label: "Print", onClick: () => printReceipt(r, settings) },
                    { label: "Save PDF to folder", onClick: doSavePdf },
                    ...(subsidyAvailable ? [
                      { label: "Open Subsidy PDF", onClick: doSubsidyPdf },
                      { label: "Email Subsidy", onClick: doEmailSubsidy, disabled: recipients.length === 0, title: recipients.length === 0 ? "No email on file" : undefined },
                    ] : []),
                    ...(!r.voided ? [
                      { label: "Void receipt…", onClick: doVoid, danger: true }
                    ] : []),
                  ]} />
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
