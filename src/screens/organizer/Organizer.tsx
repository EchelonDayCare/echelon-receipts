// Organizer / Ops Dashboard — single page with 3 panels:
//   1. Upcoming (fanned-out from credentials, drills, docs, aging, AGM,
//      tax deadlines, CCFRI, actions, followups) with time-window filter
//   2. Recent meetings (5 latest, + "New meeting" button)
//   3. Follow-ups (quick-add + open + recent done)
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { listUpcoming, type UpcomingItem, type UpcomingSource } from "../../repo/organizerRepo";
import { listRecentMeetings, type Meeting } from "../../repo/meetingsRepo";
import {
  listOpenFollowups, listRecentDoneFollowups, createFollowup, toggleFollowupDone, softDeleteFollowup,
  type Followup, type Priority,
} from "../../repo/followupsRepo";
import MeetingDrawer, { type MeetingDrawerState } from "./MeetingDrawer";
import VoiceCaptureModal from "../../components/VoiceCaptureModal";

// H-13: "All" wasn't offered even though it's in spec-3-organizer.md's
// filter bar (`Today | Next 7 days | Next 30 days | Next 90 days | All`).
// Modelled as a very large window rather than a separate code path since
// listUpcoming/daysAway comparisons already just work with `<= windowDays`.
const ALL_WINDOW_DAYS = 36_500;
const WINDOWS = [
  { label: "Today", days: 0 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "60 days", days: 60 },
  { label: "90 days", days: 90 },
  { label: "All", days: ALL_WINDOW_DAYS },
];

const SOURCE_LABELS: Record<UpcomingSource, string> = {
  credential: "Credential", drill: "Drill", document: "Document",
  aging: "A/R", agm: "AGM", tax: "Tax", ccfri: "CCFRI",
  subsidy_annual: "Subsidy", action: "Action", followup: "Follow-up",
};

export default function Organizer() {
  const [windowDays, setWindowDays] = useState(30);
  const [upcoming, setUpcoming] = useState<UpcomingItem[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [followups, setFollowups] = useState<Followup[]>([]);
  const [doneFollowups, setDoneFollowups] = useState<Followup[]>([]);
  const [fuFilter, setFuFilter] = useState<"open" | "done" | "all">("open");
  const [enabledSources, setEnabledSources] = useState<Set<UpcomingSource>>(new Set(Object.keys(SOURCE_LABELS) as UpcomingSource[]));
  const [err, setErr] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<MeetingDrawerState>({ mode: "closed" });
  const [voiceOpen, setVoiceOpen] = useState(false);

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

  const filtered = useMemo(
    () => upcoming.filter((i) => enabledSources.has(i.source) && (windowDays === 0 ? i.daysAway <= 0 : i.daysAway <= windowDays)),
    [upcoming, enabledSources, windowDays],
  );

  const toggleSource = (s: UpcomingSource) => setEnabledSources((cur) => {
    const nx = new Set(cur); nx.has(s) ? nx.delete(s) : nx.add(s); return nx;
  });

  async function addFu() {
    if (!newFu.title.trim()) return;
    try {
      await createFollowup({ title: newFu.title.trim(), dueDate: newFu.due || null, priority: newFu.priority });
      setNewFu({ title: "", due: "", priority: "normal" });
      await refresh();
    } catch (e: any) { setErr(String(e?.message ?? e)); }
  }

  return (
    <div style={{ padding: 24, display: "grid", gridTemplateColumns: "2fr 1fr", gap: 20 }}>
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
          <h1 style={{ margin: 0 }}>Organizer</h1>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn primary"
              onClick={() => setVoiceOpen(true)}
              title="Dictate a meeting, follow-up or action"
              style={{ display: "flex", alignItems: "center", gap: 6 }}
            >
              <span aria-hidden style={{ fontSize: 15 }}>🎤</span>
              <span>Voice add</span>
            </button>
            <button className="btn" onClick={() => window.print()}>Print PDF</button>
          </div>
        </div>

        {err && <div style={errBox}>{err}</div>}

        {/* ── Upcoming panel ─────────────────────────────────────────── */}
        <section style={panel}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 8, flexWrap: "wrap" }}>
            <h2 style={{ margin: 0 }}>Upcoming</h2>
            <div style={{ display: "flex", gap: 4 }}>
              {WINDOWS.map((w) => (
                <button key={w.days} className={"btn" + (windowDays === w.days ? " primary" : "")} onClick={() => setWindowDays(w.days)}>
                  {w.label}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            {(Object.keys(SOURCE_LABELS) as UpcomingSource[]).map((s) => (
              <button key={s} className={"btn" + (enabledSources.has(s) ? " primary" : "")} onClick={() => toggleSource(s)} style={{ fontSize: 11 }}>
                {SOURCE_LABELS[s]}
              </button>
            ))}
          </div>
          {filtered.length === 0 ? (
            <div style={emptyBox}>Nothing due in this window. 🎉</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <tbody>
                {filtered.map((i) => (
                  <tr key={i.id} style={{ borderTop: "1px solid var(--border, #1e293b)" }}>
                    <td style={{ padding: 8, width: 90 }}>
                      <span style={pill(i.severity)}>{i.daysAway < 0 ? `${-i.daysAway}d late` : i.daysAway === 0 ? "today" : `${i.daysAway}d`}</span>
                    </td>
                    <td style={{ padding: 8, width: 90, color: "var(--muted)", fontSize: 11 }}>{SOURCE_LABELS[i.source]}</td>
                    <td style={{ padding: 8 }}>
                      <div><b>{i.title}</b></div>
                      {i.detail && <div style={{ fontSize: 11, color: "var(--muted)" }}>{i.detail}</div>}
                    </td>
                    <td style={{ padding: 8, textAlign: "right", whiteSpace: "nowrap", color: "var(--muted)", fontSize: 11 }}>{i.dueDate}</td>
                    <td style={{ padding: 8, width: 50 }}>
                      {i.link && <Link to={i.link} className="btn" style={{ fontSize: 11 }}>Open</Link>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* ── Meetings panel ─────────────────────────────────────────── */}
        <section style={panel}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>Recent meetings</h2>
            <button className="btn primary" onClick={() => setDrawer({ mode: "new" })}>+ New meeting</button>
          </div>
          {meetings.length === 0 ? (
            <div style={emptyBox}>No meetings logged yet.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <tbody>
                {meetings.map((m) => (
                  <tr key={m.id} style={{ borderTop: "1px solid var(--border, #1e293b)", cursor: "pointer" }} onClick={() => setDrawer({ mode: "edit", meeting: m })}>
                    <td style={{ padding: 8, width: 110, color: "var(--muted)", fontSize: 12 }}>{m.meetingDate}{m.meetingTime ? ` ${m.meetingTime}` : ""}</td>
                    <td style={{ padding: 8, width: 90 }}><span style={kindPill(m.kind)}>{m.kind}</span></td>
                    <td style={{ padding: 8 }}>
                      <div><b>{m.subject}</b></div>
                      {m.attendeesText && <div style={{ fontSize: 11, color: "var(--muted)" }}>{m.attendeesText}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {/* ── Follow-ups sidebar ───────────────────────────────────────── */}
      <div>
        <section style={panel}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
            <h2 style={{ margin: 0 }}>Follow-ups</h2>
            <div style={{ display: "flex", gap: 4 }}>
              {(["open", "done", "all"] as const).map((f) => (
                <button key={f} className={"btn" + (fuFilter === f ? " primary" : "")} style={{ fontSize: 11 }} onClick={() => setFuFilter(f)}>
                  {f === "open" ? "Open" : f === "done" ? "Done" : "All"}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: "grid", gap: 6, marginBottom: 12 }}>
            <input placeholder="New follow-up…" value={newFu.title} onChange={(e) => setNewFu((v) => ({ ...v, title: e.target.value }))} onKeyDown={(e) => { if (e.key === "Enter") addFu(); }} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 6 }}>
              <input type="date" value={newFu.due} onChange={(e) => setNewFu((v) => ({ ...v, due: e.target.value }))} />
              <select value={newFu.priority} onChange={(e) => setNewFu((v) => ({ ...v, priority: e.target.value as Priority }))}>
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
              </select>
              <button className="btn primary" onClick={addFu} disabled={!newFu.title.trim()}>Add</button>
            </div>
          </div>
          {(fuFilter === "open" || fuFilter === "all") && (
            followups.length === 0 ? (
              <div style={emptyBox}>No open follow-ups.</div>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {followups.map((f) => (
                  <li key={f.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: 8, borderTop: "1px solid var(--border, #1e293b)" }}>
                    <input type="checkbox" checked={!!f.doneAt} onChange={async () => { await toggleFollowupDone(f.id, f.version); await refresh(); }} />
                    <div style={{ flex: 1, fontSize: 13 }}>
                      <div style={{ textDecoration: f.doneAt ? "line-through" : "none" }}>
                        <b>{f.title}</b>
                        {f.priority === "high" && <span style={{ marginLeft: 6, color: "#dc2626", fontSize: 10 }}>HIGH</span>}
                      </div>
                      {f.dueDate && <div style={{ fontSize: 11, color: "var(--muted)" }}>due {f.dueDate}</div>}
                    </div>
                    <button className="btn" onClick={async () => { if (confirm("Delete?")) { await softDeleteFollowup(f.id, f.version); await refresh(); } }} style={{ fontSize: 10, padding: "2px 6px" }}>✕</button>
                  </li>
                ))}
              </ul>
            )
          )}
          {(fuFilter === "done" || fuFilter === "all") && (
            <>
              {fuFilter === "all" && <h3 style={{ fontSize: 12, color: "var(--muted)", margin: "14px 0 4px" }}>Done</h3>}
              {doneFollowups.length === 0 ? (
                <div style={emptyBox}>No completed follow-ups yet.</div>
              ) : (
                <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {doneFollowups.map((f) => (
                    <li key={f.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: 8, borderTop: "1px solid var(--border, #1e293b)", opacity: 0.7 }}>
                      <input type="checkbox" checked={!!f.doneAt} onChange={async () => { await toggleFollowupDone(f.id, f.version); await refresh(); }} />
                      <div style={{ flex: 1, fontSize: 13 }}>
                        <div style={{ textDecoration: "line-through" }}>
                          <b>{f.title}</b>
                        </div>
                        {f.doneAt && <div style={{ fontSize: 11, color: "var(--muted)" }}>done {f.doneAt.slice(0, 10)}</div>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      </div>

      <MeetingDrawer state={drawer} onClose={() => setDrawer({ mode: "closed" })} onSaved={() => { void refresh(); }} />
      <VoiceCaptureModal open={voiceOpen} onClose={() => setVoiceOpen(false)} onSaved={() => { void refresh(); }} />
    </div>
  );
}

function pill(sev: UpcomingItem["severity"]): React.CSSProperties {
  const bg = sev === "danger" ? "#dc2626" : sev === "warn" ? "#d97706" : "#0369a1";
  return { display: "inline-block", padding: "3px 8px", borderRadius: 6, background: bg + "33", color: bg, fontSize: 11, fontWeight: 600 };
}
function kindPill(kind: string): React.CSSProperties {
  const colors: Record<string, string> = {
    board: "#7c3aed", parent: "#0369a1", staff: "#9333ea",
    vendor: "#c2410c", inspection: "#dc2626", other: "#64748b",
  };
  const c = colors[kind] ?? "#64748b";
  return { display: "inline-block", padding: "2px 8px", borderRadius: 4, background: c + "22", color: c, fontSize: 11, fontWeight: 600 };
}
const panel: React.CSSProperties = {
  background: "var(--panel, rgba(15,23,42,.5))", border: "1px solid var(--border, #1e293b)",
  borderRadius: 12, padding: 20, marginBottom: 20,
};
const emptyBox: React.CSSProperties = { padding: 24, textAlign: "center", color: "var(--muted)", fontSize: 13 };
const errBox: React.CSSProperties = {
  padding: 10, borderRadius: 8, background: "rgba(220,38,38,.1)", color: "#fca5a5",
  border: "1px solid rgba(220,38,38,.35)", marginBottom: 12,
};
