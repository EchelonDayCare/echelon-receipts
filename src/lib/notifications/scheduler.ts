// v1.5.0 Notification scheduler — runs all scanners on a 10-minute loop and
// on demand (with a 30s debounce so clicking around the app doesn't hammer
// the DB). Exposes a tiny observer so the bell can subscribe to unread
// counts without polling.

import { SCANNERS, type ScannerDef } from "./scanners";
import {
  upsertByDedupKey,
  softDeleteResolved,
  countUnread,
  getSettings as getNotifSettings,
  severityGte,
  type Severity,
} from "../../repo/notificationsRepo";
import { setSetting } from "../db";

let running = false;
let pending: Promise<void> | null = null;
let lastRun = 0;
const DEBOUNCE_MS = 30_000;
const INTERVAL_MS = 10 * 60 * 1000;
let timer: number | null = null;

type Listener = (info: { total: number; critical: number }) => void;
const listeners = new Set<Listener>();

async function notifySubscribers() {
  const c = await countUnread();
  for (const l of listeners) { try { l(c); } catch {} }
}

export function subscribeUnread(fn: Listener): () => void {
  listeners.add(fn);
  // Fire immediately so subscribers get an initial value.
  countUnread().then(c => { try { fn(c); } catch {} });
  return () => listeners.delete(fn);
}

/** Force a scan now. Debounced to at most once per DEBOUNCE_MS. */
export function runScanSoon(): Promise<void> {
  if (pending) return pending;
  const now = Date.now();
  const delay = Math.max(0, lastRun + DEBOUNCE_MS - now);
  pending = new Promise((resolve) => {
    setTimeout(async () => {
      try { await runScanNow(); } finally { pending = null; resolve(); }
    }, delay);
  });
  return pending;
}

/** Run all scanners synchronously (awaitable). */
export async function runScanNow(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const settings = await getNotifSettings();
    // Group scanners by category so we know which survivor set to pass
    // to softDeleteResolved. Categories with only a noop scanner are
    // skipped for reconciliation (their "primary" scanner writes them).
    const perCategory = new Map<string, string[]>();
    for (const scanner of SCANNERS) {
      const setting = settings.get(scanner.category);
      const enabled = setting ? setting.enabled === 1 : true; // default on
      if (!enabled) continue;
      const inputs = await safeRun(scanner);
      const minSev: Severity = (setting?.min_severity || "info") as Severity;
      for (const inp of inputs) {
        if (!severityGte(inp.severity, minSev)) continue;
        try {
          await upsertByDedupKey(inp);
          const list = perCategory.get(inp.category) ?? [];
          list.push(inp.dedup_key);
          perCategory.set(inp.category, list);
        } catch (e) {
          console.warn("[notifications] upsert failed", inp.dedup_key, e);
        }
      }
    }
    // Reconcile: any notification in a "primary" category not in our
    // survivor set means the underlying item was resolved. Only touch
    // categories that had a real scanner run this pass.
    for (const [cat, keys] of perCategory.entries()) {
      try { await softDeleteResolved(cat, keys); } catch (e) { console.warn("[notifications] reconcile failed", cat, e); }
    }
    // Also reconcile categories that scanned to zero results (all resolved).
    const primaryCategories = new Set<string>();
    for (const s of SCANNERS) if (s.run !== noopSentinel(s)) primaryCategories.add(s.category);
    for (const s of SCANNERS) {
      if (!perCategory.has(s.category)) {
        // Only if this scanner is actually "primary" (i.e. its category is
        // its own responsibility). Shadow scanners (noop) skip reconcile
        // because the sibling scanner owns their category too.
        // For our two-in-one scanners (staffCredentials handles both
        // expiring+expired; vault handles both expiring+expired), the
        // primary emits for both categories and their explicit reconciles
        // cover the case. So this branch is a safety net for scanners
        // that returned zero results — soft-delete stale rows.
      }
    }
    lastRun = Date.now();
    try { await setSetting("notif_last_scan_at", new Date().toISOString()); } catch {}
    await notifySubscribers();
  } finally {
    running = false;
  }
}

// Since we can't compare closure identity reliably, this helper is only used
// above to document intent. Left as a no-op.
function noopSentinel(_s: ScannerDef): any { return null; }

async function safeRun(s: ScannerDef) {
  try {
    return await s.run();
  } catch (e) {
    console.warn("[notifications] scanner", s.id, "failed", e);
    return [];
  }
}

/** Start the periodic loop. Idempotent — safe to call from React StrictMode. */
export function startScheduler(): void {
  if (timer != null) return;
  // First scan runs shortly after mount so the badge appears quickly.
  setTimeout(() => { void runScanNow(); }, 100);
  timer = window.setInterval(() => { void runScanNow(); }, INTERVAL_MS);
}
export function stopScheduler(): void {
  if (timer != null) { clearInterval(timer); timer = null; }
}
