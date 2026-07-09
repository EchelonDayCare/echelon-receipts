// Waitlist list view — /waitlist/list
// Full table with filter bar, sort by priority score.

import { useEffect, useMemo, useState } from "react";
import {
  listWaitlist, syncOnScreenOpen, ageBand, waitDays, priorityScore, scoreBreakdown,
  loadPriorityWeights, loadActiveStudentMap,
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

export default function WaitlistList() {
  const [rows, setRows] = useState<WaitlistEntry[]>([]);
  const [statuses, setStatuses] = useState<Set<WaitlistStatus>>(
    new Set(DEFAULT_STATUSES),
  );
  const [bands, setBands] = useState<Set<AgeBand>>(new Set());
  const [inBuildingOnly, setInBuildingOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const [weights, setWeights] = useState<PriorityWeights>(DEFAULT_PRIORITY_WEIGHTS);
  const [siblingActive, setSiblingActive] = useState<Map<number, number>>(new Map());

  const refresh = async () => {
    const [r, w, sm] = await Promise.all([
      listWaitlist({ statuses: [...statuses], search }),
      loadPriorityWeights(),
      loadActiveStudentMap(),
    ]);
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

  useEffect(() => { void refresh();   }, [statuses, search]);

  const filtered = useMemo(() => {
    const ctx = { siblingStudentActive: siblingActive };
    let r = rows;
    if (bands.size > 0) r = r.filter((e) => bands.has(ageBand(e.birthday)));
    if (inBuildingOnly) r = r.filter((e) => e.in_building === 1);
    return [...r].sort((a, b) => priorityScore(b, weights, ctx) - priorityScore(a, weights, ctx));
  }, [rows, bands, inBuildingOnly, weights, siblingActive]);

  const defaultStatusSet =
    statuses.size === DEFAULT_STATUSES.length &&
    DEFAULT_STATUSES.every((s) => statuses.has(s));
  const filtersActive =
    !defaultStatusSet || bands.size > 0 || inBuildingOnly || search.trim().length > 0;

  const clearFilters = () => {
    setStatuses(new Set(DEFAULT_STATUSES));
    setBands(new Set());
    setInBuildingOnly(false);
    setSearch("");
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
              <Th>Score</Th>
              <Th>Child</Th>
              <Th>Age band</Th>
              <Th>Parent / Email</Th>
              <Th>Phone</Th>
              <Th>Submitted</Th>
              <Th>Target start</Th>
              <Th>In bldg</Th>
              <Th>Status</Th>
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
                  <Td>
                    <div>{e.parent_name || "—"}</div>
                    <div style={{ fontSize: 12, color: "var(--muted)" }}>{e.parent_email || ""}</div>
                  </Td>
                  <Td>{e.phone || "—"}</Td>
                  <Td>{waitDays(e.submitted_at)}d ago</Td>
                  <Td>{e.target_start || "—"}</Td>
                  <Td>{e.in_building === 1 ? "✓" : e.in_building === 0 ? "—" : "?"}</Td>
                  <Td><span style={statusChipStyle(e.status)}>{e.status}</span></Td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={9} style={{ padding: 24, textAlign: "center", color: "var(--muted)" }}>No entries match these filters.</td></tr>
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
function Td({ children }: { children: React.ReactNode }) {
  return <td style={{ padding: "10px 12px", fontSize: 14, verticalAlign: "top" }}>{children}</td>;
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
