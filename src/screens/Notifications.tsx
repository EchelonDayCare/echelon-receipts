import { useEffect, useMemo, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import {
  listVisible,
  markRead,
  markAllRead,
  dismiss,
  type Notification,
  type Severity,
} from "../repo/notificationsRepo";
import { runScanNow } from "../lib/notifications/scheduler";
import { prettifyCategory } from "../components/NotificationBell";

const ALL_CATEGORIES = [
  "staff_credential_expiring",
  "staff_credential_expired",
  "drill_overdue",
  "document_expiring",
  "document_expired",
  "receipt_aging",
  "schedule_not_published",
  "schedule_change_ack_missing",
  "meeting_action_due",
  "followup_due",
  "waitlist_offer_expiring",
  "waitlist_new_application",
  "agm_deadline",
  "tslip_deadline",
  "ccfri_claim_due",
  "backup_stale",
  "backup_failed",
  "system_update_available",
  "system_error",
];

export default function NotificationsHistory() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const initialCategory = params.get("category") || "";
  const [category, setCategory] = useState<string>(initialCategory);
  const [severity, setSeverity] = useState<string>("");
  const [readState, setReadState] = useState<"all" | "unread" | "read">("all");
  const [sinceDays, setSinceDays] = useState<number>(30);
  const [rows, setRows] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  async function refresh() {
    setLoading(true);
    try {
      const list = await listVisible({
        category: category ? [category] : undefined,
        severity: severity ? [severity as Severity] : undefined,
        unreadOnly: readState === "unread",
        hideSnoozed: false,
        hideDismissed: false,
        sinceDays,
        limit: 500,
      });
      const filtered = readState === "read" ? list.filter(r => r.read_at) : list;
      setRows(filtered);
    } catch (e) {
      console.warn("[notifications:list] failed:", e);
      setRows([]);
    } finally {
      setLoading(false);
      setSelected(new Set());
    }
  }
  useEffect(() => { void refresh(); }, [category, severity, readState, sinceDays]);

  // Sync `category` state from URL on every param change (sidebar nav doesn't remount).
  useEffect(() => {
    const urlCat = params.get("category") || "";
    setCategory((prev) => (prev === urlCat ? prev : urlCat));
  }, [params]);

  useEffect(() => {
    // Keep URL in sync (for deep links from the panel).
    const next = new URLSearchParams(params);
    if (category) next.set("category", category); else next.delete("category");
    setParams(next, { replace: true });
  }, [category]);

  function toggleSelect(id: string) {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id); else s.add(id);
    setSelected(s);
  }

  async function bulkMarkRead() {
    await markAllRead(Array.from(selected));
    await refresh();
  }
  async function bulkDismiss() {
    for (const id of selected) {
      const row = rows.find(r => r.id === id);
      if (row) await dismiss(row.id, row.version);
    }
    await refresh();
  }

  function exportCsv() {
    const header = ["created_at","category","severity","title","body","source_kind","source_id","read_at","dismissed_at","snoozed_until"];
    const cells = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [header.join(","), ...rows.map(r => header.map(h => cells((r as any)[h])).join(","))].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `notifications-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const grouped = useMemo(() => groupByDay(rows), [rows]);

  return (
    <div style={{ padding: 20, maxWidth: 1100 }}>
      <h1 style={{ marginTop: 0 }}>Notifications</h1>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end", padding: 12, background: "var(--card, #f9fafb)", border: "1px solid var(--border)", borderRadius: 10, marginBottom: 14 }}>
        <div className="field">
          <label>Category</label>
          <select value={category} onChange={e => setCategory(e.target.value)}>
            <option value="">All</option>
            {ALL_CATEGORIES.map(c => <option key={c} value={c}>{prettifyCategory(c)}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Severity</label>
          <select value={severity} onChange={e => setSeverity(e.target.value)}>
            <option value="">Any</option>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </select>
        </div>
        <div className="field">
          <label>Read state</label>
          <select value={readState} onChange={e => setReadState(e.target.value as any)}>
            <option value="all">All</option>
            <option value="unread">Unread only</option>
            <option value="read">Read only</option>
          </select>
        </div>
        <div className="field">
          <label>Since (days)</label>
          <input type="number" min={1} max={365} value={sinceDays} onChange={e => setSinceDays(Number(e.target.value) || 30)} style={{ width: 80 }} />
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="btn secondary" onClick={() => void runScanNow().then(refresh)}>Rescan now</button>
          <button className="btn secondary" onClick={exportCsv} disabled={rows.length === 0}>Export CSV</button>
        </div>
      </div>

      {selected.size > 0 && (
        <div style={{ padding: "8px 12px", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8, marginBottom: 10, display: "flex", gap: 10, alignItems: "center" }}>
          <span>{selected.size} selected</span>
          <button className="btn ghost" onClick={bulkMarkRead}>Mark read</button>
          <button className="btn ghost" onClick={bulkDismiss}>Dismiss</button>
          <button className="btn ghost" onClick={() => setSelected(new Set())}>Clear selection</button>
        </div>
      )}

      {loading ? (
        <div style={{ color: "var(--muted)" }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>No notifications match these filters.</div>
      ) : (
        grouped.map(g => (
          <div key={g.day} style={{ marginBottom: 20 }}>
            <h3 style={{ fontSize: 13, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 8 }}>{g.day}</h3>
            <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
              {g.items.map(n => (
                <div key={n.id} style={{ display: "flex", gap: 10, padding: "10px 14px", borderBottom: "1px solid var(--border)", background: n.read_at ? "transparent" : "rgba(37,99,235,0.04)" }}>
                  <input type="checkbox" checked={selected.has(n.id)} onChange={() => toggleSelect(n.id)} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: n.read_at ? 500 : 600 }}>
                      <SevBadge sev={n.severity} /> {n.title}
                      {n.dismissed_at && <span style={{ color: "var(--muted)", fontSize: 11, marginLeft: 6 }}>(dismissed)</span>}
                    </div>
                    {n.body && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{n.body}</div>}
                    <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                      {new Date(n.created_at).toLocaleString()} · {prettifyCategory(n.category)}
                    </div>
                  </div>
                  {n.action_route && (
                    <button className="btn ghost" style={{ fontSize: 12 }} onClick={async () => { if (!n.read_at) await markRead(n.id, n.version); nav(n.action_route!); }}>
                      Open →
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function SevBadge({ sev }: { sev: Severity }) {
  const bg = sev === "critical" ? "#fee2e2" : sev === "warning" ? "#fef3c7" : "#dbeafe";
  const fg = sev === "critical" ? "#991b1b" : sev === "warning" ? "#92400e" : "#1e40af";
  return <span style={{ background: bg, color: fg, padding: "1px 6px", borderRadius: 6, fontSize: 10, marginRight: 4, textTransform: "uppercase", letterSpacing: ".04em", fontWeight: 700 }}>{sev}</span>;
}

function groupByDay(rows: Notification[]) {
  const buckets = new Map<string, Notification[]>();
  for (const r of rows) {
    const key = new Date(r.created_at).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    const list = buckets.get(key) ?? [];
    list.push(r);
    buckets.set(key, list);
  }
  return Array.from(buckets.entries()).map(([day, items]) => ({ day, items }));
}
