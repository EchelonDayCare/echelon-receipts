// Waitlist list view — /waitlist/list
// Full table with filter bar, sort by priority score.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  listWaitlist, syncOnScreenOpen, ageBand, waitDays, priorityScore, scoreBreakdown,
  loadPriorityWeights, loadActiveStudentMap,
  updateWaitlistStatus,
  DEFAULT_PRIORITY_WEIGHTS,
  WAITLIST_STATUSES,
  type WaitlistEntry, type WaitlistStatus, type AgeBand,
  type PriorityWeights,
} from "../../lib/waitlist";
import DetailDrawer from "./DetailDrawer";

const BANDS: AgeBand[] = ["Infant", "Toddler", "3-5yr", "School-age", "Unknown"];

// Human-readable age band definitions (kept in sync with ageBand() in lib/waitlist.ts).
const BAND_INFO: Record<AgeBand, { range: string; note: string }> = {
  Infant:       { range: "0–18 months",   note: "Under 1.5 years old" },
  Toddler:      { range: "19–36 months",  note: "1.5 – 3 years old" },
  "3-5yr":      { range: "37–60 months",  note: "3 – 5 years old" },
  "School-age": { range: "over 60 months", note: "Older than 5 years" },
  Unknown:      { range: "—",             note: "No birthday on record" },
};

const DEFAULT_STATUSES: WaitlistStatus[] = ["new", "contacted", "offered"];

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Years for the birth-year dropdown: current year down to 12 years ago.
// Waitlist kids are 0–5; the extra buffer covers stale entries + siblings.
const BIRTH_YEARS: string[] = (() => {
  const now = new Date().getFullYear();
  const arr: string[] = [];
  for (let y = now + 1; y >= now - 12; y--) arr.push(String(y));
  return arr;
})();

type SortKey = "priority" | "dob" | "submitted";
type SortDir = "asc" | "desc";

/** Format ISO YYYY-MM-DD as "12 Aug 2024". Returns "—" for null/invalid. */
function formatDob(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-CA", { day: "2-digit", month: "short", year: "numeric" });
}

/**
 * Return the last day of a given month as an ISO YYYY-MM-DD string.
 * Used to make the birth-range "To" bound inclusive of the whole month
 * (so picking "To = Dec 2024" catches Dec 31 births, not just Dec 1).
 * `yyyy` is a 4-digit year string, `mm` is "01".."12".
 */
function lastDayOfMonth(yyyy: string, mm: string): string {
  const y = Number(yyyy);
  const m = Number(mm);
  // Day 0 of the NEXT month is the last day of the target month.
  const d = new Date(y, m, 0);
  const day = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${day}`;
}

export default function WaitlistList() {
  const [rows, setRows] = useState<WaitlistEntry[]>([]);
  const [statuses, setStatuses] = useState<Set<WaitlistStatus>>(
    new Set(DEFAULT_STATUSES),
  );
  const [bands, setBands] = useState<Set<AgeBand>>(new Set());
  const [inBuildingOnly, setInBuildingOnly] = useState(false);
  const [search, setSearch] = useState("");
  // Two-part month/year pickers per side of the range. Each side only
  // fires a query when BOTH its month AND year are picked (partial
  // picks show an inline hint but never fire). Either side can be left
  // blank for an open-ended range.
  const [birthFromMonthPick, setBirthFromMonthPick] = useState("");
  const [birthFromYearPick, setBirthFromYearPick] = useState("");
  const [birthToMonthPick, setBirthToMonthPick] = useState("");
  const [birthToYearPick, setBirthToYearPick] = useState("");
  const birthFrom =
    birthFromMonthPick && birthFromYearPick
      ? `${birthFromYearPick}-${birthFromMonthPick}-01`
      : "";
  const birthTo =
    birthToMonthPick && birthToYearPick
      ? lastDayOfMonth(birthToYearPick, birthToMonthPick)
      : "";
  const [openId, setOpenId] = useState<number | null>(null);
  const [weights, setWeights] = useState<PriorityWeights>(DEFAULT_PRIORITY_WEIGHTS);
  const [siblingActive, setSiblingActive] = useState<Map<number, number>>(new Map());
  const [sortKey, setSortKey] = useState<SortKey>("priority");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const refreshSeqRef = useRef(0);
  // Filter values are also mirrored to refs so the mount-time refresh
  // (which runs after `syncOnScreenOpen` completes) uses whatever the
  // user has picked WHILE sync was in flight, not the initial values
  // captured in the effect's closure. Without this, changing filters
  // during sync (a fast user, a slow network) results in the delayed
  // post-sync refresh snapping the UI back to initial intent.
  const statusesRef = useRef(statuses);
  const searchRef = useRef(search);
  const birthFromRef = useRef(birthFrom);
  const birthToRef = useRef(birthTo);
  useEffect(() => { statusesRef.current = statuses; }, [statuses]);
  useEffect(() => { searchRef.current = search; }, [search]);
  useEffect(() => { birthFromRef.current = birthFrom; }, [birthFrom]);
  useEffect(() => { birthToRef.current = birthTo; }, [birthTo]);

  const refresh = async () => {
    // Guard against out-of-order responses: only the latest refresh wins.
    const mySeq = ++refreshSeqRef.current;
    const [r, w, sm] = await Promise.all([
      listWaitlist({
        statuses: [...statusesRef.current],
        search: searchRef.current,
        birthFrom: birthFromRef.current || undefined,
        birthTo: birthToRef.current || undefined,
      }),
      loadPriorityWeights(),
      loadActiveStudentMap(),
    ]);
    if (mySeq !== refreshSeqRef.current) return;
    setRows(r);
    setWeights(w);
    setSiblingActive(sm);
  };

  useEffect(() => {
    (async () => {
      await syncOnScreenOpen();
      await refresh();
    })();
  }, []);

  useEffect(() => { void refresh();   }, [statuses, search, birthFrom, birthTo]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Sensible defaults: priority high→low, dob newest→oldest, submitted newest→oldest
      setSortDir("desc");
    }
  };

  const filtered = useMemo(() => {
    const ctx = { siblingStudentActive: siblingActive };
    let r = rows;
    if (bands.size > 0) r = r.filter((e) => bands.has(ageBand(e.birthday)));
    if (inBuildingOnly) r = r.filter((e) => e.in_building === 1);

    const dirMul = sortDir === "asc" ? 1 : -1;
    const cmp = (a: WaitlistEntry, b: WaitlistEntry): number => {
      if (sortKey === "priority") {
        const as = priorityScore(a, weights, ctx);
        const bs = priorityScore(b, weights, ctx);
        return as < bs ? -1 * dirMul : as > bs ? 1 * dirMul : 0;
      }
      if (sortKey === "dob") {
        // Nulls always last regardless of direction
        const av = a.birthday, bv = b.birthday;
        if (!av && !bv) return 0;
        if (!av) return 1;
        if (!bv) return -1;
        return av < bv ? -1 * dirMul : av > bv ? 1 * dirMul : 0;
      }
      // submitted
      const av = a.submitted_at, bv = b.submitted_at;
      if (!av && !bv) return 0;
      if (!av) return 1;
      if (!bv) return -1;
      return av < bv ? -1 * dirMul : av > bv ? 1 * dirMul : 0;
    };
    return [...r].sort(cmp);
  }, [rows, bands, inBuildingOnly, weights, siblingActive, sortKey, sortDir]);

  const defaultStatusSet =
    statuses.size === DEFAULT_STATUSES.length &&
    DEFAULT_STATUSES.every((s) => statuses.has(s));
  const filtersActive =
    !defaultStatusSet || bands.size > 0 || inBuildingOnly || search.trim().length > 0 || birthFrom !== "" || birthTo !== "";

  const clearFilters = () => {
    setStatuses(new Set(DEFAULT_STATUSES));
    setBands(new Set());
    setInBuildingOnly(false);
    setSearch("");
    setBirthFromMonthPick("");
    setBirthFromYearPick("");
    setBirthToMonthPick("");
    setBirthToYearPick("");
  };

  const handleDelete = async (entry: WaitlistEntry, e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = window.confirm(
      `Move ${entry.child_name} to the archive?\n\nThey'll disappear from the active waitlist but remain in Waitlist → Archived.`,
    );
    if (!ok) return;
    try {
      await updateWaitlistStatus(entry.id, "archived", "Manually archived from waitlist");
      await refresh();
    } catch (err: any) {
      window.alert(`Couldn't archive: ${err?.message ?? err}`);
    }
  };

  return (
    <div>
      <h1>Waitlist — All</h1>

      <div className="card" style={{ marginBottom: 16 }}>
        {/* Filter bar */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
          <div style={{ minWidth: 220 }}>
            <label style={labelSmall}>Status</label>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {WAITLIST_STATUSES.map((s) => (
                <Chip
                  key={s}
                  label={s}
                  active={statuses.has(s)}
                  onClick={() => {
                    const next = new Set(statuses);
                    next.has(s) ? next.delete(s) : next.add(s);
                    setStatuses(next);
                  }}
                />
              ))}
            </div>
          </div>
          <div style={{ minWidth: 280 }}>
            <label style={labelSmall}>
              Age band
              <span
                title={BANDS.map((b) => `${b}: ${BAND_INFO[b].range} (${BAND_INFO[b].note})`).join("\n")}
                style={{ marginLeft: 6, cursor: "help", color: "var(--muted)", fontWeight: 400 }}
              >
                ⓘ
              </span>
            </label>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {BANDS.map((b) => (
                <Chip
                  key={b}
                  label={b}
                  title={`${BAND_INFO[b].range} — ${BAND_INFO[b].note}`}
                  active={bands.has(b)}
                  onClick={() => {
                    const next = new Set(bands);
                    next.has(b) ? next.delete(b) : next.add(b);
                    setBands(next);
                  }}
                />
              ))}
            </div>
          </div>
          <div>
            <label style={labelSmall}>Priority</label>
            <label
              title="Families who work in the same building get +100 to priority score. Toggle to only show them."
              style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}
            >
              <input type="checkbox" checked={inBuildingOnly} onChange={(e) => setInBuildingOnly(e.target.checked)} />
              In-building only
            </label>
          </div>
          <div>
            <label style={labelSmall} title="Show only kids born within this month range. Each side needs both a month and a year to apply; leave a side blank for open-ended.">
              Born between
            </label>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <BirthMonthYearRow
                prefix="From"
                monthValue={birthFromMonthPick}
                yearValue={birthFromYearPick}
                onMonthChange={setBirthFromMonthPick}
                onYearChange={setBirthFromYearPick}
              />
              <BirthMonthYearRow
                prefix="To"
                monthValue={birthToMonthPick}
                yearValue={birthToYearPick}
                onMonthChange={setBirthToMonthPick}
                onYearChange={setBirthToYearPick}
              />
              {(birthFrom !== "" || birthTo !== "") && (
                <button
                  type="button"
                  onClick={() => {
                    setBirthFromMonthPick(""); setBirthFromYearPick("");
                    setBirthToMonthPick("");   setBirthToYearPick("");
                  }}
                  style={{
                    alignSelf: "flex-start",
                    border: "1px solid var(--border)", background: "transparent",
                    color: "var(--muted)", borderRadius: 6, padding: "2px 8px",
                    fontSize: 11, cursor: "pointer", lineHeight: 1.4, marginTop: 2,
                  }}
                >
                  ✕ Clear range
                </button>
              )}
            </div>
            {((birthFromMonthPick && !birthFromYearPick) || (!birthFromMonthPick && birthFromYearPick) ||
              (birthToMonthPick && !birthToYearPick)   || (!birthToMonthPick && birthToYearPick)) ? (
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                Pick both month and year on each side to apply.
              </div>
            ) : null}
            {birthFrom !== "" && birthTo !== "" && birthFrom > birthTo ? (
              <div style={{ fontSize: 11, color: "var(--danger, #b91c1c)", marginTop: 4 }}>
                “From” is after “To” — no kids will match.
              </div>
            ) : null}
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <label style={labelSmall}>Search</label>
            <input
              placeholder="Name, email, phone…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: "100%" }}
            />
          </div>
          {filtersActive && (
            <div style={{ alignSelf: "flex-end" }}>
              <button
                className="btn ghost"
                onClick={clearFilters}
                style={{ fontSize: 12 }}
                title="Reset to default: status=new/contacted/offered, all age bands, no search"
              >
                ✕ Clear filters
              </button>
            </div>
          )}
        </div>
        <div style={{
          marginTop: 12, paddingTop: 10, borderTop: "1px dashed var(--border)",
          fontSize: 11, color: "var(--muted)", display: "flex", gap: 14, flexWrap: "wrap",
        }}>
          <strong style={{ color: "var(--muted)" }}>Age bands:</strong>
          {BANDS.filter((b) => b !== "Unknown").map((b) => (
            <span key={b}>
              <span style={{ ...bandChipStyle(b), padding: "1px 6px", fontSize: 10, marginRight: 4 }}>{b}</span>
              {BAND_INFO[b].range}
            </span>
          ))}
          <span style={{ opacity: 0.7 }}>· Showing {filtered.length} of {rows.length}</span>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f8fafc" }}>
              <SortableTh label="Score" active={sortKey === "priority"} dir={sortDir} onClick={() => toggleSort("priority")} />
              <Th>Child</Th>
              <Th>Age band</Th>
              <SortableTh label="DoB" active={sortKey === "dob"} dir={sortDir} onClick={() => toggleSort("dob")} />
              <Th>Parent / Email</Th>
              <Th>Phone</Th>
              <SortableTh label="Submitted" active={sortKey === "submitted"} dir={sortDir} onClick={() => toggleSort("submitted")} />
              <Th>Target start</Th>
              <Th>In bldg</Th>
              <Th>Status</Th>
              <Th>{""}</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => {
              const ctx = { siblingStudentActive: siblingActive };
              const lines = scoreBreakdown(e, weights, ctx);
              const total = lines.reduce((s, l) => s + l.points, 0);
              const tip = lines.length
                ? lines.map((l) => `+${l.points}  ${l.label}${l.note ? " (" + l.note + ")" : ""}`).join("\n")
                : "No scored signals yet — add priority signals in the detail drawer.";
              return (
                <tr key={e.id} style={{ cursor: "pointer", borderTop: "1px solid var(--border)" }}
                    onClick={() => setOpenId(e.id)}
                    onMouseEnter={(ev) => (ev.currentTarget as HTMLTableRowElement).style.background = "#f8fafc"}
                    onMouseLeave={(ev) => (ev.currentTarget as HTMLTableRowElement).style.background = ""}
                >
                  <Td>
                    <span title={`Priority score: ${total.toFixed(1)}\n\n${tip}\n\nEdit weights in Waitlist → Settings.`}
                          style={scoreChipStyle(total)}>
                      {total.toFixed(1)}
                    </span>
                  </Td>
                  <Td><strong>{e.child_name}</strong></Td>
                  <Td><span style={bandChipStyle(ageBand(e.birthday))}>{ageBand(e.birthday)}</span></Td>
                  <Td style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{formatDob(e.birthday)}</Td>
                  <Td>
                    <div>{e.parent_name || "—"}</div>
                    <div style={{ fontSize: 12, color: "var(--muted)" }}>{e.parent_email || ""}</div>
                  </Td>
                  <Td>{e.phone || "—"}</Td>
                  <Td>{waitDays(e.submitted_at)}d ago</Td>
                  <Td>{e.target_start || "—"}</Td>
                  <Td>{e.in_building === 1 ? "✓" : e.in_building === 0 ? "—" : "?"}</Td>
                  <Td><span style={statusChipStyle(e.status)}>{e.status}</span></Td>
                  <Td>
                    {e.status !== "archived" && (
                      <button
                        type="button"
                        onClick={(ev) => handleDelete(e, ev)}
                        title={`Move ${e.child_name} to the archive`}
                        aria-label={`Move ${e.child_name} to the archive`}
                        style={{
                          border: "1px solid var(--border)",
                          background: "transparent",
                          color: "var(--muted)",
                          borderRadius: 6,
                          padding: "2px 8px",
                          cursor: "pointer",
                          fontSize: 14,
                          lineHeight: 1,
                        }}
                        onMouseEnter={(ev) => {
                          (ev.currentTarget as HTMLButtonElement).style.color = "#b91c1c";
                          (ev.currentTarget as HTMLButtonElement).style.borderColor = "#fecaca";
                          (ev.currentTarget as HTMLButtonElement).style.background = "#fef2f2";
                        }}
                        onMouseLeave={(ev) => {
                          (ev.currentTarget as HTMLButtonElement).style.color = "var(--muted)";
                          (ev.currentTarget as HTMLButtonElement).style.borderColor = "var(--border)";
                          (ev.currentTarget as HTMLButtonElement).style.background = "transparent";
                        }}
                      >
                        🗑
                      </button>
                    )}
                  </Td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={11} style={{ padding: 24, textAlign: "center", color: "var(--muted)" }}>No entries match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {openId !== null && <DetailDrawer id={openId} onClose={() => { setOpenId(null); void refresh(); }} />}
    </div>
  );
}

const labelSmall: React.CSSProperties = {
  fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em", display: "block", marginBottom: 4,
};

function Th({ children }: { children: React.ReactNode }) {
  return <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 12, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em" }}>{children}</th>;
}
function SortableTh({ label, active, dir, onClick }: { label: string; active: boolean; dir: SortDir; onClick: () => void }) {
  const arrow = active ? (dir === "asc" ? "▲" : "▼") : "";
  return (
    <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 12, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em" }}>
      <button
        type="button"
        onClick={onClick}
        aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
        style={{
          background: "none", border: "none", padding: 0, cursor: "pointer",
          font: "inherit", color: "inherit", textTransform: "inherit", letterSpacing: "inherit",
          display: "inline-flex", alignItems: "center", gap: 4,
        }}
      >
        {label}
        <span aria-hidden style={{ fontSize: 9, opacity: active ? 1 : 0.3, minWidth: 8 }}>{arrow || "↕"}</span>
      </button>
    </th>
  );
}
function Td({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <td style={{ padding: "10px 12px", fontSize: 14, verticalAlign: "top", ...style }}>{children}</td>;
}

function Chip({ label, active, onClick, title }: { label: string; active: boolean; onClick: () => void; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        padding: "4px 10px", borderRadius: 999, border: "1px solid " + (active ? "var(--accent)" : "var(--border)"),
        background: active ? "var(--accent)" : "transparent",
        color: active ? "#fff" : "var(--text)",
        fontSize: 12, cursor: "pointer", textTransform: "capitalize",
      }}
    >{label}</button>
  );
}

function bandChipStyle(band: string): React.CSSProperties {
  const colors: Record<string, [string, string]> = {
    Infant: ["#fef3c7", "#92400e"],
    Toddler: ["#dbeafe", "#1e40af"],
    "3-5yr": ["#dcfce7", "#166534"],
    "School-age": ["#ede9fe", "#5b21b6"],
    Unknown: ["#e5e7eb", "#475569"],
  };
  const [bg, fg] = colors[band] || colors.Unknown;
  return { background: bg, color: fg, padding: "2px 8px", borderRadius: 8, fontSize: 12, fontWeight: 600 };
}

function statusChipStyle(status: string): React.CSSProperties {
  const colors: Record<string, [string, string]> = {
    new: ["#dbeafe", "#1e40af"],
    contacted: ["#fef9c3", "#854d0e"],
    offered: ["#fce7f3", "#9d174d"],
    enrolled: ["#dcfce7", "#166534"],
    withdrawn: ["#f3f4f6", "#374151"],
    archived: ["#f3f4f6", "#6b7280"],
  };
  const [bg, fg] = colors[status] || ["#f3f4f6", "#374151"];
  return { background: bg, color: fg, padding: "2px 8px", borderRadius: 8, fontSize: 12, fontWeight: 600, textTransform: "capitalize" };
}

function scoreChipStyle(total: number): React.CSSProperties {
  // Bucketed color: green for high-priority (≥80), amber (40-80), grey (<40)
  const bucket = total >= 80 ? ["#dcfce7", "#166534"]
              : total >= 40 ? ["#fef3c7", "#92400e"]
              :               ["#f1f5f9", "#475569"];
  return {
    background: bucket[0], color: bucket[1],
    padding: "3px 10px", borderRadius: 8,
    fontSize: 13, fontWeight: 700, cursor: "help",
    fontVariantNumeric: "tabular-nums",
  };
}


// ── Small filter sub-component ────────────────────────────────────────────

/**
 * One row of the birth-range filter: a small "From"/"To" label plus
 * Month + Year dropdowns. Kept as its own component so the two rows in
 * the filter bar stay visually identical without repeating markup.
 */
function BirthMonthYearRow(props: {
  prefix: "From" | "To";
  monthValue: string;
  yearValue: string;
  onMonthChange: (v: string) => void;
  onYearChange: (v: string) => void;
}) {
  const { prefix, monthValue, yearValue, onMonthChange, onYearChange } = props;
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <span
        style={{
          fontSize: 11, color: "var(--muted)", width: 32,
          textAlign: "right", fontVariantNumeric: "tabular-nums",
        }}
      >
        {prefix}
      </span>
      <select
        value={monthValue}
        onChange={(e) => onMonthChange(e.target.value)}
        style={{ fontSize: 13, padding: "3px 6px" }}
        aria-label={`Birth month (${prefix.toLowerCase()})`}
      >
        <option value="">Month</option>
        {MONTH_LABELS.map((label, i) => (
          <option key={i} value={String(i + 1).padStart(2, "0")}>{label}</option>
        ))}
      </select>
      <select
        value={yearValue}
        onChange={(e) => onYearChange(e.target.value)}
        style={{ fontSize: 13, padding: "3px 6px" }}
        aria-label={`Birth year (${prefix.toLowerCase()})`}
      >
        <option value="">Year</option>
        {BIRTH_YEARS.map((y) => (
          <option key={y} value={y}>{y}</option>
        ))}
      </select>
    </div>
  );
}
