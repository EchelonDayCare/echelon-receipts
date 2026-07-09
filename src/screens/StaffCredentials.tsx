import { showAlert, showConfirm, showPrompt } from "../lib/dialogs";
import { useEffect, useMemo, useState } from "react";
import { listStaff } from "../lib/staff";
import {
  DEFAULT_CRED_TYPES,
  defaultExpiryFromIssue,
  credStatus,
  daysUntil,
  listAllCredentialsWithStaff,
  upsertCredential,
  deleteCredential,
} from "../lib/credentials";
import { inactiveLabel } from "../lib/inactiveLabel";
import { getSettings } from "../lib/db";
import type { Staff, StaffCredential } from "../types";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { extractCredential, fileToMime } from "../lib/ai";
import { matchStudentByName } from "../lib/attendance";
import { invoke } from "@tauri-apps/api/core";
import { OcrProgressBanner, CREDENTIAL_OCR_STAGES } from "../components/OcrProgressBanner";

interface Row extends StaffCredential { staff_name: string; staff_active: number; staff_terminated_at: string | null }

const today = () => new Date().toISOString().slice(0, 10);

export default function StaffCredentials() {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [alertDays, setAlertDays] = useState(60);
  const [editing, setEditing] = useState<Partial<Row> | null>(null);
  const [filter, setFilter] = useState<"all" | "expiring" | "expired">("all");
  const [showArchived, setShowArchived] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrBanner, setOcrBanner] = useState<string | null>(null);

  async function refresh() {
    const s = await getSettings();
    setAlertDays(Number(s.staff_cred_alert_days || "60"));
    setStaff(await listStaff(false));
    setRows(await listAllCredentialsWithStaff(showArchived));
  }
  useEffect(() => { refresh(); }, [showArchived]);

  const filtered = useMemo(() => {
    if (filter === "all") return rows;
    return rows.filter((r) => {
      const st = credStatus(r.expiry_date, alertDays);
      return filter === "expiring" ? st === "expiring" : st === "expired";
    });
  }, [rows, filter, alertDays]);

  const summary = useMemo(() => {
    let expiring = 0, expired = 0;
    for (const r of rows) {
      const st = credStatus(r.expiry_date, alertDays);
      if (st === "expiring") expiring++;
      else if (st === "expired") expired++;
    }
    return { expiring, expired, total: rows.length };
  }, [rows, alertDays]);

  async function save() {
    if (!editing || !editing.staff_id || !editing.type) {
      void showAlert("Pick a staff member and a credential type.");
      return;
    }
    try {
      await upsertCredential({
        id: editing.id,
        staff_id: editing.staff_id,
        type: editing.type,
        issued_date: editing.issued_date || null,
        expiry_date: editing.expiry_date || null,
        notes: editing.notes || null,
        file_path: editing.file_path || null,
      });
      setEditing(null);
      setOcrBanner(null);
      await refresh();
    } catch (e: any) {
      void showAlert("Save failed: " + (e?.message || e));
    }
  }

  async function remove(id: number) {
    if (!await showConfirm("Delete this credential record?")) return;
    await deleteCredential(id);
    await refresh();
  }

  function openNew() {
    setEditing({ staff_id: staff[0]?.id, type: DEFAULT_CRED_TYPES[0].type, issued_date: today(), expiry_date: defaultExpiryFromIssue(today(), DEFAULT_CRED_TYPES[0].cadenceYears) });
  }

  // AI upload — reads a credential document, prefills the edit modal for
  // review, and lets the user save with one click. Same OCR pattern as the
  // Monthly Attendance sheet and Visa statement imports.
  async function runExtractOnPath(path: string) {
    if (staff.length === 0) {
      void showAlert("Add a staff member first on the Hours tab.");
      return;
    }
    setOcrBusy(true);
    setOcrBanner("Reading credential…");
    try {
      const bytes = await readFile(path);
      const mime = fileToMime(path);
      const knownTypes = DEFAULT_CRED_TYPES.map((t) => t.type);
      const res = await extractCredential({
        fileBytes: bytes as Uint8Array,
        mimeType: mime,
        knownStaffNames: staff.map((s) => s.name),
        knownCredentialTypes: knownTypes,
      });

      // Map the guessed staff name to a real staff id — fall back to the first
      // staff so the modal still opens for manual reassignment.
      const nameMatch = res.staff_name_guess
        ? matchStudentByName(res.staff_name_guess, staff.map((s) => ({ id: s.id, name: s.name })))
        : null;
      const staff_id = nameMatch?.id ?? staff[0].id;

      // Map the guessed type to a catalog entry; anything else keeps its raw
      // value + drops the "Other" pill (user can edit).
      const typeGuess = (res.credential_type_guess || "").trim();
      const catalogHit = DEFAULT_CRED_TYPES.find((d) => d.type.toLowerCase() === typeGuess.toLowerCase());
      const type = catalogHit ? catalogHit.type : (typeGuess || DEFAULT_CRED_TYPES[0].type);

      // If we don't have an expiry but do have an issue date and a known
      // cadence, derive the expiry so the user doesn't have to.
      let expiry = res.expiry_date || "";
      if (!expiry && res.issued_date && catalogHit) {
        expiry = defaultExpiryFromIssue(res.issued_date, catalogHit.cadenceYears);
      }

      const notesParts: string[] = [];
      if (res.certificate_number) notesParts.push(`Cert #${res.certificate_number}`);
      if (res.issuer) notesParts.push(res.issuer);
      if (res.notes) notesParts.push(res.notes);

      setEditing({
        staff_id,
        type,
        issued_date: res.issued_date || "",
        expiry_date: expiry,
        notes: notesParts.join(" · ") || "",
      });

      const staffLabel = nameMatch ? nameMatch.name : "(pick staff)";
      setOcrBanner(`Read: ${type} for ${staffLabel}${res.expiry_date ? ` (expires ${res.expiry_date})` : ""}. Review and Save.`);
    } catch (e: any) {
      setOcrBanner(null);
      void showAlert("Couldn't read credential: " + (e?.message || e));
    } finally {
      setOcrBusy(false);
    }
  }

  async function pickAndExtractCredential() {
    if (ocrBusy) return;
    if (staff.length === 0) {
      void showAlert("Add a staff member first on the Hours tab.");
      return;
    }
    const picked = await open({
      multiple: false,
      filters: [{ name: "Credential document", extensions: ["jpg","jpeg","png","webp","heic","pdf"] }],
    });
    const path = typeof picked === "string" ? picked : null;
    if (!path) return;
    await runExtractOnPath(path);
  }

  // AirDrop / save-from-iPad workflow: pick up images dropped into ~/Downloads
  // within the last 10 minutes. Mirrors Staff Hours + Monthly Attendance.
  async function importLatestFromDownloads() {
    if (ocrBusy) return;
    if (staff.length === 0) {
      void showAlert("Add a staff member first on the Hours tab.");
      return;
    }
    try {
      const items = await invoke<Array<{ path: string; name: string; modified_secs_ago: number; size: number }>>(
        "inbox_list_recent",
        { withinMinutes: 10, limit: 5 },
      );
      if (!items.length) {
        void showAlert("No image files found in Downloads from the last 10 minutes. AirDrop from iPad and try again.");
        return;
      }
      const fmtMin = (secs: number) => Math.max(1, Math.round(secs / 60));
      const fmtMb = (b: number) => (b / (1024 * 1024)).toFixed(1);
      let picked = items[0];
      if (items.length === 1) {
        const ok = await showConfirm(
          `Import "${picked.name}" (${fmtMin(picked.modified_secs_ago)} min ago, ${fmtMb(picked.size)} MB) for OCR?`,
        );
        if (!ok) return;
      } else {
        const list = items
          .map((it, i) => `${i + 1}. ${it.name}  (${fmtMin(it.modified_secs_ago)} min ago, ${fmtMb(it.size)} MB)`)
          .join("\n");
        const ans = await showPrompt(
          `Multiple recent images in Downloads:\n\n${list}\n\nWhich number to import?`,
          "1",
        );
        if (ans === null) return;
        const n = Number(ans.trim());
        if (!Number.isInteger(n) || n < 1 || n > items.length) {
          void showAlert(`Enter a number from 1 to ${items.length}.`);
          return;
        }
        picked = items[n - 1];
      }
      await runExtractOnPath(picked.path);
    } catch (e: any) {
      void showAlert("Couldn't read Downloads: " + (e?.message || e));
    }
  }

  function onTypeChange(newType: string) {
    setEditing((e) => {
      if (!e) return e;
      const def = DEFAULT_CRED_TYPES.find((d) => d.type === newType);
      const issued = e.issued_date || today();
      return {
        ...e,
        type: newType,
        issued_date: issued,
        expiry_date: def ? defaultExpiryFromIssue(issued, def.cadenceYears) : e.expiry_date,
      };
    });
  }

  function onIssuedChange(newIssued: string) {
    setEditing((e) => {
      if (!e) return e;
      const def = DEFAULT_CRED_TYPES.find((d) => d.type === e.type);
      return {
        ...e,
        issued_date: newIssued,
        expiry_date: def ? defaultExpiryFromIssue(newIssued, def.cadenceYears) : e.expiry_date,
      };
    });
  }

  return (
    <div className="container">
      <div className="page-head">
        <div>
          <h1 style={{ margin: 0 }}>Staff Credentials</h1>
          <p className="subtitle" style={{ margin: "4px 0 0" }}>
            Track ECE, Criminal Record Check, First Aid, TB and annual sign-offs.
            Warns when anything expires within <strong>{alertDays} days</strong> (change in Configuration → Staff).
          </p>
        </div>
        <button className="btn" onClick={openNew} disabled={staff.length === 0}>+ Add credential</button>
      </div>

      {/* Long-wait progress banner for the credential OCR call. */}
      <OcrProgressBanner
        active={ocrBusy}
        stages={CREDENTIAL_OCR_STAGES}
        hint="Reading a certificate typically takes 10-30 seconds."
      />

      {/* Prominent AI upload panel — mirrors the Monthly Attendance sheet panel.
          Same green gradient + NEW pill + AirDrop-from-Downloads shortcut. */}
      <section className="card" style={{ marginBottom: 16, background: "linear-gradient(180deg, #ecfdf5 0%, #ffffff 65%)", borderColor: "#a7f3d0" }}>
        <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ width: 56, height: 56, borderRadius: 12, background: "#d1fae5", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, flexShrink: 0 }}>🎓</div>
          <div style={{ flex: 1, minWidth: 240 }}>
            <h3 style={{ margin: "0 0 4px" }}>Upload a credential</h3>
            <p style={{ margin: 0, color: "var(--muted)", fontSize: 13 }}>
              Snap or scan a certificate (ECE, First Aid, CRC, TB, immunization). Azure AI reads staff name, credential type, issue &amp; expiry dates and pre-fills the form for you.
            </p>
            {staff.length === 0 && (
              <p style={{ margin: "6px 0 0", color: "var(--danger)", fontSize: 13 }}>Add a staff member on the Hours tab first.</p>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "stretch" }}>
            <button
              onClick={importLatestFromDownloads}
              disabled={ocrBusy || staff.length === 0}
              title="Picks the newest image AirDropped or saved to ~/Downloads in the last 10 min"
              style={{
                position: "relative",
                padding: "16px 22px",
                fontSize: 16,
                fontWeight: 700,
                background: "linear-gradient(180deg, #16a34a 0%, #15803d 100%)",
                color: "white",
                border: "none",
                borderRadius: 12,
                cursor: ocrBusy ? "not-allowed" : "pointer",
                boxShadow: "0 4px 14px rgba(22, 163, 74, 0.35)",
                opacity: (ocrBusy || staff.length === 0) ? 0.55 : 1,
                minWidth: 260,
              }}
            >
              <span style={{
                position: "absolute", top: -8, right: -8,
                background: "#f59e0b", color: "white", fontSize: 10,
                padding: "2px 7px", borderRadius: 10, fontWeight: 800, letterSpacing: 0.5,
              }}>NEW</span>
              <div style={{ fontSize: 22, marginBottom: 2 }}>📥 Import from Downloads</div>
              <div style={{ fontSize: 11, fontWeight: 400, opacity: 0.9 }}>
                AirDrop from iPad → click here
              </div>
            </button>
            <button
              className="btn secondary"
              onClick={pickAndExtractCredential}
              disabled={ocrBusy || staff.length === 0}
              style={{ fontSize: 13 }}
            >
              {ocrBusy ? "Reading credential…" : "…or choose file manually"}
            </button>
          </div>
        </div>
      </section>

      {ocrBanner && (
        <div className="card" style={{ padding: "10px 14px", marginBottom: 12, background: "#eff6ff", borderColor: "#93c5fd", color: "#1e3a8a" }}>
          <span style={{ fontSize: 14 }}>✨ {ocrBanner}</span>
        </div>
      )}

      <div className="row" style={{ gap: 10, marginBottom: 14, gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        <SummaryCard label="Total records" value={summary.total} tone="info" />
        <SummaryCard label="Expiring soon" value={summary.expiring} tone="warn" onClick={() => setFilter("expiring")} />
        <SummaryCard label="Expired" value={summary.expired} tone="danger" onClick={() => setFilter("expired")} />
      </div>

      {staff.length === 0 && (
        <div className="card">
          <p style={{ margin: 0 }}>
            Add a staff member on the <strong>Hours</strong> tab first, then come back here to log their credentials.
          </p>
        </div>
      )}

      {staff.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div style={{ display: "flex", gap: 6, padding: "10px 14px", borderBottom: "1px solid var(--border)", alignItems: "center" }}>
            {(["all", "expiring", "expired"] as const).map((k) => (
              <button
                key={k}
                className={"pill" + (filter === k ? " active" : "")}
                onClick={() => setFilter(k)}
                style={{ cursor: "pointer", border: "1px solid var(--border)", background: filter === k ? "var(--accent)" : "#fff", color: filter === k ? "#fff" : "var(--text)" }}
              >
                {k === "all" ? "All" : k === "expiring" ? "Expiring soon" : "Expired"}
              </button>
            ))}
            <label style={{ marginLeft: "auto", fontSize: 13, display: "flex", alignItems: "center", gap: 6 }} title="Show credentials for archived (inactive) staff — useful for handoff and historical audits.">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
              Show archived staff
            </label>
          </div>
          {filtered.length === 0 ? (
            <p style={{ padding: 24, margin: 0, color: "var(--muted)" }}>No credentials match this filter.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Staff</th>
                  <th>Type</th>
                  <th>Issued</th>
                  <th>Expires</th>
                  <th>Status</th>
                  <th>Notes</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const st = credStatus(r.expiry_date, alertDays);
                  const d = daysUntil(r.expiry_date);
                  const tone = st === "expired" ? "danger" : st === "expiring" ? "warn" : st === "ok" ? "ok" : "muted";
                  const label = st === "expired" ? `Expired ${Math.abs(d || 0)}d ago`
                              : st === "expiring" ? `In ${d}d`
                              : st === "ok" ? `OK (${d}d)`
                              : "No date";
                  return (
                    <tr key={r.id} style={r.staff_active ? undefined : { opacity: 0.65 }}>
                      <td>
                        {r.staff_name}
                        {!r.staff_active && (
                          <span style={{ marginLeft: 6, fontStyle: "italic", color: "var(--muted)", fontSize: 12 }}>
                            {inactiveLabel("staff", r.staff_terminated_at)}
                          </span>
                        )}
                      </td>
                      <td>{r.type}</td>
                      <td>{r.issued_date || "—"}</td>
                      <td>{r.expiry_date || "—"}</td>
                      <td><span className={`pill tone-${tone}`}>{label}</span></td>
                      <td style={{ color: "var(--muted)", fontSize: 13 }}>{r.notes || ""}</td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <button className="btn link" onClick={() => setEditing(r)}>Edit</button>
                        <button className="btn link" style={{ color: "var(--danger)" }} onClick={() => remove(r.id)}>Delete</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <div className="card" onClick={(e) => e.stopPropagation()} style={{ width: 520, maxWidth: "92vw" }}>
            <h3 style={{ marginTop: 0 }}>{editing.id ? "Edit credential" : "Add credential"}</h3>
            <div className="field">
              <label>Staff member</label>
              <select
                value={editing.staff_id || ""}
                onChange={(e) => setEditing({ ...editing, staff_id: Number(e.target.value) })}
              >
                {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Credential type</label>
              <select value={editing.type || ""} onChange={(e) => onTypeChange(e.target.value)}>
                {DEFAULT_CRED_TYPES.map((d) => (
                  <option key={d.type} value={d.type}>{d.type} ({d.cadenceYears}yr)</option>
                ))}
                <option value="Other">Other / custom…</option>
              </select>
              {editing.type === "Other" && (
                <input
                  placeholder="Custom credential name"
                  style={{ marginTop: 6 }}
                  onChange={(e) => setEditing({ ...editing, type: e.target.value })}
                />
              )}
            </div>
            <div className="row">
              <div className="field">
                <label>Issued date</label>
                <input type="date" value={editing.issued_date || ""} onChange={(e) => onIssuedChange(e.target.value)} />
              </div>
              <div className="field">
                <label>Expiry date</label>
                <input
                  type="date"
                  value={editing.expiry_date || ""}
                  onChange={(e) => setEditing({ ...editing, expiry_date: e.target.value })}
                />
                <small style={{ color: "var(--muted)" }}>Auto-filled from cadence. Override if your issuer set a different date.</small>
              </div>
            </div>
            <div className="field">
              <label>Notes (optional)</label>
              <textarea
                rows={3}
                value={editing.notes || ""}
                onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                placeholder="Certificate number, issuing body, file location, etc."
              />
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
              <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn" onClick={save}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, tone, onClick }: { label: string; value: number; tone: "info" | "warn" | "danger"; onClick?: () => void }) {
  const bg = tone === "danger" ? "#fef2f2" : tone === "warn" ? "#fffbeb" : "#eff6ff";
  const color = tone === "danger" ? "#991b1b" : tone === "warn" ? "#92400e" : "#1e40af";
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, minWidth: 0, textAlign: "left", padding: "14px 16px", border: "1px solid var(--border)",
        borderRadius: 10, background: bg, color, cursor: onClick ? "pointer" : "default", font: "inherit",
      }}
    >
      <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: ".06em", opacity: .85 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700 }}>{value}</div>
    </button>
  );
}
