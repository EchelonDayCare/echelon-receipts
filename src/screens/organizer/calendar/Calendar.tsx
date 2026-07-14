import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import MonthView from "./MonthView";
import AgendaPanel from "./AgendaPanel";
import { loadMonthOccurrences, type MonthOccurrenceMap, type Occurrence, type OccurrenceFilters } from "./event";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function ymFromISO(iso: string): { year: number; month: number } {
  const [y, m] = iso.split("-").map(Number);
  return { year: y, month: m };
}

function firstOfMonthISO(y: number, m: number): string {
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

const FILTER_LABELS: Array<{ key: keyof OccurrenceFilters; label: string }> = [
  { key: "meetings", label: "Meetings" },
  { key: "shifts", label: "Shifts" },
  { key: "followups", label: "Follow-ups" },
  { key: "renewals", label: "Renewals & deadlines" },
  { key: "closures", label: "Closures" },
];

export default function Calendar() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();

  const today = todayISO();
  const initialSelected = params.get("date") && /^\d{4}-\d{2}-\d{2}$/.test(params.get("date")!)
    ? params.get("date")!
    : today;
  const [selected, setSelected] = useState<string>(initialSelected);

  const { year, month } = ymFromISO(selected);
  const [occurrences, setOccurrences] = useState<MonthOccurrenceMap>(new Map());
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [filters, setFilters] = useState<OccurrenceFilters>({
    meetings: true, shifts: true, followups: true, renewals: true, closures: true,
  });

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    loadMonthOccurrences(year, month, filters)
      .then((m) => { if (alive) setOccurrences(m); })
      .catch((e) => { if (alive) setErr(String(e?.message ?? e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [year, month, filters]);

  // Sync URL when selection changes.
  useEffect(() => {
    const cur = params.get("date");
    if (cur !== selected) {
      const p = new URLSearchParams(params);
      p.set("date", selected);
      setParams(p, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const shiftMonth = useCallback((delta: number) => {
    const [y, m] = selected.split("-").map(Number);
    const dt = new Date(y, m - 1 + delta, 1);
    const ny = dt.getFullYear();
    const nm = dt.getMonth() + 1;
    // If today is in the new month, land on today; else land on the 1st.
    const [ty, tm] = today.split("-").map(Number);
    if (ny === ty && nm === tm) setSelected(today);
    else setSelected(firstOfMonthISO(ny, nm));
  }, [selected, today]);

  const handleOpenOccurrence = useCallback((o: Occurrence) => {
    if (o.route) nav(o.route);
  }, [nav]);

  const selectedOccurrences = useMemo(
    () => occurrences.get(selected) ?? [],
    [occurrences, selected],
  );

  const monthLabel = `${MONTHS[month - 1]} ${year}`;

  return (
    <div className="oc-page">
      <header className="oc-page-head">
        <div className="oc-page-head-left">
          <h1 className="oc-page-title">Calendar</h1>
          <div className="oc-page-crumbs">
            <Link to="/organizer" className="oc-crumb-link">← Organizer</Link>
          </div>
        </div>
        <div className="oc-page-head-nav" role="group" aria-label="Month navigation">
          <button type="button" className="btn secondary sm" onClick={() => shiftMonth(-1)} aria-label="Previous month">‹</button>
          <button type="button" className="btn secondary sm" onClick={() => setSelected(today)}>Today</button>
          <button type="button" className="btn secondary sm" onClick={() => shiftMonth(1)} aria-label="Next month">›</button>
          <div className="oc-page-month">{monthLabel}</div>
        </div>
        <div className="oc-page-head-right">
          <div className="oc-viewswitch" role="tablist" aria-label="View">
            <button type="button" className="oc-view on" aria-pressed="true">Month</button>
            <button
              type="button"
              className="oc-view"
              aria-pressed="false"
              disabled
              title="Week view — coming next"
            >Week</button>
          </div>
        </div>
      </header>

      <div className="oc-filters" role="group" aria-label="Layer filters">
        {FILTER_LABELS.map(({ key, label }) => {
          const on = filters[key] !== false;
          return (
            <button
              key={key}
              type="button"
              className={`oc-filter${on ? " on" : ""}`}
              aria-pressed={on}
              onClick={() => setFilters((f) => ({ ...f, [key]: !on }))}
            >
              {label}
            </button>
          );
        })}
      </div>

      {err && <div className="oc-err" role="alert">Couldn’t load calendar: {err}</div>}

      <div className="oc-body">
        <div className={`oc-body-month${loading ? " loading" : ""}`}>
          <MonthView
            year={year}
            month={month}
            todayISO={today}
            selectedISO={selected}
            occurrences={occurrences}
            onSelectDay={setSelected}
            onOpenOccurrence={handleOpenOccurrence}
          />
        </div>
        <AgendaPanel
          dateISO={selected}
          todayISO={today}
          occurrences={selectedOccurrences}
          onOpenOccurrence={handleOpenOccurrence}
        />
      </div>
    </div>
  );
}
