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
import {
  syncWaitlist, readSyncState,
  loadPriorityWeights, savePriorityWeights, DEFAULT_PRIORITY_WEIGHTS,
  type SyncStateRow, type PriorityWeights,
} from "../../lib/waitlist";
import { showAlert, showConfirm } from "../../lib/dialogs";

const SHEET_URL_RE = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/;
const DEFAULT_RANGE = "FormResponse!A:K";

export default function WaitlistSettings() {
  const [sheetUrl, setSheetUrl] = useState("");
  const [sheetId, setSheetId] = useState("");
  const [range, setRange] = useState(DEFAULT_RANGE);
  const [enabled, setEnabled] = useState(false);
  const [intervalMin, setIntervalMin] = useState("720");
  const [jsonText, setJsonText] = useState("");
  const [credsLoaded, setCredsLoaded] = useState(false);
  const [maskedEmail, setMaskedEmail] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<SyncStateRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [weights, setWeights] = useState<PriorityWeights>(DEFAULT_PRIORITY_WEIGHTS);
  const [weightsSaved, setWeightsSaved] = useState<null | "ok" | "err">(null);

  const loadAll = async () => {
    const s = await getSettings();
    setSheetId(s.waitlist_sheet_id || "");
    setRange(s.waitlist_sheet_range || DEFAULT_RANGE);
    setEnabled(s.waitlist_sync_enabled === "1");
    setIntervalMin(s.waitlist_sync_interval_min || "720");
    const st = await invoke<{ credentials_loaded: boolean; client_email_masked: string | null }>("waitlist_get_status");
    setCredsLoaded(st.credentials_loaded);
    setMaskedEmail(st.client_email_masked);
    setSyncState(await readSyncState());
    setWeights(await loadPriorityWeights());
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
      await setSetting("waitlist_sheet_range", range.trim() || DEFAULT_RANGE);
      await showAlert(`Sheet ID: ${sheetId.trim() || "(empty)"}\nRange: ${range.trim() || DEFAULT_RANGE}`, { title: "Sheet settings saved" });
    } catch (e: any) {
      await showAlert(String(e?.message || e), { title: "Could not save sheet settings" });
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
      await showAlert(`Service-account key stored in Keychain.\nClient email: ${r.client_email_masked}`, { title: "Credentials saved" });
    } catch (e: any) {
      const msg = String(e?.message || e);
      setTestResult({ ok: false, msg });
      await showAlert(msg, { title: "Could not save credentials" });
    } finally { setBusy(null); }
  };

  const testConn = async () => {
    setBusy("test");
    setTestResult(null);
    try {
      let payload: string | null = jsonText.trim() ? jsonText : null;
      if (payload) {
        const r = await invoke<{ ok: boolean; row_count: number; error: string | null }>(
          "waitlist_test_connection",
          { jsonText: payload, sheetId, range },
        );
        const msg = r.ok ? `OK — ${r.row_count} rows returned.` : (r.error || "Failed.");
        setTestResult({ ok: r.ok, msg });
        await showAlert(msg, { title: r.ok ? "Connection successful" : "Connection failed" });
      } else {
        const res = await syncWaitlist({ force: true });
        const msg = res.ok
          ? `OK — fetched ${res.fetched}, inserted ${res.inserted}, updated ${res.updated}, archived ${res.archived}.`
          : (res.error || "Sync failed.");
        setTestResult({ ok: res.ok, msg });
        setSyncState(await readSyncState());
        await showAlert(msg, { title: res.ok ? "Connection successful" : "Connection failed" });
      }
    } catch (e: any) {
      const msg = String(e?.message || e);
      setTestResult({ ok: false, msg });
      await showAlert(msg, { title: "Connection failed" });
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
      await showAlert("Service-account key removed from Keychain and auto-sync disabled.", { title: "Credentials cleared" });
    } catch (e: any) {
      await showAlert(String(e?.message || e), { title: "Could not clear credentials" });
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
      <h2 style={{ marginTop: 0 }}>Waitlist</h2>
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
            <option value="10">Every 10 minutes</option>
            <option value="30">Every 30 minutes</option>
            <option value="60">Every hour</option>
            <option value="360">Every 6 hours</option>
            <option value="720">Every 12 hours</option>
            <option value="1440">Every 24 hours</option>
          </select>
        </div>
        <button className="btn" disabled={busy === "sync" || !credsLoaded} onClick={syncNow}>Sync now</button>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ margin: "0 0 4px", fontSize: 14 }}>Priority weights</h3>
        <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 12 }}>
          Tune how strongly each signal influences the priority score. Set a weight to 0 to
          disable a signal entirely. Reset to defaults if the ranking feels off.
        </div>
        {(
          [
            ["retention_per_month", "Retention runway (per month, capped 24)", "Higher = favor kids who will stay longer before BC kindergarten."],
            ["toilet_trained",      "Toilet trained (flat bonus)",             "Big time-saver for the 3-5 room."],
            ["in_building",         "In-building family (flat bonus)",         "Same-building families → foot traffic + easy pickup."],
            ["sibling_current",     "Sibling of current student (flat)",       "Retention & word-of-mouth."],
            ["sibling_alumni",      "Sibling of alumni (flat)",                "Returning family loyalty."],
            ["wait_day",            "Wait time (per day, capped 365 d)",       "Small trickle-up so long-waiters don't get stuck."],
            ["days_per_week",       "Enrollment intensity (per day, 0-5)",     "5-day family scores 5× this weight; full-time falls back to 5 if days/wk blank."],
          ] as [keyof PriorityWeights, string, string][]
        ).map(([key, label, help]) => (
          <div key={key} className="field" style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 12, alignItems: "center" }}>
            <div>
              <label style={{ display: "block", fontSize: 13 }}>{label}</label>
              <div style={{ color: "var(--muted)", fontSize: 11 }}>{help}</div>
            </div>
            <input
              type="number" step="0.1" min="0"
              value={String(weights[key])}
              onChange={(e) => {
                const n = Number(e.target.value);
                setWeights({ ...weights, [key]: Number.isFinite(n) ? n : 0 });
                setWeightsSaved(null);
              }}
            />
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
          <button
            className="btn primary"
            disabled={busy === "weights"}
            onClick={async () => {
              setBusy("weights");
              try {
                await savePriorityWeights(weights);
                setWeightsSaved("ok");
              } catch {
                setWeightsSaved("err");
              } finally { setBusy(null); }
            }}
          >Save weights</button>
          <button
            className="btn"
            onClick={() => { setWeights(DEFAULT_PRIORITY_WEIGHTS); setWeightsSaved(null); }}
          >Reset to defaults</button>
          {weightsSaved === "ok" && <span style={{ color: "var(--success, #166534)", fontSize: 13 }}>✓ Saved</span>}
          {weightsSaved === "err" && <span style={{ color: "var(--danger)", fontSize: 13 }}>Save failed</span>}
        </div>
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
