import type { Occurrence } from "./event";
import { formatTime } from "./event";

export type AgendaPanelProps = {
  dateISO: string;
  todayISO: string;
  occurrences: Occurrence[];
  onOpenOccurrence: (o: Occurrence) => void;
};

const SEMANTIC_LABEL: Record<Occurrence["semantic"], string> = {
  event: "Scheduled",
  deadline: "Due",
  reminder: "Follow-up",
  closure: "Closed",
};

function formatDateLong(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

export default function AgendaPanel({ dateISO, todayISO, occurrences, onOpenOccurrence }: AgendaPanelProps) {
  const allDay = occurrences.filter((o) => o.allDay);
  const timed = occurrences.filter((o) => !o.allDay);
  const empty = occurrences.length === 0;
  const dayLabel = dateISO === todayISO ? "Today" : formatDateLong(dateISO);

  return (
    <aside className="oc-agenda" aria-label="Selected day agenda">
      <header className="oc-agenda-head">
        <div className="oc-agenda-date">{dayLabel}</div>
        <div className="oc-agenda-sub">{dateISO === todayISO ? formatDateLong(dateISO) : ""}</div>
      </header>

      {empty && (
        <div className="oc-agenda-empty">Nothing on this day.</div>
      )}

      {allDay.length > 0 && (
        <section className="oc-agenda-group">
          <h4 className="oc-agenda-h">All day</h4>
          <ul className="oc-agenda-list">
            {allDay.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  className={`oc-agenda-row semantic-${o.semantic}${o.status ? ` s-${o.status}` : ""}`}
                  onClick={() => onOpenOccurrence(o)}
                >
                  <span className="oc-agenda-swatch" style={{ background: o.color }} aria-hidden />
                  <span className="oc-agenda-body">
                    <span className="oc-agenda-title">{o.title}</span>
                    {o.subtitle && <span className="oc-agenda-sub2">{o.subtitle}</span>}
                    <span className="oc-agenda-tag">{SEMANTIC_LABEL[o.semantic]}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {timed.length > 0 && (
        <section className="oc-agenda-group">
          <h4 className="oc-agenda-h">Timed</h4>
          <ul className="oc-agenda-list">
            {timed.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  className={`oc-agenda-row semantic-${o.semantic}`}
                  onClick={() => onOpenOccurrence(o)}
                >
                  <span className="oc-agenda-time">
                    {formatTime(o.start)}
                    {o.end && <span className="oc-agenda-time-end">→ {formatTime(o.end)}</span>}
                  </span>
                  <span className="oc-agenda-swatch" style={{ background: o.color }} aria-hidden />
                  <span className="oc-agenda-body">
                    <span className="oc-agenda-title">{o.title}</span>
                    {o.subtitle && <span className="oc-agenda-sub2">{o.subtitle}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}
