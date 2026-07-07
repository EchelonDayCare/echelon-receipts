import { useEffect, useState } from "react";
import { getSettings as getAppSettings, setSetting as setAppSetting } from "../lib/db";
import {
  getSettings as getNotifSettings,
  setEnabled,
  setMinSeverity,
  upsertByDedupKey,
  type Severity,
  type NotificationSetting,
} from "../repo/notificationsRepo";
import { SCANNERS } from "../lib/notifications/scanners";
import { runScanNow } from "../lib/notifications/scheduler";

const MONTHS = ["01","02","03","04","05","06","07","08","09","10","11","12"];
const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function MmDdPicker({ value, onChange }: { value: string; onChange: (mmdd: string) => void }) {
  const parsed = /^(\d{2})-(\d{2})$/.exec(value || "");
  const mm = parsed?.[1] || "";
  const dd = parsed?.[2] || "";
  const daysInMonth = mm ? new Date(2024, Number(mm), 0).getDate() : 31;
  return (
    <span style={{ display: "inline-flex", gap: 6 }}>
      <select value={mm} onChange={e => onChange(e.target.value ? `${e.target.value}-${(dd || "01").padStart(2,"0")}` : "")}>
        <option value="">(not set)</option>
        {MONTHS.map((m, i) => <option key={m} value={m}>{MONTH_LABELS[i]}</option>)}
      </select>
      <select value={dd} onChange={e => onChange(mm ? `${mm}-${e.target.value.padStart(2,"0")}` : "")} disabled={!mm}>
        <option value="">(day)</option>
        {Array.from({ length: daysInMonth }, (_, i) => String(i + 1).padStart(2, "0")).map(d => <option key={d} value={d}>{Number(d)}</option>)}
      </select>
    </span>
  );
}

// Outlook-style multi-date chip editor. Value is the comma-joined MM-DD
// string stored in settings; internally we parse to an array, render as
// chips, and re-join on every change so the persisted format never changes.
function MmDdMultiPicker({
  value, onChange, placeholderHint,
}: {
  value: string;
  onChange: (csv: string) => void;
  placeholderHint?: string;
}) {
  const dates = value.split(",").map(x => x.trim()).filter(x => /^\d{2}-\d{2}$/.test(x));
  // Sort chronologically for a sensible visual order (Jan → Dec).
  const sorted = [...dates].sort();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  function commit(next: string[]) {
    const uniq = Array.from(new Set(next)).sort();
    onChange(uniq.join(","));
  }
  function remove(d: string) {
    commit(sorted.filter(x => x !== d));
  }
  function labelFor(d: string): string {
    const m = /^(\d{2})-(\d{2})$/.exec(d);
    if (!m) return d;
    return `${MONTH_LABELS[Number(m[1]) - 1]} ${Number(m[2])}`;
  }
  function confirmAdd() {
    if (/^\d{2}-\d{2}$/.test(draft) && !sorted.includes(draft)) {
      commit([...sorted, draft]);
    }
    setDraft("");
    setAdding(false);
  }

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", minHeight: 32 }}>
      {sorted.length === 0 && !adding && (
        <span style={{ color: "var(--muted)", fontSize: 12, fontStyle: "italic" }}>
          No dates set. {placeholderHint ? `(${placeholderHint})` : ""}
        </span>
      )}
      {sorted.map(d => (
        <span
          key={d}
          style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            background: "var(--chip-bg, #eef2ff)",
            color: "var(--chip-fg, #3730a3)",
            border: "1px solid var(--chip-border, #c7d2fe)",
            borderRadius: 999, padding: "3px 4px 3px 10px", fontSize: 12,
            fontWeight: 500,
          }}
        >
          {labelFor(d)}
          <button
            type="button"
            onClick={() => remove(d)}
            title="Remove"
            aria-label={`Remove ${labelFor(d)}`}
            style={{
              background: "transparent", border: "none", cursor: "pointer",
              padding: "0 4px", color: "inherit", opacity: 0.6, fontSize: 14,
              lineHeight: 1,
            }}
            onMouseOver={e => (e.currentTarget.style.opacity = "1")}
            onMouseOut={e => (e.currentTarget.style.opacity = "0.6")}
          >×</button>
        </span>
      ))}
      {adding ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <MmDdPicker value={draft} onChange={setDraft} />
          <button
            type="button"
            className="btn"
            onClick={confirmAdd}
            disabled={!/^\d{2}-\d{2}$/.test(draft)}
            style={{ padding: "3px 10px", fontSize: 12 }}
          >Add</button>
          <button
            type="button"
            className="btn secondary"
            onClick={() => { setDraft(""); setAdding(false); }}
            style={{ padding: "3px 10px", fontSize: 12 }}
          >Cancel</button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          style={{
            background: "transparent",
            border: "1px dashed var(--border, #cbd5e1)",
            color: "var(--muted)",
            borderRadius: 999, padding: "3px 10px", fontSize: 12, cursor: "pointer",
          }}
        >+ Add date</button>
      )}
    </div>
  );
}

export default function NotificationsSettingsSection() {
  const [prefs, setPrefs] = useState<Map<string, NotificationSetting>>(new Map());
  const [agmMmdd, setAgmMmdd] = useState("");
  const [tslipMmdd, setTslipMmdd] = useState("02-28");
  const [ccfriDay, setCcfriDay] = useState("15");
  const [wcbDays, setWcbDays] = useState("04-20,07-20,10-20,01-20");
  const [staffMeetingDays, setStaffMeetingDays] = useState("08-31,11-30,02-28,05-31");
  const [remitDay, setRemitDay] = useState("12");
  const [quietStart, setQuietStart] = useState("");
  const [quietEnd, setQuietEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [loaded, setLoaded] = useState(false);

  async function refresh() {
    const p = await getNotifSettings();
    setPrefs(p);
    const s = await getAppSettings();
    setAgmMmdd(s.notif_agm_reminder_mmdd || "");
    setTslipMmdd(s.notif_tslip_reminder_mmdd || "02-28");
    setCcfriDay(s.notif_ccfri_claim_day_of_month || "15");
    setWcbDays(s.notif_wcb_days || "04-20,07-20,10-20,01-20");
    setStaffMeetingDays(s.notif_staff_meeting_days || "08-31,11-30,02-28,05-31");
    setRemitDay(s.notif_remittance_day_of_month || "12");
    setQuietStart(s.notif_quiet_hours_start || "");
    setQuietEnd(s.notif_quiet_hours_end || "");
    setLoaded(true);
  }
  useEffect(() => { void refresh(); }, []);

  async function saveDates() {
    if (!loaded) return; // guard: don't write hard-coded defaults over real values before refresh() resolves
    setBusy(true); setMsg("");
    try {
      await setAppSetting("notif_agm_reminder_mmdd", agmMmdd);
      await setAppSetting("notif_tslip_reminder_mmdd", tslipMmdd);
      await setAppSetting("notif_ccfri_claim_day_of_month", ccfriDay);
      await setAppSetting("notif_wcb_days", wcbDays);
      await setAppSetting("notif_staff_meeting_days", staffMeetingDays);
      await setAppSetting("notif_remittance_day_of_month", remitDay);
      await setAppSetting("notif_quiet_hours_start", quietStart);
      await setAppSetting("notif_quiet_hours_end", quietEnd);
      await runScanNow();
      setMsg("Saved and rescanned.");
    } finally { setBusy(false); }
  }

  async function testNotification() {
    await upsertByDedupKey({
      category: "system_error",
      severity: "info",
      title: "Test notification",
      body: `Fired at ${new Date().toLocaleString()}`,
      dedup_key: `system_error:test:manual:${Date.now()}`,
      action_route: "/notifications",
    });
    setMsg("Test notification created — check the bell.");
  }

  return (
    <div>
      <h2 style={{ marginTop: 12 }}>Notifications</h2>
      <p className="subtitle" style={{ marginTop: 0 }}>
        Control what the bell surfaces. All reminders repeat every year automatically —
        pick a month and day, no year needed.
      </p>

      <section style={{ background: "var(--card,#f9fafb)", border: "1px solid var(--border)", borderRadius: 10, padding: 16, marginBottom: 16 }}>
        <h3 style={{ marginTop: 0, fontSize: 15 }}>Recurring dates</h3>
        <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: "10px 16px", alignItems: "center" }}>
          <label>AGM date</label>
          <div>
            <MmDdPicker value={agmMmdd} onChange={setAgmMmdd} />
            <small style={{ color: "var(--muted)", marginLeft: 8 }}>Repeats yearly. Leave unset to disable.</small>
          </div>
          <label>T-slip deadline</label>
          <div>
            <MmDdPicker value={tslipMmdd} onChange={setTslipMmdd} />
            <small style={{ color: "var(--muted)", marginLeft: 8 }}>Default Feb 28.</small>
          </div>
          <label>CCFRI monthly claim day</label>
          <div>
            <select value={ccfriDay} onChange={e => setCcfriDay(e.target.value)}>
              {Array.from({ length: 28 }, (_, i) => String(i + 1)).map(d => <option key={d} value={d}>{d}</option>)}
            </select>
            <small style={{ color: "var(--muted)", marginLeft: 8 }}>Day of each month.</small>
          </div>
          <label>WCB quarterly dates</label>
          <div>
            <MmDdMultiPicker
              value={wcbDays}
              onChange={setWcbDays}
              placeholderHint="e.g. Apr 20, Jul 20, Oct 20, Jan 20"
            />
            <small style={{ color: "var(--muted)", display: "block", marginTop: 4 }}>
              Fires 1 week before each date.
            </small>
          </div>
          <label>Staff meeting dates</label>
          <div>
            <MmDdMultiPicker
              value={staffMeetingDays}
              onChange={setStaffMeetingDays}
              placeholderHint="e.g. Aug 31, Nov 30, Feb 28, May 31"
            />
            <small style={{ color: "var(--muted)", display: "block", marginTop: 4 }}>
              Quarterly. Fires 1 week before — i.e. from the Wednesday of the previous week if the meeting is on a Wednesday.
            </small>
          </div>
          <label>Payroll remittance day</label>
          <div>
            <select value={remitDay} onChange={e => setRemitDay(e.target.value)}>
              {Array.from({ length: 28 }, (_, i) => String(i + 1)).map(d => <option key={d} value={d}>{d}</option>)}
            </select>
            <small style={{ color: "var(--muted)", marginLeft: 8 }}>Day of each month. Fires 1 week before.</small>
          </div>
          <label>Quiet hours</label>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="time" value={quietStart} onChange={e => setQuietStart(e.target.value)} />
            <span>to</span>
            <input type="time" value={quietEnd} onChange={e => setQuietEnd(e.target.value)} />
            <small style={{ color: "var(--muted)" }}>Desktop pings suppressed. Bell still updates.</small>
          </div>
        </div>
        <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center" }}>
          <button className="btn" onClick={saveDates} disabled={busy || !loaded}>{busy ? "Saving…" : loaded ? "Save & Rescan" : "Loading…"}</button>
          <button className="btn secondary" onClick={testNotification}>Test notification</button>
          {msg && <span style={{ color: "var(--muted)", fontSize: 12 }}>{msg}</span>}
        </div>
      </section>

      <section style={{ background: "var(--card,#f9fafb)", border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}>
        <h3 style={{ marginTop: 0, fontSize: 15 }}>Per-category preferences</h3>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--muted)" }}>
              <th style={{ padding: 6 }}>Category</th>
              <th style={{ padding: 6, width: 90 }}>Enabled</th>
              <th style={{ padding: 6, width: 160 }}>Min severity</th>
            </tr>
          </thead>
          <tbody>
            {SCANNERS.map(sc => {
              const p = prefs.get(sc.category);
              const enabled = p ? p.enabled === 1 : true;
              const minSev: Severity = (p?.min_severity || "info") as Severity;
              return (
                <tr key={sc.category} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ padding: 8 }}>{sc.label}</td>
                  <td style={{ padding: 8 }}>
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={async (e) => { await setEnabled(sc.category, e.target.checked); await refresh(); }}
                    />
                  </td>
                  <td style={{ padding: 8 }}>
                    <select
                      value={minSev}
                      onChange={async (e) => { await setMinSeverity(sc.category, e.target.value as Severity); await refresh(); }}
                    >
                      <option value="info">Info and up</option>
                      <option value="warning">Warning and up</option>
                      <option value="critical">Critical only</option>
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn primary" onClick={saveDates} disabled={busy || !loaded}>
            {busy ? "Saving…" : loaded ? "Save all & rescan" : "Loading…"}
          </button>
          <small style={{ color: "var(--muted)" }}>
            Per-category toggles above save instantly. Use this to save the recurring dates and re-run the scan now.
          </small>
          {msg && <span style={{ color: "var(--muted)", fontSize: 12 }}>{msg}</span>}
        </div>
      </section>
    </div>
  );
}
