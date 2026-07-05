// Waitlist Settings — /waitlist/settings
//
// - Sheet URL / ID + range
// - Service Account JSON (Keychain-backed) — Save / Test / Clear
// - Auto-sync toggle + frequency
// - Manual Sync Now
// - Sync state readout (last synced, last error, row count)
//
// Design notes:
//   • The Service Account JSON textarea is a one-way input: the raw JSON is
//     never re-fetched from the keychain. Once saved, the textarea clears and
//     we only display the masked client_email.
//   • Test Connection uses the unsaved (in-memory) JSON if the box has
//     content; otherwise it falls back to the stored key by re-invoking
//     fetch_rows via a temporary path.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getSettings, setSetting } from "../../lib/db";
import { syncWaitlist, readSyncState, type SyncStateRow } from "../../lib/waitlist";
import { showConfirm } from "../../lib/dialogs";

const SHEET_URL_RE = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/;

export default function WaitlistSettings() {
  const [sheetUrl, setSheetUrl] = useState("");
  const [sheetId, setSheetId] = useState("");
  const [range, setRange] = useState("Form_Responses!A:K");
  const [enabled, setEnabled] = useState(false);
  const [intervalMin, setIntervalMin] = useState("10");
  const [jsonText, setJsonText] = useState("");
  const [credsLoaded, setCredsLoaded] = useState(false);
  const [maskedEmail, setMaskedEmail] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<SyncStateRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const loadAll = async () => {
    const s = await getSettings();
    setSheetId(s.waitlist_sheet_id || "");
    setRange(s.waitlist_sheet_range || "Form_Responses!A:K");
    setEnabled(s.waitlist_sync_enabled === "1");
    setIntervalMin(s.waitlist_sync_interval_min || "10");
    const st = await invoke<{ credentials_loaded: boolean; client_email_masked: string | null }>("waitlist_get_status");
    setCredsLoaded(st.credentials_loaded);
    setMaskedEmail(st.client_email_masked);
    setSyncState(await readSyncState());
  };

  useEffect(() => { void loadAll(); }, []);

  // If the user pastes a full Sheet URL, extract the ID.
  useEffect(() => {
    if (!sheetUrl.trim()) return;
    const m = sheetUrl.match(SHEET_URL_RE);
    if (m && m[1] !== sheetId) setSheetId(m[1]);
  }, [sheetUrl]);

  const saveIds = async () => {
    setBusy("ids");
    try {
      await setSetting("waitlist_sheet_id", sheetId.trim());
      await setSetting("waitlist_sheet_range", range.trim() || "Form_Responses!A:K");
    } finally { setBusy(null); }
  };

  const saveJson = async () => {
    if (!jsonText.trim()) return;
    setBusy("save");
    setTestResult(null);
    try {
      const r = await invoke<{ client_email_masked: string }>("waitlist_save_credentials", { jsonText });
      setMaskedEmail(r.client_email_masked);
      setCredsLoaded(true);
      setJsonText("");
      setTestResult({ ok: true, msg: `Saved. Client email: ${r.client_email_masked}` });
    } catch (e: any) {
      setTestResult({ ok: false, msg: String(e?.message || e) });
    } finally { setBusy(null); }
  };

  const testConn = async () => {
    setBusy("test");
    setTestResult(null);
    try {
      // If the user has typed unsaved JSON, test with that; otherwise attempt
      // a live fetch using the stored key by triggering a sync-style call.
      let payload: string | null = jsonText.trim() ? jsonText : null;
      if (payload) {
        const r = await invoke<{ ok: boolean; row_count: number; error: string | null }>(
          "waitlist_test_connection",
          { jsonText: payload, sheetId, range },
        );
        setTestResult({
          ok: r.ok,
          msg: r.ok ? `OK — ${r.row_count} rows returned.` : (r.error || "Failed."),
        });
      } else {
        // Fall back to a real sync using saved creds.
        const res = await syncWaitlist({ force: true });
        setTestResult({
          ok: res.ok,
          msg: res.ok
            ? `OK — fetched ${res.fetched}, inserted ${res.inserted}, updated ${res.updated}, archived ${res.archived}.`
            : (res.error || "Sync failed."),
        });
        setSyncState(await readSyncState());
      }
    } catch (e: any) {
      setTestResult({ ok: false, msg: String(e?.message || e) });
    } finally { setBusy(null); }
  };

  const clearCreds = async () => {
    if (!(await showConfirm("This will remove the service-account key from Keychain and disable auto-sync.", { title: "Clear waitlist credentials?" }))) return;
    setBusy("clear");
    try {
      await invoke("waitlist_clear_credentials");
      await setSetting("waitlist_sync_enabled", "0");
      setCredsLoaded(false);
      setMaskedEmail(null);
      setEnabled(false);
      setTestResult(null);
    } finally { setBusy(null); }
  };

  const toggleEnabled = async (v: boolean) => {
    setEnabled(v);
    await setSetting("waitlist_sync_enabled", v ? "1" : "0");
  };

  const changeInterval = async (v: string) => {
    setIntervalMin(v);
    await setSetting("waitlist_sync_interval_min", v);
  };

  const syncNow = async () => {
    setBusy("sync");
    try {
      const res = await syncWaitlist({ force: true });
      setSyncState(await readSyncState());
      setTestResult({
        ok: res.ok,
        msg: res.ok
          ? `Fetched ${res.fetched}, inserted ${res.inserted}, updated ${res.updated}, archived ${res.archived}.`
          : (res.error || "Failed."),
      });
    } finally { setBusy(null); }
  };

  return (
    <div>
      <h1>Waitlist — Settings</h1>
      <p className="subtitle">Google Sheet source + service-account credentials for read-only sync.</p>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 14 }}>Google Sheet</h3>
        <div className="field">
          <label>Sheet URL (optional — paste to auto-fill the ID)</label>
          <input
            placeholder="https://docs.google.com/spreadsheets/d/…/edit"
            value={sheetUrl}
            onChange={(e) => setSheetUrl(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Sheet ID</label>
          <input value={sheetId} onChange={(e) => setSheetId(e.target.value)} />
        </div>
        <div className="field">
          <label>Range</label>
          <input value={range} onChange={(e) => setRange(e.target.value)} />
        </div>
        <button className="btn primary" disabled={busy === "ids"} onClick={saveIds}>Save sheet settings</button>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 14 }}>Service Account credentials</h3>
        <div style={{
          background: "#fef2f2", border: "1px solid #fecaca", color: "#7f1d1d",
          padding: 10, borderRadius: 8, fontSize: 12, marginBottom: 12,
        }}>
          ⚠ This JSON is a secret. It is stored in the macOS Keychain and never leaves your Mac.
          Grant your service account <strong>read-only</strong> access to the Sheet — nothing more.
        </div>

        {credsLoaded && maskedEmail && (
          <div style={{ marginBottom: 12, fontSize: 13, color: "var(--muted)" }}>
            Currently loaded: <code>{maskedEmail}</code>
          </div>
        )}

        <div className="field">
          <label>Paste service-account JSON (leaves the box on save)</label>
          <textarea
            rows={10}
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            placeholder='{"type":"service_account","project_id":"…","private_key":"-----BEGIN PRIVATE KEY-----…","client_email":"…@…iam.gserviceaccount.com",…}'
            style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, width: "100%" }}
          />
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn primary" disabled={busy === "save" || !jsonText.trim()} onClick={saveJson}>Save credentials</button>
          <button className="btn" disabled={busy === "test"} onClick={testConn}>Test connection</button>
          {credsLoaded && (
            <button className="btn danger" disabled={busy === "clear"} onClick={clearCreds}>Clear credentials</button>
          )}
        </div>

        {testResult && (
          <div style={{
            marginTop: 12, padding: 10, borderRadius: 8,
            background: testResult.ok ? "#ecfdf5" : "#fef2f2",
            border: "1px solid " + (testResult.ok ? "#a7f3d0" : "#fecaca"),
            color: testResult.ok ? "#065f46" : "#7f1d1d",
            fontSize: 13, wordBreak: "break-word",
          }}>
            {testResult.msg}
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 14 }}>Auto-sync</h3>
        <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => toggleEnabled(e.target.checked)} disabled={!credsLoaded} />
          <span>Enable automatic sync</span>
          {!credsLoaded && <span style={{ color: "var(--muted)", fontSize: 12 }}>(requires credentials)</span>}
        </label>
        <div className="field" style={{ maxWidth: 240 }}>
          <label>Frequency</label>
          <select value={intervalMin} onChange={(e) => changeInterval(e.target.value)}>
            <option value="5">Every 5 minutes</option>
            <option value="10">Every 10 minutes</option>
            <option value="30">Every 30 minutes</option>
            <option value="60">Every 60 minutes</option>
          </select>
        </div>
        <button className="btn" disabled={busy === "sync" || !credsLoaded} onClick={syncNow}>Sync now</button>
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 12px", fontSize: 14 }}>Sync status</h3>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            <tr><td style={{ padding: 6, color: "var(--muted)", fontSize: 13, width: 200 }}>Last attempted</td><td style={{ padding: 6, fontSize: 14 }}>{syncState?.last_synced_at ? new Date(syncState.last_synced_at).toLocaleString() : "never"}</td></tr>
            <tr><td style={{ padding: 6, color: "var(--muted)", fontSize: 13 }}>Last successful</td><td style={{ padding: 6, fontSize: 14 }}>{syncState?.last_success_at ? new Date(syncState.last_success_at).toLocaleString() : "never"}</td></tr>
            <tr><td style={{ padding: 6, color: "var(--muted)", fontSize: 13 }}>Rows seen</td><td style={{ padding: 6, fontSize: 14 }}>{syncState?.row_count ?? 0}</td></tr>
            <tr><td style={{ padding: 6, color: "var(--muted)", fontSize: 13, verticalAlign: "top" }}>Last error</td><td style={{ padding: 6, fontSize: 14, color: syncState?.last_error ? "var(--danger)" : "var(--muted)", wordBreak: "break-word" }}>{syncState?.last_error || "—"}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
