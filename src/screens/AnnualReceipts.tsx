import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  annualGroupsForYear, getSettings, nextAnnualReceiptNumber,
  recordAnnualReceipt, markAnnualReceiptEmailed, listAnnualReceiptsForPersonYear,
  type AnnualGroup,
} from "../lib/db";
import {
  buildAnnualReceiptHtml, renderAnnualReceiptPdf, saveAnnualReceiptPdf,
  renderAnnualEmailTemplate,
} from "../lib/annualReceipt";
import { parseRecipients, sendAnnualReceiptEmail } from "../lib/email";
import { exportYearArchive } from "../lib/yearArchive";
import type { SettingsMap, AnnualReceipt } from "../types";

export default function AnnualReceipts() {
  const now = new Date().getFullYear();
  const [year, setYear] = useState<number>(now);
  const [groups, setGroups] = useState<AnnualGroup[]>([]);
  const [settings, setSettings] = useState<SettingsMap>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [history, setHistory] = useState<{ group: AnnualGroup; list: AnnualReceipt[] } | null>(null);
  const [recipientOverride, setRecipientOverride] = useState<{ group: AnnualGroup; emails: string; supersede?: AnnualReceipt } | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      setSettings(await getSettings());
      setGroups(await annualGroupsForYear(year));
    } finally { setLoading(false); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [year]);

  function defaultRecipientLabel(g: AnnualGroup): string {
    const parts = [g.father_name, g.mother_name].filter((x): x is string => !!x?.trim());
    return parts.length ? parts.join(" & ") : g.student_name;
  }
  function defaultRecipientEmails(g: AnnualGroup): string {
    return g.email || "";
  }

  async function generatePdf(g: AnnualGroup, supersede?: AnnualReceipt) {
    setBusy(`Generating PDF for ${g.student_name}…`);
    try {
      const arNumber = await nextAnnualReceiptNumber(year);
      const recipientLabel = defaultRecipientLabel(g);
      const supersededNote = supersede
        ? `This receipt supersedes ${supersede.ar_number} issued ${supersede.issued_at.slice(0,10)}.`
        : null;
      await recordAnnualReceipt({ group: g, year, arNumber, recipientLabel, supersede, notes: supersededNote });
      const path = await saveAnnualReceiptPdf({ group: g, year, arNumber, recipientLabel, settings, supersededNote });
      // Also open print preview for immediate review
      const html = buildAnnualReceiptHtml({ group: g, year, arNumber, recipientLabel, settings, supersededNote });
      openInIframe(html);
      await refresh();
      alert(path ? `Saved: ${path}` : `Issued ${arNumber}. (Set PDF folder in Settings to also archive to disk.)`);
    } catch (e: any) {
      alert("Failed: " + (e?.message || e));
    } finally { setBusy(null); }
  }

  async function emailFlow(g: AnnualGroup, supersede?: AnnualReceipt) {
    const emails = defaultRecipientEmails(g);
    setRecipientOverride({ group: g, emails, supersede });
  }

  async function doEmail() {
    if (!recipientOverride) return;
    const { group: g, emails, supersede } = recipientOverride;
    const recipients = parseRecipients(emails);
    if (!recipients.length) { alert("Provide at least one email address."); return; }
    setRecipientOverride(null);
    setBusy(`Emailing ${g.student_name}…`);
    try {
      const arNumber = await nextAnnualReceiptNumber(year);
      const recipientLabel = defaultRecipientLabel(g);
      const supersededNote = supersede
        ? `This receipt supersedes ${supersede.ar_number} issued ${supersede.issued_at.slice(0,10)}.`
        : null;
      const newId = await recordAnnualReceipt({ group: g, year, arNumber, recipientLabel, supersede, notes: supersededNote });
      await saveAnnualReceiptPdf({ group: g, year, arNumber, recipientLabel, settings, supersededNote });
      const pdfBytes = await renderAnnualReceiptPdf({ group: g, year, arNumber, recipientLabel, settings, supersededNote });
      const subjTpl = settings.annual_email_subject || "Annual Child Care Receipt {{year}} - {{student}}";
      const bodyTpl = settings.annual_email_body || "Please find your annual receipt attached.";
      const subject = renderAnnualEmailTemplate(subjTpl, { group: g, year, arNumber, settings });
      const body = renderAnnualEmailTemplate(bodyTpl, { group: g, year, arNumber, settings });
      const fname = `${arNumber}_${g.student_name.replace(/[^\w]+/g, "_")}.pdf`;
      await sendAnnualReceiptEmail({ pdfBytes, filename: fname, subject, body, recipients, settings });
      await markAnnualReceiptEmailed(newId, recipients);
      await refresh();
      alert(`Sent ${arNumber} to ${recipients.join(", ")}`);
    } catch (e: any) {
      alert("Email failed: " + (e?.message || e));
    } finally { setBusy(null); }
  }

  async function showHistory(g: AnnualGroup) {
    const list = await listAnnualReceiptsForPersonYear(g.person_id, year);
    setHistory({ group: g, list });
  }

  async function doExport() {
    const folder = await open({ directory: true, multiple: false });
    if (!folder || Array.isArray(folder)) return;
    setBusy("Exporting full year archive…");
    try {
      const out = await exportYearArchive({ year, settings, baseFolder: folder as string, onProgress: (m) => setBusy(m) });
      alert(`Archive written to:\n${out}`);
    } catch (e: any) {
      alert("Export failed: " + (e?.message || e));
    } finally { setBusy(null); }
  }

  function openInIframe(html: string) {
    const existing = document.getElementById("__print_frame");
    if (existing) existing.remove();
    const iframe = document.createElement("iframe");
    iframe.id = "__print_frame";
    iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) return;
    doc.open(); doc.write(html); doc.close();
    setTimeout(() => { try { iframe.contentWindow?.focus(); iframe.contentWindow?.print(); } catch {} }, 350);
  }

  const grandTotal = groups.reduce((a, g) => a + g.total, 0);
  const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div>
      <h1>Annual Tax Receipts</h1>
      <p className="subtitle">
        Calendar-year (Jan&ndash;Dec) totals per child for CRA Form T778. Crosses roster years so a child who joined in
        September still gets one receipt per tax year. Voided receipts are excluded.
      </p>

      <div className="toolbar" style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 13, color: "var(--muted)" }}>Tax Year:</label>
        <select value={year} onChange={(e) => setYear(parseInt(e.target.value, 10))}>
          {Array.from({ length: 6 }, (_, i) => now + 1 - i).map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <div className="grow" />
        <button className="btn secondary" onClick={doExport} disabled={!!busy}>Export Year Archive…</button>
      </div>

      {!settings.business_number && (
        <div className="card" style={{ background: "#fff8e1", borderColor: "#e0c66a", marginBottom: 14 }}>
          ⚠️ Your <b>Business Number</b> is not set. CRA receipts should include it.
          Open <b>Settings → Business Information</b> to add it (you can still generate without — but parents may ask).
        </div>
      )}

      {busy && <div className="card" style={{ marginBottom: 12 }}>{busy}</div>}
      {loading ? <div className="empty">Loading…</div> :
        groups.length === 0 ? (
          <div className="empty">No receipts found for {year}.</div>
        ) : (
          <>
            <table className="data">
              <thead>
                <tr>
                  <th>Student</th><th>Parents</th><th>Email on file</th>
                  <th style={{ textAlign: "right" }}># Receipts</th>
                  <th style={{ textAlign: "right" }}>Total</th>
                  <th>Status</th>
                  <th style={{ textAlign: "right" }}></th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const li = g.last_issued;
                  return (
                    <tr key={g.person_id}>
                      <td>{g.student_name}</td>
                      <td style={{ fontSize: 12 }}>
                        {g.father_name || ""}{g.father_name && g.mother_name ? <br /> : ""}{g.mother_name || ""}
                      </td>
                      <td style={{ fontSize: 12 }}>{g.email || "—"}</td>
                      <td style={{ textAlign: "right" }}>{g.count}</td>
                      <td style={{ textAlign: "right", fontWeight: 600 }}>${fmt(g.total)}</td>
                      <td>
                        {li ? (
                          <span title={`${li.ar_number} on ${li.issued_at.slice(0,10)}${li.emailed_at ? " · emailed " + li.emailed_at.slice(0,10) : ""}`}>
                            <span className="badge ok">✓ {li.ar_number}</span>
                            {li.emailed_at && <span style={{ fontSize: 11, marginLeft: 6 }}>✉️</span>}
                          </span>
                        ) : <span className="badge warn">Not issued</span>}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <button className="btn ghost" onClick={() => generatePdf(g, li || undefined)} disabled={!!busy}>
                          {li ? "Re-issue PDF" : "Generate PDF"}
                        </button>
                        <button className="btn ghost" onClick={() => emailFlow(g, li || undefined)} disabled={!!busy || !g.email}>
                          Email
                        </button>
                        <button className="btn ghost" onClick={() => showHistory(g)} disabled={!!busy}>
                          History
                        </button>
                      </td>
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
          </>
        )
      }

      {recipientOverride && (
        <div onClick={(e) => { if (e.target === e.currentTarget) setRecipientOverride(null); }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex",
            alignItems: "flex-start", justifyContent: "center", paddingTop: 120, zIndex: 1000 }}>
          <div className="card" style={{ width: "min(520px, 92vw)", margin: 0 }}>
            <h3 style={{ marginTop: 0 }}>Email Annual Receipt</h3>
            <p style={{ color: "var(--muted)", fontSize: 13 }}>
              {recipientOverride.group.student_name} &mdash; {year} &mdash; ${fmt(recipientOverride.group.total)}
              {recipientOverride.supersede && (
                <><br /><b>This will supersede</b> {recipientOverride.supersede.ar_number}.</>
              )}
            </p>
            <div className="field">
              <label>Recipient email(s) (comma or semicolon separated)</label>
              <input value={recipientOverride.emails}
                onChange={(e) => setRecipientOverride({ ...recipientOverride, emails: e.target.value })}
                autoFocus />
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
              <button className="btn" onClick={doEmail}>Send</button>
              <button className="btn secondary" onClick={() => setRecipientOverride(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {history && (
        <div onClick={(e) => { if (e.target === e.currentTarget) setHistory(null); }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex",
            alignItems: "flex-start", justifyContent: "center", paddingTop: 80, zIndex: 1000 }}>
          <div className="card" style={{ width: "min(680px, 92vw)", maxHeight: "85vh", overflow: "auto", margin: 0 }}>
            <h3 style={{ marginTop: 0 }}>History · {history.group.student_name} · {year}</h3>
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
                      <td>{a.superseded_by ? <span className="badge warn">Superseded</span> : <span className="badge ok">Current</span>}</td>
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
    </div>
  );
}
