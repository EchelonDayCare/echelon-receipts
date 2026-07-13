import { useEffect, useState } from "react";
import { loadTodaySummary, attentionSeverity, type TodaySummary } from "../lib/todaySummary";
import TodayDrawer from "./TodayDrawer";

// TodayCard — clickable strip that sits above the tile grid on Home.
// Shows an ambient signal of what today looks like, then opens the
// TodayDrawer for details. Placed above the tiles instead of a third
// icon button (Sol review: a third top-right glyph would be invisible).

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function TodayCard() {
  const [summary, setSummary] = useState<TodaySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [drawerDate, setDrawerDate] = useState<string>(todayISO());

  const load = () => {
    setLoading(true);
    loadTodaySummary(todayISO())
      .then(setSummary)
      .catch(() => setSummary(null))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  // Refresh after drawer closes — a drawer visit may have resolved items.
  useEffect(() => {
    if (!open) load();
  }, [open]);

  const attention = summary?.attention ?? [];
  const unmarked = summary?.attendance?.unmarked ?? 0;
  const attentionTone = attentionSeverity(attention);
  const hasWork = attention.length > 0 || unmarked > 0;
  const worstTone = attention.some((a) => a.severity === "danger") ? "danger"
                   : unmarked > 0 ? "warn"
                   : attentionTone;

  const scheduleCount = summary?.schedule.length ?? 0;
  const centreClosed = summary?.centre.isOpen === false;

  const bg = !hasWork ? "#f0fdf4"
    : worstTone === "danger" ? "#fef2f2"
    : "#fffbeb";
  const border = !hasWork ? "#a7f3d0"
    : worstTone === "danger" ? "#fecaca"
    : "#fde68a";
  const iconColor = !hasWork ? "#047857"
    : worstTone === "danger" ? "#b91c1c"
    : "#92400e";

  const primaryMsg = loading ? "Loading today…"
    : centreClosed ? "Centre closed today."
    : !hasWork ? "You're clear for today. Nothing needs your attention."
    : (attention.length > 0)
      ? `${attention.length} item${attention.length === 1 ? "" : "s"} need${attention.length === 1 ? "s" : ""} attention`
      : summary?.attendance?.fullyUnloaded
        ? `${summary.attendance.monthLabel} attendance not loaded`
        : `${summary?.attendance?.monthLabel ?? "Previous month"}: ${unmarked} unmarked`;

  const secondaryBits: string[] = [];
  if (scheduleCount > 0) secondaryBits.push(`${scheduleCount} on schedule`);
  if (attention.length > 0 && unmarked > 0) {
    secondaryBits.push(
      summary?.attendance?.fullyUnloaded
        ? `${summary.attendance.monthLabel} to load`
        : `${unmarked} to mark`,
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => { setDrawerDate(todayISO()); setOpen(true); }}
        aria-label="Open Today"
        style={{
          display: "flex", alignItems: "center", gap: 12,
          width: "100%", padding: "8px 14px", marginBottom: 10,
          background: bg, border: `1px solid ${border}`, borderRadius: 10,
          cursor: "pointer", textAlign: "left", font: "inherit",
          transition: "box-shadow 120ms ease",
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.boxShadow = "0 3px 10px -4px rgba(15,23,42,0.14)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.boxShadow = "none"; }}
      >
        <span style={{
          width: 28, height: 28, borderRadius: 7, background: "#fff",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          color: iconColor, flexShrink: 0, border: `1px solid ${border}`,
        }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <path d="M3 10h18M8 3v4M16 3v4" />
          </svg>
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, color: iconColor, letterSpacing: 0.6, textTransform: "uppercase", flexShrink: 0 }}>
          Today
        </span>
        <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text, #1a1f36)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {primaryMsg}
        </span>
        {secondaryBits.length > 0 && (
          <span style={{ fontSize: 12, color: "var(--muted, #6b7280)", flexShrink: 0 }}>
            {secondaryBits.join(" · ")}
          </span>
        )}
        <span style={{ color: "#9ca3af", flexShrink: 0 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m9 6 6 6-6 6" />
          </svg>
        </span>
      </button>

      {open && (
        <TodayDrawer
          isoDate={drawerDate}
          onDateChange={setDrawerDate}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
