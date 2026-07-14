import { useMemo } from "react";
import type { Occurrence, MonthOccurrenceMap } from "./event";
import { formatTime } from "./event";

// A month grid rendered as 6 rows × 7 cols. Sunday first, matching the
// project's existing MonthView convention. Each cell shows up to 3 event
// capsules and 2 deadline pills, with a "+N more" affordance that just
// selects the day (the AgendaPanel then shows the full list).

const WEEK_HEADERS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export type MonthViewProps = {
  year: number;
  month: number;                 // 1-12
  todayISO: string;
  selectedISO: string;
  occurrences: MonthOccurrenceMap;
  onSelectDay: (iso: string) => void;
  onOpenOccurrence: (occ: Occurrence) => void;
};

type Cell = {
  iso: string;
  day: number;
  inMonth: boolean;
  isWeekend: boolean;
  occs: Occurrence[];
};

function buildGrid(year: number, month: number, occs: MonthOccurrenceMap): Cell[] {
  const first = new Date(year, month - 1, 1);
  const startWeekday = first.getDay(); // 0=Sun
  const gridStart = new Date(year, month - 1, 1 - startWeekday);
  const cells: Cell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    cells.push({
      iso,
      day: d.getDate(),
      inMonth: d.getMonth() === month - 1,
      isWeekend: d.getDay() === 0 || d.getDay() === 6,
      occs: occs.get(iso) ?? [],
    });
  }
  return cells;
}

function CapsuleChip({ o, onOpen }: { o: Occurrence; onOpen: (o: Occurrence) => void }) {
  const isDeadline = o.semantic === "deadline" || o.semantic === "reminder";
  const isClosure = o.semantic === "closure";
  const cls = `oc-cap ${isDeadline ? "deadline" : isClosure ? "closure" : "event"}${o.status ? ` s-${o.status}` : ""}`;
  const timeLabel = o.allDay ? "" : formatTime(o.start);
  return (
    <button
      type="button"
      className={cls}
      style={isDeadline || isClosure ? { borderColor: o.color, color: o.color } : { background: o.color }}
      title={`${o.title}${o.subtitle ? ` — ${o.subtitle}` : ""}${timeLabel ? ` @ ${timeLabel}` : ""}`}
      onClick={(e) => { e.stopPropagation(); onOpen(o); }}
    >
      {timeLabel && <span className="oc-cap-time">{timeLabel}</span>}
      <span className="oc-cap-title">{o.title}</span>
    </button>
  );
}

export default function MonthView(props: MonthViewProps) {
  const { year, month, todayISO, selectedISO, occurrences, onSelectDay, onOpenOccurrence } = props;
  const cells = useMemo(() => buildGrid(year, month, occurrences), [year, month, occurrences]);

  return (
    <div className="oc-month" role="grid" aria-label={`Month view ${year}-${month}`}>
      <div className="oc-month-head">
        {WEEK_HEADERS.map((w) => (
          <div key={w} className="oc-dow" role="columnheader">{w}</div>
        ))}
      </div>
      <div className="oc-month-body">
        {cells.map((c) => {
          const isToday = c.iso === todayISO;
          const isSelected = c.iso === selectedISO;
          // Split for hierarchy: closures first (as full-width strip),
          // then event capsules, then deadline pills.
          const closures = c.occs.filter((o) => o.semantic === "closure");
          const events = c.occs.filter((o) => o.semantic === "event");
          const deadlines = c.occs.filter((o) => o.semantic === "deadline" || o.semantic === "reminder");
          const eventCap = 3;
          const deadlineCap = 2;
          const shownEvents = events.slice(0, eventCap);
          const shownDeadlines = deadlines.slice(0, deadlineCap);
          const hidden = events.length - shownEvents.length + deadlines.length - shownDeadlines.length;
          return (
            <div
              key={c.iso}
              className={`oc-cell${c.inMonth ? "" : " out"}${c.isWeekend ? " weekend" : ""}${isToday ? " today" : ""}${isSelected ? " selected" : ""}${closures.length > 0 ? " closed" : ""}`}
              role="gridcell"
              tabIndex={0}
              aria-selected={isSelected}
              onClick={() => onSelectDay(c.iso)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectDay(c.iso); }
              }}
            >
              <div className="oc-cell-head">
                <span className={`oc-day-num${isToday ? " today" : ""}`}>{c.day}</span>
                {closures.length > 0 && (
                  <span className="oc-cell-closed" title={closures[0].subtitle ?? "Closed"}>Closed</span>
                )}
              </div>
              <div className="oc-cell-stack">
                {shownEvents.map((o) => <CapsuleChip key={o.id} o={o} onOpen={onOpenOccurrence} />)}
                {shownDeadlines.map((o) => <CapsuleChip key={o.id} o={o} onOpen={onOpenOccurrence} />)}
                {hidden > 0 && (
                  <button
                    type="button"
                    className="oc-more"
                    onClick={(e) => { e.stopPropagation(); onSelectDay(c.iso); }}
                  >
                    +{hidden} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
