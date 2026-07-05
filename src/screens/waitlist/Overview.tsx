// Waitlist overview screen — /waitlist
// KPI cards + "needs attention" list + sync widget.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  waitlistKpis, syncOnScreenOpen, syncWaitlist, readSyncState,
  ageBand, waitDays, type WaitlistKpis, type SyncStateRow,
} from "../../lib/waitlist";
import DetailDrawer from "./DetailDrawer";

export default function WaitlistOverview() {
  const [kpis, setKpis] = useState<WaitlistKpis | null>(null);
  const [syncState, setSyncState] = useState<SyncStateRow | null>(null);
  const [credsLoaded, setCredsLoaded] = useState<boolean>(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const [k, s] = await Promise.all([waitlistKpis(), readSyncState()]);
    setKpis(k);
    setSyncState(s);
    try {
      const st = await invoke<{ credentials_loaded: boolean }>("waitlist_get_status");
      setCredsLoaded(st.credentials_loaded);
    } catch { setCredsLoaded(false); }
  };

  useEffect(() => {
    (async () => {
      await refresh();
      await syncOnScreenOpen();
      await refresh();
    })();
  }, []);

  const doRefresh = async () => {
    setBusy(true);
    try {
      await syncWaitlist({ force: true });
      await refresh();
    } finally { setBusy(false); }
  };

  const lastSyncedIso = syncState?.last_success_at ?? null;
  const staleMinutes = lastSyncedIso ? Math.floor((Date.now() - Date.parse(lastSyncedIso)) / 60_000) : null;
  const fresh = staleMinutes != null && staleMinutes < 15;

  return (
    <div>
      <h1>Waitlist</h1>
      <p className="subtitle">Applications from your Google Form intake, mirrored locally.</p>

      {!credsLoaded && (
        <div className="home-alert tone-warn" style={{ marginBottom: 18 }}>
          <span>Waitlist Sync is not configured yet.</span>
          <Link className="btn link" to="/waitlist/settings">Set up Waitlist Sync →</Link>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 20 }}>
        <div>
          {/* KPI cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
            <Kpi label="Total active" value={kpis ? String(kpis.totalActive) : "—"} />
            <Kpi label="Median wait" value={kpis ? `${kpis.medianWaitDays}d` : "—"} />
            <Kpi label="Stale (>30d)" value={kpis ? String(kpis.stale.length) : "—"} tone={kpis && kpis.stale.length > 0 ? "warn" : undefined} />
            <Kpi
              label="Last synced"
              value={lastSyncedIso ? relTime(lastSyncedIso) : "never"}
              dot={fresh ? "ok" : lastSyncedIso ? "warn" : undefined}
            />
          </div>

          {/* Age bands */}
          {kpis && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
              <Kpi label="Infant (0–18mo)" value={String(kpis.byBand.Infant)} />
              <Kpi label="Toddler (19–36mo)" value={String(kpis.byBand.Toddler)} />
              <Kpi label="3–5yr" value={String(kpis.byBand["3-5yr"])} />
              <Kpi label="School-age" value={String(kpis.byBand["School-age"])} />
            </div>
          )}

          {/* Recent */}
          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ margin: "0 0 12px", fontSize: 14 }}>Recent applications</h3>
            <RowList entries={kpis?.recent ?? []} onOpen={setOpenId} />
          </div>

          {/* Stale actionable list */}
          <div className="card">
            <h3 style={{ margin: "0 0 12px", fontSize: 14 }}>
              Needs follow-up
              <span style={{ marginLeft: 8, color: "var(--muted)", fontWeight: 400 }}>
                (status = new, waited &gt; 30 days)
              </span>
            </h3>
            <RowList entries={kpis?.stale ?? []} onOpen={setOpenId} />
          </div>
        </div>

        {/* Right column: sync widget */}
        <aside>
          <div className="card">
            <h3 style={{ margin: "0 0 10px", fontSize: 14 }}>Sync</h3>
            <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 12 }}>
              Last successful sync:<br />
              <strong style={{ color: "var(--text)" }}>
                {lastSyncedIso ? new Date(lastSyncedIso).toLocaleString() : "never"}
              </strong>
            </div>
            {syncState?.last_error && (
              <div style={{ fontSize: 12, color: "var(--danger)", marginBottom: 12, wordBreak: "break-word" }}>
                Last error: {syncState.last_error}
              </div>
            )}
            <button className="btn primary" disabled={busy || !credsLoaded} onClick={doRefresh}>
              {busy ? "Syncing…" : "Refresh Now"}
            </button>
            <div style={{ marginTop: 12 }}>
              <Link className="btn link" to="/waitlist/settings">Settings →</Link>
            </div>
          </div>
        </aside>
      </div>

      {openId !== null && <DetailDrawer id={openId} onClose={() => { setOpenId(null); void refresh(); }} />}
    </div>
  );
}

function Kpi({ label, value, dot, tone }: {
  label: string; value: string; dot?: "ok" | "warn"; tone?: "warn";
}) {
  const borderColor = tone === "warn" ? "#f59e0b" : "var(--border)";
  return (
    <div className="card" style={{ padding: 14, borderColor }}>
      <div style={{ fontSize: 12, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em", display: "flex", alignItems: "center", gap: 6 }}>
        {dot === "ok" && <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e" }} />}
        {dot === "warn" && <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#f59e0b" }} />}
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function RowList({ entries, onOpen }: {
  entries: { id: number; child_name: string; birthday: string | null; parent_name: string | null; submitted_at: string }[];
  onOpen: (id: number) => void;
}) {
  if (!entries.length) {
    return <div style={{ color: "var(--muted)", fontSize: 13 }}>Nothing here.</div>;
  }
  return (
    <div>
      {entries.map((e) => (
        <button
          key={e.id}
          onClick={() => onOpen(e.id)}
          style={{
            display: "grid", gridTemplateColumns: "1fr 100px 100px", gap: 10, padding: "8px 4px",
            width: "100%", border: "none", background: "transparent",
            borderBottom: "1px solid var(--border)", textAlign: "left", cursor: "pointer",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontWeight: 600 }}>{e.child_name}</div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>{e.parent_name || ""}</div>
          </div>
          <span style={bandChip(ageBand(e.birthday))}>{ageBand(e.birthday)}</span>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>{waitDays(e.submitted_at)}d ago</span>
        </button>
      ))}
    </div>
  );
}

function bandChip(band: string): React.CSSProperties {
  const colors: Record<string, [string, string]> = {
    Infant: ["#fef3c7", "#92400e"],
    Toddler: ["#dbeafe", "#1e40af"],
    "3-5yr": ["#dcfce7", "#166534"],
    "School-age": ["#ede9fe", "#5b21b6"],
    Unknown: ["#e5e7eb", "#475569"],
  };
  const [bg, fg] = colors[band] || colors.Unknown;
  return {
    background: bg, color: fg, padding: "2px 8px", borderRadius: 8,
    fontSize: 12, fontWeight: 600, textAlign: "center",
  };
}

function relTime(iso: string): string {
  const min = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}
