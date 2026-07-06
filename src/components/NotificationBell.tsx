import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  countUnread,
  listVisible,
  markRead,
  markAllRead,
  dismiss,
  undoDismiss,
  snooze,
  type Notification,
} from "../repo/notificationsRepo";
import { runScanSoon, subscribeUnread } from "../lib/notifications/scheduler";

// ─── Bell (icon + badge) ──────────────────────────────────────────────
export default function NotificationBell({ size = 20 }: { size?: number }) {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState<{ total: number; critical: number }>({ total: 0, critical: 0 });
  const btnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const unsub = subscribeUnread(setCount);
    return () => unsub();
  }, []);

  useEffect(() => { if (open) void runScanSoon(); }, [open]);

  const padding = Math.max(8, Math.round(size * 0.55));
  const badgeSize = Math.max(18, Math.round(size * 0.9));
  const badgeFont = Math.max(11, Math.round(size * 0.55));

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={btnRef}
        onClick={() => setOpen(v => !v)}
        aria-label={`Notifications (${count.total} unread)`}
        title="Notifications"
        style={{
          position: "relative",
          background: "transparent",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: `${padding}px ${padding + 2}px`,
          cursor: "pointer",
          fontSize: size,
          lineHeight: 1,
        }}
      >
        <span aria-hidden>🔔</span>
        {count.total > 0 && (
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: -6,
              right: -6,
              minWidth: badgeSize,
              height: badgeSize,
              padding: "0 6px",
              borderRadius: badgeSize / 2,
              background: count.critical > 0 ? "#dc2626" : "#2563eb",
              color: "#fff",
              fontSize: badgeFont,
              fontWeight: 700,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              lineHeight: 1,
              boxShadow: "0 0 0 2px var(--panel, #fff)",
            }}
          >
            {count.total > 9 ? "10+" : count.total}
          </span>
        )}
      </button>
      {open && <NotificationPanel onClose={() => setOpen(false)} onCount={setCount} />}
    </div>
  );
}

// ─── Panel (dropdown) ─────────────────────────────────────────────────
function NotificationPanel({
  onClose,
  onCount,
}: { onClose: () => void; onCount: (c: { total: number; critical: number }) => void }) {
  const [rows, setRows] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastDismissed, setLastDismissed] = useState<Notification | null>(null);
  const nav = useNavigate();
  const ref = useRef<HTMLDivElement | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const list = await listVisible({ limit: 100 });
      setRows(list);
      onCount(await countUnread());
    } catch (e) {
      console.warn("[bell:refresh] failed:", e);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refresh(); }, []);

  // ESC + outside click
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    // Delay outside listener 1 tick so the click that opened us doesn't close us.
    const t = window.setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    return () => { window.removeEventListener("keydown", onKey); clearTimeout(t); document.removeEventListener("mousedown", onDoc); };
  }, [onClose]);

  // Batch ≥3 same-category unread within an hour into a single collapsed row.
  const view = useMemo(() => buildBatchedView(rows), [rows]);

  async function openRow(n: Notification) {
    if (!n.read_at) await markRead(n.id, n.version);
    if (n.action_route) nav(n.action_route);
    onClose();
  }

  async function onDismiss(n: Notification) {
    await dismiss(n.id, n.version);
    setLastDismissed(n);
    await refresh();
  }

  async function onSnooze(n: Notification, hours: number) {
    const until = new Date(Date.now() + hours * 3600_000).toISOString();
    await snooze(n.id, until, n.version);
    await refresh();
  }

  async function onMarkAll() {
    await markAllRead(rows.filter(r => !r.read_at).map(r => r.id));
    await refresh();
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Notifications"
      style={{
        position: "absolute",
        top: "calc(100% + 6px)",
        right: 0,
        width: 380,
        maxHeight: 520,
        background: "var(--panel, #fff)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        boxShadow: "0 10px 30px rgba(0,0,0,0.15)",
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <header style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <strong style={{ fontSize: 14 }}>Notifications</strong>
        <button className="btn ghost" style={{ fontSize: 12 }} onClick={onMarkAll} disabled={!rows.some(r => !r.read_at)}>
          Mark all as read
        </button>
      </header>
      <div style={{ overflowY: "auto", flex: 1 }}>
        {loading ? (
          <div style={{ padding: 24, color: "var(--muted)", fontSize: 13 }}>Loading…</div>
        ) : view.length === 0 ? (
          <div style={{ padding: 32, color: "var(--muted)", fontSize: 13, textAlign: "center" }}>
            You're all caught up. 🎉
          </div>
        ) : (
          view.map((item) => (
            item.kind === "single"
              ? <Row key={item.n.id} n={item.n} onOpen={openRow} onDismiss={onDismiss} onSnooze={onSnooze} />
              : <BatchedRow key={item.category + item.count} category={item.category} count={item.count} onExpand={() => {
                  nav("/notifications?category=" + encodeURIComponent(item.category));
                  onClose();
                }} />
          ))
        )}
      </div>
      <footer style={{ padding: "8px 14px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
        {lastDismissed
          ? <button className="btn ghost" onClick={async () => { await undoDismiss(lastDismissed.id); setLastDismissed(null); await refresh(); }}>Undo dismiss</button>
          : <span style={{ color: "var(--muted)" }}>{rows.length} total</span>}
        <button className="btn ghost" onClick={() => { nav("/notifications"); onClose(); }}>
          View all →
        </button>
      </footer>
    </div>
  );
}

function Row({
  n, onOpen, onDismiss, onSnooze,
}: { n: Notification; onOpen: (n: Notification) => void; onDismiss: (n: Notification) => void; onSnooze: (n: Notification, hours: number) => void }) {
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const snoozeRef = useRef<HTMLDivElement | null>(null);

  // Close snooze dropdown when clicking outside it (M-17).
  useEffect(() => {
    if (!snoozeOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (snoozeRef.current && !snoozeRef.current.contains(e.target as Node)) {
        setSnoozeOpen(false);
      }
    };
    const t = window.setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    return () => { clearTimeout(t); document.removeEventListener("mousedown", onDoc); };
  }, [snoozeOpen]);
  return (
    <div
      style={{
        padding: "10px 14px",
        borderBottom: "1px solid var(--border)",
        background: n.read_at ? "transparent" : "rgba(37,99,235,0.04)",
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        cursor: "pointer",
      }}
      onClick={() => onOpen(n)}
    >
      <span aria-hidden style={{ marginTop: 2 }}>{sevIcon(n.severity)}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: n.read_at ? 500 : 600, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {n.title}
        </div>
        {n.body && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{n.body}</div>}
        <div style={{ display: "flex", gap: 6, marginTop: 6 }} onClick={e => e.stopPropagation()}>
          <button className="btn ghost" style={{ fontSize: 11, padding: "2px 6px" }} onClick={() => onOpen(n)}>Open</button>
          <div ref={snoozeRef} style={{ position: "relative" }}>
            <button className="btn ghost" style={{ fontSize: 11, padding: "2px 6px" }} onClick={() => setSnoozeOpen(v => !v)}>Snooze ▾</button>
            {snoozeOpen && (
              <div style={{ position: "absolute", top: "100%", left: 0, background: "var(--panel,#fff)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "0 4px 14px rgba(0,0,0,0.12)", zIndex: 20, minWidth: 120 }}>
                {[["1h", 1], ["4h", 4], ["Tomorrow", 24], ["Next week", 24 * 7]].map(([label, hrs]) => (
                  <button key={label as string} className="btn ghost" style={{ display: "block", width: "100%", textAlign: "left", fontSize: 12, padding: "6px 10px" }} onClick={() => { onSnooze(n, hrs as number); setSnoozeOpen(false); }}>{label}</button>
                ))}
              </div>
            )}
          </div>
          <button className="btn ghost" style={{ fontSize: 11, padding: "2px 6px", color: "#dc2626" }} onClick={() => onDismiss(n)}>Dismiss</button>
        </div>
      </div>
    </div>
  );
}

function BatchedRow({ category, count, onExpand }: { category: string; count: number; onExpand: () => void }) {
  return (
    <button
      onClick={onExpand}
      style={{
        width: "100%",
        textAlign: "left",
        padding: "10px 14px",
        borderBottom: "1px solid var(--border)",
        background: "rgba(0,0,0,0.02)",
        border: 0,
        cursor: "pointer",
        fontSize: 13,
      }}
    >
      <strong>{count} new</strong> {prettifyCategory(category)} — <span style={{ color: "var(--accent)" }}>View all</span>
    </button>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────
function sevIcon(sev: string): string {
  if (sev === "critical") return "🚨";
  if (sev === "warning") return "⚠️";
  return "ℹ️";
}
export function prettifyCategory(c: string): string {
  return c.replace(/_/g, " ");
}

type ViewItem =
  | { kind: "single"; n: Notification }
  | { kind: "batched"; category: string; count: number };

function buildBatchedView(rows: Notification[]): ViewItem[] {
  // Group unread within the last hour by category; if a group has ≥3, collapse.
  const hourAgo = Date.now() - 3600_000;
  const groups = new Map<string, Notification[]>();
  const others: Notification[] = [];
  for (const r of rows) {
    const created = new Date(r.created_at).getTime();
    if (!r.read_at && created >= hourAgo) {
      const list = groups.get(r.category) ?? [];
      list.push(r);
      groups.set(r.category, list);
    } else {
      others.push(r);
    }
  }
  const items: ViewItem[] = [];
  const inlined = new Set<string>();
  for (const [cat, list] of groups.entries()) {
    if (list.length >= 3) {
      items.push({ kind: "batched", category: cat, count: list.length });
      for (const n of list) inlined.add(n.id);
    }
  }
  // Everything else in original (already newest-first) order, minus inlined.
  for (const r of rows) {
    if (!inlined.has(r.id)) items.push({ kind: "single", n: r });
  }
  return items;
}
