import { showAlert, showConfirm } from "../lib/dialogs";
import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { copyFile, exists, mkdir, writeFile } from "@tauri-apps/plugin-fs";
import { appDataDir, join, tempDir } from "@tauri-apps/api/path";
import {
  annualGroupsForYear, getSettings, setSetting, nextAnnualReceiptNumber,
  recordAnnualReceipt, markAnnualReceiptEmailed, listAnnualReceiptsForPersonYear,
  updateStudentEmailByPerson,
  type AnnualGroup,
} from "../lib/db";
import {
  renderAnnualReceiptPdf, saveAnnualReceiptPdf,
  renderAnnualEmailTemplate,
} from "../lib/annualReceipt";
import { parseRecipients, sendAnnualReceiptEmail } from "../lib/email";
import { exportYearArchive } from "../lib/yearArchive";
import { yieldToUI } from "../lib/lazy";
import type { SettingsMap, AnnualReceipt } from "../types";

type Step = 1 | 2 | 3 | 4;

interface DraftRow {
  group: AnnualGroup;
  ar: AnnualReceipt | null;   // the current/latest annual receipt row (if any)
  recipientEmails: string;    // editable in step 2
  status: "idle" | "drafted" | "sending" | "sent" | "failed";
  error?: string;
}

function defaultRecipientLabel(g: AnnualGroup): string {
  const parts = [g.father_name, g.mother_name].filter((x): x is string => !!x?.trim());
  return parts.length ? parts.join(" & ") : g.student_name;
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function AnnualReceipts() {
  const now = new Date().getFullYear();
  const [year, setYear] = useState<number>(now - (new Date().getMonth() < 2 ? 1 : 0)); // Jan/Feb default to previous year
  const [step, setStep] = useState<Step>(1);
  const [settings, setSettings] = useState<SettingsMap>({});
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<{ group: AnnualGroup; list: AnnualReceipt[] } | null>(null);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [sendingAll, setSendingAll] = useState(false);
  // Per-row in-flight guard: prevents double-clicks on the same row's Send/Resend button.
  const [inFlight, setInFlight] = useState<Set<number>>(new Set());

  async function refresh() {
    setLoading(true);
    try {
      const s = await getSettings();
      setSettings(s);
      const gs = await annualGroupsForYear(year);
      setRows(prev => gs.map(g => {
        const existing = prev.find(r => r.group.person_id === g.person_id);
        return {
          group: g,
          ar: g.last_issued || null,
          recipientEmails: existing?.recipientEmails ?? (g.email || ""),
          status: g.last_issued?.emailed_at ? "sent" : (g.last_issued ? "drafted" : "idle"),
        };
      }));
    } finally { setLoading(false); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [year]);

  const grandTotal = rows.reduce((a, r) => a + r.group.total, 0);

  // Step 1 issues for highlighting
  function rowIssues(r: DraftRow): string[] {
    const issues: string[] = [];
    if (!r.recipientEmails || !r.recipientEmails.trim()) issues.push("No parent email");
    if (r.group.total <= 0) issues.push("Total is $0");
    if (!r.group.father_name && !r.group.mother_name) issues.push("No parent name on file");
    return issues;
  }
  const flagged = rows.filter(r => rowIssues(r).length > 0);

  // ----- Step 3: backup + generate drafts -----
  async function backupNow(): Promise<string | null> {
    try {
      const folder = settings.pdf_folder?.trim()
        ? await join(settings.pdf_folder, "Backups")
        : await join(await appDataDir(), "Backups");
      if (!(await exists(folder))) await mkdir(folder, { recursive: true });
      const src = await join(await appDataDir(), "echelon.db");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const dst = await join(folder, `echelon-pre-annual-${year}-${stamp}.db`);
      await copyFile(src, dst);
      const isoNow = new Date().toISOString();
      await setSetting("last_backup_at", isoNow);
      await setSetting("last_backup_path", dst);
      return dst;
    } catch (e: any) {
      console.error("Backup failed:", e);
      return null;
    }
  }

  async function generateAllDrafts() {
    if (generating || sendingAll) return;
    setGenerating(true);
    setLoading(true);
    try {
      const backupPath = await backupNow();
      if (!backupPath) {
        if (!await showConfirm("⚠️ Auto-backup failed. Continue without a backup? (Not recommended)")) {
          return;
        }
      }
      const targets = rows.filter(r => r.group.total > 0);
      let i = 0;
      for (const r of targets) {
        i++;
        try {
          const arNumber = await nextAnnualReceiptNumber(year);
          const recipientLabel = defaultRecipientLabel(r.group);
          const supersede = r.ar || undefined;
          const supersededNote = supersede ? `This receipt supersedes ${supersede.ar_number} issued ${supersede.issued_at.slice(0,10)}.` : null;
          await recordAnnualReceipt({ group: r.group, year, arNumber, recipientLabel, supersede, notes: supersededNote });
          await saveAnnualReceiptPdf({ group: r.group, year, arNumber, recipientLabel, settings, supersededNote });
          setRows(cur => cur.map(x => x.group.person_id === r.group.person_id ? { ...x, status: "drafted" } : x));
        } catch (e: any) {
          setRows(cur => cur.map(x => x.group.person_id === r.group.person_id ? { ...x, status: "failed", error: e?.message || String(e) } : x));
        }
      }
      await refresh();
      setStep(4);
      if (backupPath) {
        void showAlert(`✅ Drafts generated for ${i} student(s).\nBackup saved to:\n${backupPath}`);
      }
    } finally {
      setLoading(false);
      setGenerating(false);
    }
  }

  // ----- Step 4: send -----
  async function sendOne(idx: number) {
    const r = rows[idx];
    if (!r) return;
    // CRA T778 requires the issuer's Business Number on annual child-care
    // receipts. Refuse to send if BN is missing rather than issue a receipt
    // that a parent then can't use on their tax return.
    if (!settings.business_number || !settings.business_number.trim()) {
      void showAlert(
        "Business Number (BN) is not set. CRA T778 receipts must include the issuer's BN — set it in Settings → Organization before sending annual receipts.",
        { kind: "error" }
      );
      return;
    }
    // Per-row in-flight guard prevents the same row from being sent twice
    // concurrently (which would allocate two AR numbers + send two emails).
    if (inFlight.has(idx)) return;
    const recipients = parseRecipients(r.recipientEmails);
    if (!recipients.length) { void showAlert("No email address."); return; }
    setInFlight(prev => { const n = new Set(prev); n.add(idx); return n; });
    setRows(cur => cur.map((x, i) => i === idx ? { ...x, status: "sending", error: undefined } : x));
    try {
      // Generate fresh draft AR if none yet
      let arNumber: string;
      let arId: number;
      if (r.ar) {
        arNumber = r.ar.ar_number;
        arId = r.ar.id;
      } else {
        arNumber = await nextAnnualReceiptNumber(year);
        const recipientLabel = defaultRecipientLabel(r.group);
        arId = await recordAnnualReceipt({ group: r.group, year, arNumber, recipientLabel, notes: null });
        await saveAnnualReceiptPdf({ group: r.group, year, arNumber, recipientLabel, settings, supersededNote: null });
      }
      const recipientLabel = defaultRecipientLabel(r.group);
      const pdfBytes = await renderAnnualReceiptPdf({
        group: r.group, year, arNumber, recipientLabel, settings,
        supersededNote: r.ar ? `Original AR ${r.ar.ar_number}` : null,
        issuerSnapshotJson: r.ar?.issuer_snapshot_json ?? null,
      });
      const subjTpl = settings.annual_email_subject || "Annual Child Care Receipt {{year}} - {{student}}";
      const bodyTpl = settings.annual_email_body || "Please find your annual receipt attached.";
      const subject = renderAnnualEmailTemplate(subjTpl, { group: r.group, year, arNumber, settings });
      const body = renderAnnualEmailTemplate(bodyTpl, { group: r.group, year, arNumber, settings });
      const fname = `${arNumber}_${r.group.student_name.replace(/[^\w]+/g, "_")}.pdf`;
      await sendAnnualReceiptEmail({ pdfBytes, filename: fname, subject, body, recipients, settings });
      await markAnnualReceiptEmailed(arId, recipients);
      setRows(cur => cur.map((x, i) => i === idx ? { ...x, status: "sent" } : x));
    } catch (e: any) {
      setRows(cur => cur.map((x, i) => i === idx ? { ...x, status: "failed", error: e?.message || String(e) } : x));
    } finally {
      setInFlight(prev => { const n = new Set(prev); n.delete(idx); return n; });
    }
  }

  async function sendAll(retryFailedOnly: boolean) {
    if (sendingAll || generating) return;
    if (!settings.business_number || !settings.business_number.trim()) {
      void showAlert(
        "Business Number (BN) is not set. CRA T778 receipts must include the issuer's BN — set it in Settings → Organization before sending annual receipts.",
        { kind: "error" }
      );
      return;
    }
    setSendingAll(true);
    try {
      const indexes: number[] = [];
      rows.forEach((r, i) => {
        const ok = retryFailedOnly ? r.status === "failed" : (r.status !== "sent");
        const haveEmail = parseRecipients(r.recipientEmails).length > 0;
        const haveTotal = r.group.total > 0;
        if (ok && haveEmail && haveTotal) indexes.push(i);
      });
      if (!indexes.length) { void showAlert("Nothing eligible to send."); return; }
      if (!await showConfirm(`Send ${indexes.length} annual receipt${indexes.length === 1 ? "" : "s"} now?`)) return;
      setBatchProgress({ done: 0, total: indexes.length, current: rows[indexes[0]]?.group.student_name || "" });
      await yieldToUI();
      let done = 0;
      for (const i of indexes) {
        setBatchProgress({ done, total: indexes.length, current: rows[i].group.student_name });
        await yieldToUI();
        await sendOne(i);
        done++;
        await yieldToUI();
      }
      setBatchProgress({ done, total: indexes.length, current: "" });
      await refresh();
      setTimeout(() => setBatchProgress(null), 2500);
    } finally {
      setSendingAll(false);
    }
  }

  async function openPdfFor(r: DraftRow) {
    if (!r.ar) return;
    try {
      const recipientLabel = defaultRecipientLabel(r.group);
      const note = r.ar ? null : null;
      const bytes = await renderAnnualReceiptPdf({
        group: r.group, year, arNumber: r.ar.ar_number, recipientLabel, settings,
        supersededNote: note,
        issuerSnapshotJson: r.ar.issuer_snapshot_json ?? null,
      });
      const dir = await join(await tempDir(), "echelon-receipts");
      if (!(await exists(dir))) await mkdir(dir, { recursive: true });
      const p = await join(dir, `${r.ar.ar_number}_${r.group.student_name.replace(/[^\w]+/g, "_")}.pdf`);
      await writeFile(p, bytes);
      await openPath(p);
    } catch (e: any) { void showAlert("Open failed: " + (e?.message || e)); }
  }

  async function showHistory(g: AnnualGroup) {
    const list = await listAnnualReceiptsForPersonYear(g.person_id, year);
    setHistory({ group: g, list });
  }

  async function doExport() {
    const folder = await open({ directory: true, multiple: false });
    if (!folder || Array.isArray(folder)) return;
    try {
      const out = await exportYearArchive({ year, settings, baseFolder: folder as string, onProgress: () => {} });
      void showAlert(`Archive written to:\n${out}`);
    } catch (e: any) {
      void showAlert("Export failed: " + (e?.message || e));
    }
  }

  // ----- Render -----
  return (
    <div>
      <h1>Annual Tax Receipts — Send to Parents</h1>
      <p className="subtitle">
        Calendar-year (Jan&ndash;Dec) totals per child for CRA Form T778. Crosses roster years.
        Voided receipts are excluded.
      </p>

      {/* Year + export */}
      <div className="toolbar">
        <label style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em" }}>Tax year</label>
        <select value={year} onChange={(e) => { setYear(parseInt(e.target.value, 10)); setStep(1); }}>
          {Array.from({ length: 6 }, (_, i) => now + 1 - i).map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <div className="grow" />
        <button className="btn secondary" onClick={doExport}>Export Year Archive…</button>
      </div>

      {/* Stepper */}
      <div className="stepper">
        {[1,2,3,4].map(s => (
          <div key={s} className={"step " + (step === s ? "active" : step > s ? "done" : "")}>
            <span className="step-num">{step > s ? "✓" : s}</span>
            <span className="step-label">{["Review","Fix issues","Generate drafts","Send"][s - 1]}</span>
          </div>
        ))}
      </div>

      {!settings.business_number && (
        <div className="today-item warn" style={{ marginBottom: 14 }}>
          <span className="today-dot">!</span>
          <span className="today-text">
            Your Business Number (BN) is <strong>required</strong> for CRA T778 annual child-care receipts.
            Sending is disabled until you set the BN in <a href="#/settings">Settings → Organization</a>.
          </span>
        </div>
      )}

      {loading && <div className="empty">Working…</div>}

      {/* STEP 1 - Review */}
      {!loading && step === 1 && (
        <>
          <div className="card" style={{ marginBottom: 14 }}>
            <strong>Reviewing {rows.length} student{rows.length === 1 ? "" : "s"} for {year}.</strong>{" "}
            Grand total: <strong>${fmt(grandTotal)}</strong>.
            {flagged.length > 0
              ? <> <span style={{ color: "var(--danger)" }}>{flagged.length} need attention</span> before sending.</>
              : <> Everything looks good.</>}
          </div>
          {rows.length === 0 ? (
            <div className="empty">No receipts found for {year}.</div>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Student</th><th>Parents</th><th>Email on file</th>
                  <th style={{ textAlign: "right" }}># Receipts</th>
                  <th style={{ textAlign: "right" }}>Total</th>
                  <th>Issues</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const issues = rowIssues(r);
                  return (
                    <tr key={r.group.person_id}>
                      <td>{r.group.student_name}</td>
                      <td style={{ fontSize: 12 }}>
                        {r.group.father_name || ""}{r.group.father_name && r.group.mother_name ? <br/> : ""}{r.group.mother_name || ""}
                      </td>
                      <td style={{ fontSize: 12 }}>{r.group.email || <em style={{ color: "var(--danger)" }}>— none —</em>}</td>
                      <td style={{ textAlign: "right" }}>{r.group.count}</td>
                      <td style={{ textAlign: "right", fontWeight: 600 }}>${fmt(r.group.total)}</td>
                      <td>
                        {issues.length === 0
                          ? <span className="status-badge sent">OK</span>
                          : issues.map((iss, i) => <span key={i} className="status-badge refund" style={{ marginRight: 4 }}>{iss}</span>)}
                      </td>
                      <td><button className="btn ghost" onClick={() => showHistory(r.group)}>History</button></td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4} style={{ textAlign: "right", fontWeight: 600 }}>Grand Total</td>
                  <td style={{ textAlign: "right", fontWeight: 700 }}>${fmt(grandTotal)}</td>
                  <td colSpan={2}></td>
                </tr>
              </tfoot>
            </table>
          )}
          <div className="wizard-foot">
            <div></div>
            <button className="btn" disabled={rows.length === 0}
              onClick={() => setStep(flagged.length > 0 ? 2 : 3)}>
              {flagged.length > 0 ? `Next: Fix ${flagged.length} issue(s)` : "Next: Generate drafts"} →
            </button>
          </div>
        </>
      )}

      {/* STEP 2 - Fix issues */}
      {!loading && step === 2 && (
        <>
          <div className="card" style={{ marginBottom: 14 }}>
            Edit the recipient email below for any flagged row. (Permanent edits to parent names / contacts
            happen on the <a href="#/students/roster">Students</a> tab. Email entered here is only used for this batch.)
          </div>
          {flagged.length === 0 ? (
            <div className="empty">No issues — you're good to proceed.</div>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Student</th>
                  <th style={{ textAlign: "right" }}>Total</th>
                  <th>Recipient email(s) for this batch</th>
                  <th>Other issues</th>
                </tr>
              </thead>
              <tbody>
                {flagged.map((r, i) => {
                  const idx = rows.findIndex(x => x.group.person_id === r.group.person_id);
                  return (
                    <tr key={r.group.person_id + i}>
                      <td>{r.group.student_name}</td>
                      <td style={{ textAlign: "right" }}>${fmt(r.group.total)}</td>
                      <td>
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          <input style={{ flex: 1 }}
                            value={r.recipientEmails}
                            placeholder="parent1@example.com, parent2@example.com"
                            onChange={(e) => setRows(cur => cur.map((x, j) => j === idx ? { ...x, recipientEmails: e.target.value } : x))} />
                          {r.recipientEmails.trim() && r.recipientEmails.trim() !== (r.group.email || "").trim() && (
                            <button
                              className="btn ghost"
                              title="Save this email back to the student record so you don't have to re-type it next year"
                              onClick={async () => {
                                const n = await updateStudentEmailByPerson(r.group.person_id, r.recipientEmails.trim());
                                setRows(cur => cur.map((x, j) => j === idx ? { ...x, group: { ...x.group, email: r.recipientEmails.trim() } } : x));
                                void showAlert(`Saved to ${n} student record${n === 1 ? "" : "s"} (all years).`);
                              }}
                            >💾 Save to roster</button>
                          )}
                        </div>
                      </td>
                      <td style={{ fontSize: 12, color: "var(--muted)" }}>
                        {rowIssues(r).filter(x => x !== "No parent email").join(" · ") || "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <div className="wizard-foot">
            <button className="btn secondary" onClick={() => setStep(1)}>← Back</button>
            <button className="btn" onClick={() => setStep(3)}>Next: Generate drafts →</button>
          </div>
        </>
      )}

      {/* STEP 3 - Generate drafts (with auto-backup) */}
      {!loading && step === 3 && (
        <>
          <div className="card" style={{ marginBottom: 14 }}>
            <strong>About to:</strong>
            <ol style={{ margin: "8px 0 0 18px", fontSize: 14 }}>
              <li>Back up your database automatically (saved to your PDF folder or app data).</li>
              <li>Create / re-issue an annual receipt row for every student with a total &gt; $0.</li>
              <li>Save each PDF to your PDF archive folder.</li>
              <li>No emails are sent in this step.</li>
            </ol>
          </div>
          <div className="wizard-foot">
            <button className="btn secondary" onClick={() => setStep(flagged.length ? 2 : 1)}>← Back</button>
            <button className="btn" onClick={generateAllDrafts} disabled={generating || sendingAll}>
              {generating ? "Generating…" : "Generate drafts now"}
            </button>
          </div>
        </>
      )}

      {/* STEP 4 - Send */}
      {!loading && step === 4 && (
        <>
          <div className="card" style={{ marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <div>
              <strong>Ready to send.</strong>{" "}
              {rows.filter(r => r.status === "sent").length} sent ·{" "}
              {rows.filter(r => r.status === "drafted").length} drafted ·{" "}
              {rows.filter(r => r.status === "failed").length} failed
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {rows.some(r => r.status === "failed") && (
                <button className="btn secondary" onClick={() => sendAll(true)} disabled={sendingAll || generating}>
                  {sendingAll ? "Sending…" : "Retry failed only"}
                </button>
              )}
              <button className="btn" onClick={() => sendAll(false)} disabled={sendingAll || generating}>
                {sendingAll ? "Sending…" : "Send all unsent"}
              </button>
            </div>
          </div>

          <table className="data">
            <thead>
              <tr>
                <th>Student</th>
                <th>Recipient</th>
                <th style={{ textAlign: "right" }}>Total</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const recipients = parseRecipients(r.recipientEmails);
                const badge =
                  r.status === "sent"    ? { key: "sent",   label: "✓ Sent" } :
                  r.status === "sending" ? { key: "saved",  label: "Sending…" } :
                  r.status === "failed"  ? { key: "voided", label: "Failed" } :
                  r.status === "drafted" ? { key: "saved",  label: "Draft ready" } :
                                            { key: "saved",  label: "Pending" };
                return (
                  <tr key={r.group.person_id}>
                    <td>{r.group.student_name}</td>
                    <td style={{ fontSize: 12 }}>{recipients.length ? recipients.join(", ") : <em style={{ color: "var(--danger)" }}>— none —</em>}</td>
                    <td style={{ textAlign: "right" }}>${fmt(r.group.total)}</td>
                    <td>
                      <span className={`status-badge ${badge.key}`} title={r.error || ""}>{badge.label}</span>
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button className="btn ghost" onClick={() => openPdfFor(r)} disabled={!r.ar}>Open PDF</button>
                      <button className="btn ghost"
                        disabled={recipients.length === 0 || r.status === "sending" || sendingAll || generating || inFlight.has(i)}
                        onClick={() => sendOne(i)}>
                        {r.status === "sent" ? "Resend" : "Send"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="wizard-foot">
            <button className="btn secondary" onClick={() => setStep(3)}>← Back</button>
            <button className="btn secondary" onClick={() => setStep(1)}>Start a different year</button>
          </div>
        </>
      )}

      {/* History modal */}
      {history && (
        <div className="modal-bg" onClick={() => setHistory(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>History · {history.group.student_name} · {year}</h2>
            {history.list.length === 0 ? <div className="empty">No annual receipts issued yet.</div> : (
              <table className="data">
                <thead><tr><th>AR Number</th><th>Issued</th><th>Recipient</th><th style={{ textAlign: "right" }}>Total</th><th>Emailed</th><th>Status</th></tr></thead>
                <tbody>
                  {history.list.map((a) => (
                    <tr key={a.id} style={a.superseded_by ? { color: "#999" } : undefined}>
                      <td>{a.ar_number}</td>
                      <td>{a.issued_at.slice(0,16)}</td>
                      <td>{a.recipient_label}</td>
                      <td style={{ textAlign: "right" }}>${fmt(a.total_amount)}</td>
                      <td>{a.emailed_at ? `✉️ ${a.emailed_at.slice(0,10)}` : "—"}</td>
                      <td>{a.superseded_by ? <span className="status-badge voided">Superseded</span> : <span className="status-badge sent">Current</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
              <button className="btn secondary" onClick={() => setHistory(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Batch progress toast */}
      {batchProgress && (
        <div className="toast">
          <div>
            {batchProgress.done < batchProgress.total
              ? <>📨 Sending {batchProgress.done + 1} of {batchProgress.total}{batchProgress.current ? " — " + batchProgress.current : ""}…</>
              : <>✅ Sent {batchProgress.total} annual receipt(s).</>}
          </div>
          <div className="progress" aria-label="batch progress">
            <div className="progress-fill" style={{ width: `${batchProgress.total === 0 ? 100 : (batchProgress.done / batchProgress.total) * 100}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}
