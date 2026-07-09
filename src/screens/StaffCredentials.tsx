import { showAlert, showConfirm } from "../lib/dialogs";
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
import { getSettings } from "../lib/db";
import type { Staff, StaffCredential } from "../types";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { extractCredential, fileToMime } from "../lib/ai";
import { matchStudentByName } from "../lib/attendance";

interface Row extends StaffCredential { staff_name: string }

const today = () => new Date().toISOString().slice(0, 10);

export default function StaffCredentials() {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [alertDays, setAlertDays] = useState(60);
  const [editing, setEditing] = useState<Partial<Row> | null>(null);
  const [filter, setFilter] = useState<"all" | "expiring" | "expired">("all");
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrBanner, setOcrBanner] = useState<string | null>(null);

  async function refresh() {
    const s = await getSettings();
    setAlertDays(Number(s.staff_cred_alert_days || "60"));
    setStaff(await listStaff(false));
    setRows(await listAllCredentialsWithStaff());
  }
  useEffect(() => { refresh(); }, []);

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
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn ghost" onClick={pickAndExtractCredential} disabled={ocrBusy || staff.length === 0} title="Upload a certificate — AI will pre-fill the form">
            {ocrBusy ? "Reading…" : "📄 Upload credential"}
          </button>
          <button className="btn" onClick={openNew} disabled={staff.length === 0}>+ Add credential</button>
        </div>
      </div>

      {ocrBanner && (
        <div className="card" style={{ padding: "10px 14px", marginBottom: 12, background: "#eff6ff", borderColor: "#93c5fd", color: "#1e3a8a" }}>
          <span style={{ fontSize: 14 }}>✨ {ocrBanner}</span>
        </div>
      )}

      <div className="row" style={{ gap: 10, marginBottom: 14, flexWrap: "nowrap" }}>
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
          <div style={{ display: "flex", gap: 6, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
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
                    <tr key={r.id}>
                      <td>{r.staff_name}</td>
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
