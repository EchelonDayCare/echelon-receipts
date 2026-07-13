import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { loadTodaySummary, type TodaySummary, type TodayAttentionItem, type TodayScheduleItem } from "../lib/todaySummary";
import { setCalendarDay } from "../lib/monthAttendance";
import { runClosureImpact } from "./ClosureImpactDialog";
import { showPrompt } from "../lib/dialogs";

// TodayDrawer — right-side non-blocking panel that answers the owner's
// "what's happening today?" in three owner-oriented buckets:
//   1. Needs attention (overdue + due-today, sorted worst-first)
//   2. Today's schedule (shifts + meetings, chronological)
//   3. Centre (open/closed + link to canonical closure editor)
//
// Design constraints (Sol review):
//   - No inline centre-status toggle; destructive edits live in Settings.
//   - Actionable phrasing over raw counts.
//   - Overdue leads. A today-only filter would hide the most important work.

type Props = {
  isoDate: string;
  onClose: () => void;
  onDateChange: (iso: string) => void;
};

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDaysISO(iso: string, delta: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}
function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}
function timeLabel(t: string | null): string {
  return t ? t : "—";
}

function sourceLabel(source: string): string {
  const map: Record<string, string> = {
    credential: "Staff credential",
    drill: "Drill",
    document: "Document",
    aging: "Overdue receipt",
    agm: "AGM",
    tax: "Tax deadline",
    ccfri: "CCFRI",
    subsidy_annual: "Subsidy renewal",
    action: "Meeting action",
    followup: "Follow-up",
  };
  return map[source] ?? source;
}

export default function TodayDrawer({ isoDate, onClose, onDateChange }: Props) {
  const nav = useNavigate();
  const [summary, setSummary] = useState<TodaySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [centreBusy, setCentreBusy] = useState(false);

  const reload = () => {
    loadTodaySummary(isoDate)
      .then((s) => setSummary(s))
      .catch((e) => setErr(String(e?.message ?? e)));
  };

  // Toggle centre open/closed for the day being viewed. Reuses the same
  // safety guard MonthlyAttendance uses so open → closed on a day with
  // scheduled shifts prompts before orphaning them.
  async function toggleCentre() {
    if (!summary) return;
    const wasOpen = summary.centre.isOpen;
    if (wasOpen) {
      // Ask for a reason (default "Closed"). Cancel = abort.
      const reason = await showPrompt("Reason for closing this day (Stat holiday, PD day, closure…):", "Closed");
      if (reason === null) return;
      const choice = await runClosureImpact({
        title: "This day may have scheduled shifts",
        intro: "You're about to mark this day as closed. Choose what to do with any scheduled shifts before continuing.",
        dates: [{ iso: isoDate, reason: reason || "Closed" }],
      });
      if (choice === "cancel") return;
      setCentreBusy(true);
      try {
        await setCalendarDay(isoDate, false, reason || "Closed");
        reload();
      } finally {
        setCentreBusy(false);
      }
    } else {
      // Re-opening: safe. No prompt.
      setCentreBusy(true);
      try {
        await setCalendarDay(isoDate, true, null);
        reload();
      } finally {
        setCentreBusy(false);
      }
    }
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    loadTodaySummary(isoDate)
      .then((s) => { if (!cancelled) setSummary(s); })
      .catch((e) => { if (!cancelled) setErr(String(e?.message ?? e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isoDate]);

  // Close on Escape. Non-blocking drawer semantics.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isToday = summary?.isToday ?? false;
  // organizerRepo.listUpcoming is today-relative (daysAway measured from
  // new Date()), so paging to a non-today date must not show those rows —
  // they'd read as "overdue" but actually reflect today's overdue set.
  // See v2.6.7 review, medium finding.
  const attentionItems = isToday ? (summary?.attention ?? []) : [];
  const centreClosed = summary?.centre.isOpen === false;

  const attentionCount = attentionItems.length;
  const scheduleCount = summary?.schedule.length ?? 0;

  const attendanceNeedsAction = summary?.attendance ? summary.attendance.unmarked > 0 : false;

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0, background: "rgba(15, 23, 42, 0.28)",
          zIndex: 1000, animation: "today-fade 160ms ease-out",
        }}
      />
      <aside
        role="dialog"
        aria-label="Today"
        style={{
          position: "fixed", top: 0, right: 0, bottom: 0, width: 440, maxWidth: "94vw",
          background: "#fff", boxShadow: "-16px 0 40px -12px rgba(15, 23, 42, 0.25)",
          zIndex: 1001, display: "flex", flexDirection: "column",
          animation: "today-slide 220ms cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        <style>{`
          @keyframes today-fade { from { opacity: 0 } to { opacity: 1 } }
          @keyframes today-slide { from { transform: translateX(24px); opacity: 0 } to { transform: translateX(0); opacity: 1 } }
          @media (prefers-reduced-motion: reduce) {
            @keyframes today-fade { from { opacity: 1 } to { opacity: 1 } }
            @keyframes today-slide { from { transform: none; opacity: 1 } to { transform: none; opacity: 1 } }
          }
        `}</style>

        {/* Header */}
        <header style={{
          padding: "20px 22px 14px", borderBottom: "1px solid var(--border, #e3e6ee)",
          display: "flex", flexDirection: "column", gap: 10,
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: 12, color: "var(--muted, #6b7280)", letterSpacing: 0.2, textTransform: "uppercase", fontWeight: 600 }}>
                {isToday ? "Today" : ""}
              </div>
              <h2 style={{ margin: "2px 0 0", fontSize: 18, letterSpacing: "-0.01em" }}>
                {longDate(isoDate)}
              </h2>
              {centreClosed && summary?.centre && !summary.centre.isOpen && (
                <div style={{ marginTop: 4, fontSize: 13, color: "#b45309" }}>
                  Centre closed{summary.centre.reason ? ` — ${summary.centre.reason}` : ""}
                </div>
              )}
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              style={{
                background: "transparent", border: 0, cursor: "pointer",
                width: 32, height: 32, borderRadius: 8, color: "#6b7280",
                display: "inline-flex", alignItems: "center", justifyContent: "center",
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>

          {/* Date chip navigation */}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button className="btn secondary" style={{ padding: "4px 10px", fontSize: 13 }} onClick={() => onDateChange(addDaysISO(isoDate, -1))}>← Prev</button>
            <button className="btn secondary" style={{ padding: "4px 10px", fontSize: 13 }} onClick={() => onDateChange(addDaysISO(isoDate, 1))}>Next →</button>
            <input
              type="date"
              value={isoDate}
              onChange={(e) => e.target.value && onDateChange(e.target.value)}
              style={{ padding: "4px 8px", fontSize: 13, border: "1px solid var(--border, #e3e6ee)", borderRadius: 6, marginLeft: 4 }}
            />
            {!isToday && (
              <button className="btn link" style={{ marginLeft: "auto", padding: 0, fontSize: 13 }} onClick={() => onDateChange(todayISO())}>
                Jump to today
              </button>
            )}
          </div>
        </header>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 22px 24px" }}>
          {loading && <div style={{ color: "var(--muted, #6b7280)", fontSize: 14 }}>Loading…</div>}
          {err && <div style={{ color: "var(--danger, #b91c1c)", fontSize: 14 }}>⚠ {err}</div>}

          {summary && !loading && (
            <>
              {/* Needs attention */}
              <SectionHeader
                icon="!"
                title="Needs attention"
                count={attentionCount + (attendanceNeedsAction ? 1 : 0)}
                tone={attentionCount > 0 || attendanceNeedsAction ? "danger" : "clear"}
              />
              {attentionCount === 0 && !attendanceNeedsAction ? (
                <EmptyRow label={isToday ? "Nothing urgent." : "Nothing was overdue on this day."} />
              ) : (
                <ul style={listStyle}>
                  {attendanceNeedsAction && summary.attendance && (
                    <li
                      style={rowStyle}
                      onClick={() => { nav(summary.attendance!.monthRoute); onClose(); }}
                      role="button"
                      tabIndex={0}
                    >
                      <span style={severityDot("warn")} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={rowTitle}>
                          {summary.attendance.fullyUnloaded
                            ? `${summary.attendance.monthLabel} attendance not loaded`
                            : `${summary.attendance.monthLabel}: ${summary.attendance.unmarked} unmarked`}
                        </div>
                        <div style={rowMeta}>
                          {summary.attendance.fullyUnloaded
                            ? `Import the sign-in sheet · ${summary.attendance.totalStudents} on roster`
                            : `Attendance · ${summary.attendance.totalStudents} on roster`}
                        </div>
                      </div>
                      <ChevronRight />
                    </li>
                  )}
                  {attentionItems.map((a, i) => (
                    <AttentionRow key={i} item={a} onNav={(r) => { if (r) { nav(r); onClose(); } }} />
                  ))}
                </ul>
              )}

              {/* Today's schedule */}
              <SectionHeader
                icon="⏱"
                title={isToday ? "Today's schedule" : "Schedule"}
                count={scheduleCount}
                tone="info"
              />
              {scheduleCount === 0 ? (
                <EmptyRow label={centreClosed ? "Centre is closed — no shifts scheduled." : "No shifts or meetings on this day."} />
              ) : (
                <ul style={listStyle}>
                  {summary.schedule.map((it, i) => <ScheduleRow key={i} item={it} />)}
                </ul>
              )}

              {/* Centre */}
              <SectionHeader icon="⌂" title="Centre" tone="info" />
              <div style={{
                padding: "12px 14px", border: "1px solid var(--border, #e3e6ee)", borderRadius: 10,
                background: centreClosed ? "#fef2f2" : "#f0fdf4",
                display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>
                    {centreClosed ? "Closed" : "Open"}
                  </div>
                  {centreClosed && summary.centre && !summary.centre.isOpen && summary.centre.reason && (
                    <div style={{ fontSize: 12, color: "var(--muted, #6b7280)", marginTop: 2 }}>{summary.centre.reason}</div>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
                  <button
                    className="btn secondary"
                    style={{ padding: "4px 12px", fontSize: 13 }}
                    onClick={toggleCentre}
                    disabled={centreBusy}
                    title={centreClosed ? "Reopen this day" : "Close this day"}
                  >
                    {centreBusy ? "…" : centreClosed ? "Reopen day" : "Close day"}
                  </button>
                  <button
                    className="btn link"
                    style={{ padding: 0, fontSize: 13 }}
                    onClick={() => { nav("/config/holidays"); onClose(); }}
                  >
                    Manage closures →
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <footer style={{
          padding: "12px 22px", borderTop: "1px solid var(--border, #e3e6ee)",
          display: "flex", alignItems: "center", justifyContent: "flex-end", position: "relative",
        }}>
          <div style={{ position: "relative" }}>
            <button className="btn secondary" onClick={() => setAddOpen((v) => !v)}>
              Add ▾
            </button>
            {addOpen && (
              <div
                style={{
                  position: "absolute", bottom: "100%", right: 0, marginBottom: 6,
                  background: "#fff", border: "1px solid var(--border, #e3e6ee)", borderRadius: 8,
                  boxShadow: "0 10px 30px -6px rgba(15,23,42,0.18)", minWidth: 190, overflow: "hidden",
                }}
                onMouseLeave={() => setAddOpen(false)}
              >
                <MenuItem label="New meeting" onClick={() => { setAddOpen(false); nav("/organizer"); onClose(); }} />
                <MenuItem label="New follow-up" onClick={() => { setAddOpen(false); nav("/organizer"); onClose(); }} />
              </div>
            )}
          </div>
        </footer>
      </aside>
    </>
  );
}

const listStyle: React.CSSProperties = {
  listStyle: "none", padding: 0, margin: "0 0 22px", display: "flex", flexDirection: "column", gap: 6,
};

const rowStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 12, padding: "10px 12px",
  border: "1px solid var(--border, #e3e6ee)", borderRadius: 10, background: "#fff", cursor: "pointer",
};

const rowTitle: React.CSSProperties = {
  fontSize: 14, fontWeight: 600, color: "var(--text, #1a1f36)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
};

const rowMeta: React.CSSProperties = {
  fontSize: 12, color: "var(--muted, #6b7280)", marginTop: 2,
};

function SectionHeader({ icon, title, count, tone }: { icon: string; title: string; count?: number; tone: "clear" | "info" | "warn" | "danger" }) {
  const dotColor = tone === "danger" ? "#dc2626" : tone === "warn" ? "#d97706" : tone === "info" ? "#2563eb" : "#10b981";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "14px 0 10px" }}>
      <span style={{
        width: 22, height: 22, borderRadius: 6, background: `${dotColor}18`, color: dotColor,
        display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700,
      }}>{icon}</span>
      <h3 style={{ margin: 0, fontSize: 13, letterSpacing: 0.3, textTransform: "uppercase", color: "var(--text, #1a1f36)" }}>{title}</h3>
      {typeof count === "number" && count > 0 && (
        <span style={{
          fontSize: 12, padding: "1px 8px", borderRadius: 999,
          background: tone === "danger" ? "#fee2e2" : tone === "warn" ? "#fef3c7" : "#e0e7ff",
          color: tone === "danger" ? "#991b1b" : tone === "warn" ? "#92400e" : "#3730a3",
          fontWeight: 600,
        }}>{count}</span>
      )}
    </div>
  );
}

function EmptyRow({ label }: { label: string }) {
  return (
    <div style={{ padding: "8px 12px", color: "var(--muted, #6b7280)", fontSize: 13, marginBottom: 22 }}>{label}</div>
  );
}

function AttentionRow({ item, onNav }: { item: TodayAttentionItem; onNav: (route: string | null) => void }) {
  const chip = item.kind === "overdue" ? `Overdue ${Math.abs(item.daysAway)}d` : "Due today";
  const clickable = !!item.route;
  return (
    <li
      style={{ ...rowStyle, cursor: clickable ? "pointer" : "default", opacity: clickable ? 1 : 0.85 }}
      onClick={() => onNav(item.route)}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
    >
      <span style={severityDot(item.severity)} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={rowTitle}>{item.title}</div>
        <div style={rowMeta}>{sourceLabel(item.source)}{item.detail ? ` · ${item.detail}` : ""}</div>
      </div>
      <span style={{
        flexShrink: 0, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999,
        background: item.kind === "overdue" ? "#fee2e2" : "#fef3c7",
        color: item.kind === "overdue" ? "#991b1b" : "#92400e",
      }}>{chip}</span>
      {clickable && <ChevronRight />}
    </li>
  );
}

function ScheduleRow({ item }: { item: TodayScheduleItem }) {
  if (item.kind === "shift") {
    const timeStr = `${timeLabel(item.time)}${item.endTime ? `–${item.endTime}` : ""}`;
    return (
      <li style={{ ...rowStyle, cursor: "default" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#2563eb", minWidth: 90, textAlign: "left" }}>{timeStr}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={rowTitle}>{item.staffName}</div>
          <div style={rowMeta}>Shift · {item.hours.toFixed(2)}h{item.role ? ` · ${item.role}` : ""}{item.status !== "confirmed" && item.status !== "scheduled" ? ` · ${item.status}` : ""}</div>
        </div>
      </li>
    );
  }
  return (
    <li style={{ ...rowStyle, cursor: "default" }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: "#7c3aed", minWidth: 90, textAlign: "left" }}>{item.time ?? "All day"}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={rowTitle}>{item.title}</div>
        <div style={rowMeta}>{item.kindLabel} meeting{item.attendees ? ` · ${item.attendees}` : ""}</div>
      </div>
    </li>
  );
}

function severityDot(sev: "danger" | "warn" | "info" | "clear"): React.CSSProperties {
  const color = sev === "danger" ? "#dc2626" : sev === "warn" ? "#d97706" : sev === "info" ? "#2563eb" : "#10b981";
  return { width: 8, height: 8, borderRadius: 999, background: color, flexShrink: 0 };
}

function ChevronRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "#9ca3af", flexShrink: 0 }}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "block", width: "100%", textAlign: "left",
        padding: "10px 14px", background: "transparent", border: 0, cursor: "pointer",
        fontSize: 14, color: "var(--text, #1a1f36)",
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#f6f7fb"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
    >
      {label}
    </button>
  );
}
