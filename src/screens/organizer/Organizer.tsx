// Organizer / Ops Dashboard — 3-panel workspace:
//   1. Upcoming (fanned-out from credentials, drills, docs, aging, AGM,
//      tax deadlines, CCFRI, actions, followups) with time-window filter
//   2. Recent meetings (5 latest, + "New meeting" button)
//   3. Follow-ups (quick-add + open + recent done)
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { showConfirm } from "../../lib/dialogs";
import { listUpcoming, type UpcomingItem, type UpcomingSource } from "../../repo/organizerRepo";
import { listRecentMeetings, type Meeting } from "../../repo/meetingsRepo";
import {
  listOpenFollowups, listRecentDoneFollowups, createFollowup, toggleFollowupDone, softDeleteFollowup,
  type Followup, type Priority,
} from "../../repo/followupsRepo";
import MeetingDrawer, { type MeetingDrawerState } from "./MeetingDrawer";
import VoiceCaptureModal from "../../components/VoiceCaptureModal";
import OrganizerAiTextPanel from "./OrganizerAiTextPanel";
import { getSettings } from "../../lib/db";
import { isVoiceConfigured, isAiTextConfigured } from "../../lib/voice";

const ALL_WINDOW_DAYS = 36_500;
const WINDOWS = [
  { label: "Today", days: 0 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "60d", days: 60 },
  { label: "90d", days: 90 },
  { label: "All", days: ALL_WINDOW_DAYS },
];

const SOURCE_META: Record<UpcomingSource, { label: string; icon: string }> = {
  credential: { label: "Credential", icon: "🎓" },
  drill:      { label: "Drill",      icon: "🚨" },
  document:   { label: "Document",   icon: "📄" },
  aging:      { label: "A/R",        icon: "💰" },
  agm:        { label: "AGM",        icon: "🏛" },
  tax:        { label: "Tax",        icon: "🧾" },
  ccfri:      { label: "CCFRI",      icon: "🏷" },
  subsidy_annual: { label: "Subsidy", icon: "🎁" },
  action:     { label: "Action",     icon: "✅" },
  followup:   { label: "Follow-up",  icon: "🔔" },
};

const KIND_META: Record<string, { label: string; color: string }> = {
  board:      { label: "Board",      color: "#7c3aed" },
  parent:     { label: "Parent",     color: "#0369a1" },
  staff:      { label: "Staff",      color: "#9333ea" },
  vendor:     { label: "Vendor",     color: "#c2410c" },
  inspection: { label: "Inspection", color: "#dc2626" },
  other:      { label: "Other",      color: "#64748b" },
};

export default function Organizer() {
  const [windowDays, setWindowDays] = useState(30);
  const [upcoming, setUpcoming] = useState<UpcomingItem[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [followups, setFollowups] = useState<Followup[]>([]);
  const [doneFollowups, setDoneFollowups] = useState<Followup[]>([]);
  const [fuFilter, setFuFilter] = useState<"open" | "done" | "all">("open");
  const [enabledSources, setEnabledSources] = useState<Set<UpcomingSource>>(new Set(Object.keys(SOURCE_META) as UpcomingSource[]));
  const [err, setErr] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<MeetingDrawerState>({ mode: "closed" });
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [aiTextEnabled, setAiTextEnabled] = useState(false);
  const [newFu, setNewFu] = useState({ title: "", due: "", priority: "normal" as Priority });

  const refresh = async () => {
    try {
      const [up, mt, fu, doneFu] = await Promise.all([
        listUpcoming(windowDays), listRecentMeetings(5), listOpenFollowups(), listRecentDoneFollowups(20),
      ]);
      setUpcoming(up); setMeetings(mt); setFollowups(fu); setDoneFollowups(doneFu);
    } catch (e: any) { setErr(String(e?.message ?? e)); }
  };
  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [windowDays]);

  // Gate the Voice mic button on Whisper being fully configured. On Luxmi's
  // tenant Azure Policy blocks disableLocalAuth=false so `azure_whisper_key_set`
  // stays "", and this evaluates false — the button stays hidden and she never
  // sees a broken feature. When Whisper becomes reachable, the button appears.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await getSettings();
      if (!cancelled) {
        setVoiceEnabled(isVoiceConfigured(s as Record<string, string>));
        setAiTextEnabled(isAiTextConfigured(s as Record<string, string>));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(
    () => upcoming.filter((i) => enabledSources.has(i.source) && (windowDays === 0 ? i.daysAway <= 0 : i.daysAway <= windowDays)),
    [upcoming, enabledSources, windowDays],
  );

  const toggleSource = (s: UpcomingSource) => setEnabledSources((cur) => {
    const nx = new Set(cur); nx.has(s) ? nx.delete(s) : nx.add(s); return nx;
  });
  const allSources = () => setEnabledSources(new Set(Object.keys(SOURCE_META) as UpcomingSource[]));
  const noSources  = () => setEnabledSources(new Set());

  async function addFu() {
    if (!newFu.title.trim()) return;
    try {
      await createFollowup({ title: newFu.title.trim(), dueDate: newFu.due || null, priority: newFu.priority });
      setNewFu({ title: "", due: "", priority: "normal" });
      await refresh();
    } catch (e: any) { setErr(String(e?.message ?? e)); }
  }

  // Counts by severity, for the header summary
  const counts = useMemo(() => {
    let overdue = 0, today = 0, soon = 0;
    for (const i of filtered) {
      if (i.daysAway < 0) overdue++;
      else if (i.daysAway === 0) today++;
      else if (i.daysAway <= 7) soon++;
    }
    return { overdue, today, soon, total: filtered.length };
  }, [filtered]);

  return (
    <div className="org-layout">
      <div className="org-main">
        {/* ── Header ─────────────────────────────────────────────────── */}
        <div className="org-header">
          <div>
            <h1 className="org-title">Organizer</h1>
            <div className="org-subtitle">
              {counts.overdue > 0 && <span className="org-hdr-stat overdue">{counts.overdue} overdue</span>}
              {counts.today   > 0 && <span className="org-hdr-stat today">{counts.today} today</span>}
              {counts.soon    > 0 && <span className="org-hdr-stat soon">{counts.soon} within 7 days</span>}
              {counts.total   === 0 && <span className="org-hdr-stat calm">All clear 🎉</span>}
            </div>
          </div>
          <div className="org-header-actions">
            {voiceEnabled && (
              <button className="btn secondary" onClick={() => setVoiceOpen(true)} title="Dictate a meeting, follow-up or action">
                🎤 Voice add
              </button>
            )}
            <button className="btn secondary" onClick={() => window.print()}>Print</button>
          </div>
        </div>

        {err && <div className="org-err">{err}</div>}

        {aiTextEnabled && <OrganizerAiTextPanel onSaved={() => { void refresh(); }} />}

        {/* ── Upcoming panel ─────────────────────────────────────────── */}
        <section className="card org-panel">
          <div className="org-panel-head">
            <h2>Upcoming</h2>
            <div className="org-segmented">
              {WINDOWS.map((w) => (
                <button
                  key={w.days} type="button"
                  className={`org-seg ${windowDays === w.days ? "on" : ""}`}
                  onClick={() => setWindowDays(w.days)}
                >{w.label}</button>
              ))}
            </div>
          </div>

          <div className="org-filters">
            {(Object.keys(SOURCE_META) as UpcomingSource[]).map((s) => {
              const on = enabledSources.has(s);
              return (
                <button
                  key={s} type="button"
                  className={`org-filter ${on ? "on" : ""}`}
                  onClick={() => toggleSource(s)}
                >
                  <span className="org-filter-icon">{SOURCE_META[s].icon}</span>
                  {SOURCE_META[s].label}
                </button>
              );
            })}
            <div className="org-filter-sep" />
            <button type="button" className="btn link" onClick={allSources}>All</button>
            <button type="button" className="btn link" onClick={noSources}>None</button>
          </div>

          {filtered.length === 0 ? (
            <div className="empty">Nothing due in this window. 🎉</div>
          ) : (
            <div className="org-rows">
              {filtered.map((i) => (
                <div key={i.id} className="org-row">
                  <div className={`org-when ${sevClass(i)}`}>{whenLabel(i.daysAway)}</div>
                  <div className="org-src" title={SOURCE_META[i.source].label}>
                    <span className="org-src-icon">{SOURCE_META[i.source].icon}</span>
                    <span className="org-src-label">{SOURCE_META[i.source].label}</span>
                  </div>
                  <div className="org-body">
                    <div className="org-body-title">{i.title}</div>
                    {i.detail && <div className="org-body-detail">{i.detail}</div>}
                  </div>
                  <div className="org-due">{i.dueDate}</div>
                  <div className="org-cta">
                    {i.link && <Link to={i.link} className="btn secondary sm">Open →</Link>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Meetings panel ─────────────────────────────────────────── */}
        <section className="card org-panel">
          <div className="org-panel-head">
            <h2>Recent meetings</h2>
            <button className="btn" onClick={() => setDrawer({ mode: "new" })}>＋ New meeting</button>
          </div>
          {meetings.length === 0 ? (
            <div className="empty">No meetings logged yet.</div>
          ) : (
            <div className="org-rows">
              {meetings.map((m) => {
                const km = KIND_META[m.kind] ?? KIND_META.other;
                return (
                  <div key={m.id} className="org-row clickable" onClick={() => setDrawer({ mode: "edit", meeting: m })}>
                    <div className="org-when calm">{m.meetingDate}{m.meetingTime ? ` · ${m.meetingTime}` : ""}</div>
                    <div className="org-src">
                      <span className="org-kind-dot" style={{ background: km.color }} />
                      <span className="org-src-label">{km.label}</span>
                    </div>
                    <div className="org-body">
                      <div className="org-body-title">{m.subject}</div>
                      {m.attendeesText && <div className="org-body-detail">{m.attendeesText}</div>}
                    </div>
                    <div className="org-due" />
                    <div className="org-cta">
                      <span className="btn link">Open →</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
        {/* ── Notes moved to its own screen (Organizer → Notes) ─────── */}
      </div>
      <aside className="org-side">
        <section className="card org-panel">
          <div className="org-panel-head">
            <h2>Follow-ups</h2>
            <div className="org-segmented sm">
              {(["open", "done", "all"] as const).map((f) => (
                <button key={f} type="button"
                  className={`org-seg ${fuFilter === f ? "on" : ""}`}
                  onClick={() => setFuFilter(f)}>
                  {f === "open" ? "Open" : f === "done" ? "Done" : "All"}
                </button>
              ))}
            </div>
          </div>

          <div className="org-fu-add">
            <input
              placeholder="Quick add…" value={newFu.title}
              onChange={(e) => setNewFu((v) => ({ ...v, title: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") addFu(); }}
            />
            <div className="org-fu-add-row">
              <input type="date" value={newFu.due}
                onChange={(e) => setNewFu((v) => ({ ...v, due: e.target.value }))} />
              <select value={newFu.priority}
                onChange={(e) => setNewFu((v) => ({ ...v, priority: e.target.value as Priority }))}>
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
              </select>
              <button className="btn" onClick={addFu} disabled={!newFu.title.trim()}>Add</button>
            </div>
          </div>

          {(fuFilter === "open" || fuFilter === "all") && (
            <>
              {fuFilter === "all" && <div className="org-fu-sect">Open</div>}
              {followups.length === 0 ? (
                <div className="empty sm">No open follow-ups.</div>
              ) : (
                <ul className="org-fu-list">
                  {followups.map((f) => (
                    <li key={f.id} className="org-fu">
                      <input type="checkbox" checked={!!f.doneAt}
                        onChange={async () => { await toggleFollowupDone(f.id, f.version); await refresh(); }} />
                      {f.priority === "high" && <span className="org-fu-dot high" title="High priority" />}
                      {f.priority === "low"  && <span className="org-fu-dot low"  title="Low priority" />}
                      <div className="org-fu-body">
                        <div className="org-fu-title">{f.title}</div>
                        {f.dueDate && <div className="org-fu-meta">due {f.dueDate}</div>}
                      </div>
                      <button className="btn link danger" title="Delete"
                        onClick={async () => { if (await showConfirm("Delete?")) { await softDeleteFollowup(f.id, f.version); await refresh(); } }}>
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {(fuFilter === "done" || fuFilter === "all") && (
            <>
              {fuFilter === "all" && <div className="org-fu-sect">Done</div>}
              {doneFollowups.length === 0 ? (
                <div className="empty sm">No completed follow-ups yet.</div>
              ) : (
                <ul className="org-fu-list">
                  {doneFollowups.map((f) => (
                    <li key={f.id} className="org-fu done">
                      <input type="checkbox" checked={!!f.doneAt}
                        onChange={async () => { await toggleFollowupDone(f.id, f.version); await refresh(); }} />
                      <div className="org-fu-body">
                        <div className="org-fu-title">{f.title}</div>
                        {f.doneAt && <div className="org-fu-meta">done {f.doneAt.slice(0, 10)}</div>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      </aside>

      <MeetingDrawer state={drawer} onClose={() => setDrawer({ mode: "closed" })} onSaved={() => { void refresh(); }} />
      <VoiceCaptureModal open={voiceOpen} onClose={() => setVoiceOpen(false)} onSaved={() => { void refresh(); }} />
    </div>
  );
}

function sevClass(i: UpcomingItem): string {
  if (i.daysAway < 0) return "overdue";
  if (i.daysAway === 0) return "today";
  if (i.daysAway <= 7) return "soon";
  return "calm";
}
function whenLabel(d: number): string {
  if (d < 0)  return `${-d}d late`;
  if (d === 0) return "today";
  if (d < 7)  return `in ${d}d`;
  if (d < 30) return `in ${Math.round(d / 7)}w`;
  return `in ${Math.round(d / 30)}mo`;
}
