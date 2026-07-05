// Waitlist list view — /waitlist/list
// Full table with filter bar, sort by priority score.

import { useEffect, useMemo, useState } from "react";
import {
  listWaitlist, syncOnScreenOpen, ageBand, waitDays, priorityScore,
  WAITLIST_STATUSES, type WaitlistEntry, type WaitlistStatus, type AgeBand,
} from "../../lib/waitlist";
import DetailDrawer from "./DetailDrawer";

const BANDS: AgeBand[] = ["Infant", "Toddler", "3-5yr", "School-age", "Unknown"];

export default function WaitlistList() {
  const [rows, setRows] = useState<WaitlistEntry[]>([]);
  const [statuses, setStatuses] = useState<Set<WaitlistStatus>>(
    new Set(["new", "contacted", "offered"] as WaitlistStatus[]),
  );
  const [bands, setBands] = useState<Set<AgeBand>>(new Set());
  const [inBuildingOnly, setInBuildingOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);

  const refresh = async () => {
    const r = await listWaitlist({ statuses: [...statuses], search });
    setRows(r);
  };

  useEffect(() => {
    (async () => {
      await syncOnScreenOpen();
      await refresh();
    })();
  }, []);

  useEffect(() => { void refresh(); /* eslint-disable-next-line */ }, [statuses, search]);

  const filtered = useMemo(() => {
    let r = rows;
    if (bands.size > 0) r = r.filter((e) => bands.has(ageBand(e.birthday)));
    if (inBuildingOnly) r = r.filter((e) => e.in_building === 1);
    return [...r].sort((a, b) => priorityScore(b) - priorityScore(a));
  }, [rows, bands, inBuildingOnly]);

  return (
    <div>
      <h1>Waitlist — All</h1>

      <div className="card" style={{ marginBottom: 16 }}>
        {/* Filter bar */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
          <div>
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
          <div>
            <label style={labelSmall}>Age band</label>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {BANDS.map((b) => (
                <Chip
                  key={b}
                  label={b}
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
            <label style={labelSmall}>&nbsp;</label>
            <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
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
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f8fafc" }}>
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
            {filtered.map((e) => (
              <tr key={e.id} style={{ cursor: "pointer", borderTop: "1px solid var(--border)" }}
                  onClick={() => setOpenId(e.id)}
                  onMouseEnter={(ev) => (ev.currentTarget as HTMLTableRowElement).style.background = "#f8fafc"}
                  onMouseLeave={(ev) => (ev.currentTarget as HTMLTableRowElement).style.background = ""}
              >
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
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={8} style={{ padding: 24, textAlign: "center", color: "var(--muted)" }}>No entries match these filters.</td></tr>
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

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
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
