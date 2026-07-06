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
import { setSetting, getSettings as getAppSettings } from "../db";

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
    const appSettings = await getAppSettings();
    const quietNow = isWithinQuietHours(appSettings.notif_quiet_hours_start || "", appSettings.notif_quiet_hours_end || "");
    // H-2: pre-seed every *enabled* category with an empty survivor list
    // before any scanner runs. Previously a category only got an entry in
    // `perCategory` once at least one surviving item arrived for it — so a
    // scanner that ran and found ZERO current issues (the "resolved without
    // user action" case) left its old notifications stuck forever, because
    // softDeleteResolved(category, keys) was never even called for that
    // category. Pre-seeding means every enabled category is always
    // reconciled against whatever this run actually found (possibly
    // nothing), while disabled categories are left untouched.
    const perCategory = new Map<string, string[]>();
    const enabledCategories = new Set<string>();
    for (const scanner of SCANNERS) {
      const setting = settings.get(scanner.category);
      const enabled = setting ? setting.enabled === 1 : true; // default on
      if (enabled) {
        enabledCategories.add(scanner.category);
        if (!perCategory.has(scanner.category)) perCategory.set(scanner.category, []);
      }
    }
    for (const scanner of SCANNERS) {
      if (!enabledCategories.has(scanner.category)) continue;
      const inputs = await safeRun(scanner);
      const setting = settings.get(scanner.category);
      const minSev: Severity = (setting?.min_severity || "info") as Severity;
      for (const inp of inputs) {
        if (!severityGte(inp.severity, minSev)) continue;
        try {
          await upsertByDedupKey(inp);
          const list = perCategory.get(inp.category) ?? [];
          list.push(inp.dedup_key);
          perCategory.set(inp.category, list);
          // Desktop alert channel — per-category opt-in, suppressed during
          // quiet hours (the notification itself is still stored above).
          const catSetting = settings.get(inp.category);
          if (!quietNow && catSetting?.desktop_enabled === 1) {
            void maybeSendDesktopNotification(inp.title, inp.body ?? "");
          }
        } catch (e) {
          console.warn("[notifications] upsert failed", inp.dedup_key, e);
        }
      }
    }
    // Reconcile every enabled category against this run's survivor set —
    // including categories where the survivor set is empty.
    for (const [cat, keys] of perCategory.entries()) {
      try { await softDeleteResolved(cat, keys); } catch (e) { console.warn("[notifications] reconcile failed", cat, e); }
    }
    lastRun = Date.now();
    try { await setSetting("notif_last_scan_at", new Date().toISOString()); } catch {}
    await notifySubscribers();
  } finally {
    running = false;
  }
}

async function safeRun(s: ScannerDef) {
  try {
    return await s.run();
  } catch (e) {
    console.warn("[notifications] scanner", s.id, "failed", e);
    return [];
  }
}

// ── L-4: quiet hours + desktop notifications ────────────────────────────
// `notif_quiet_hours_start` / `_end` (HH:MM, 24h) were stored by Settings
// but never read anywhere. During quiet hours we still scan and store
// notifications as normal (the bell/history always reflect ground truth) —
// we only suppress the desktop-alert side channel below.
function isWithinQuietHours(startHHMM: string, endHHMM: string): boolean {
  if (!startHHMM || !endHHMM) return false;
  const [sh, sm] = startHHMM.split(":").map(Number);
  const [eh, em] = endHHMM.split(":").map(Number);
  if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return false;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  if (start === end) return false; // degenerate config, treat as "always on"
  return start < end ? (cur >= start && cur < end) : (cur >= start || cur < end); // handles wrap past midnight
}

let loggedMissingDesktopPlugin = false;
/** Best-effort OS desktop notification for a newly-surfaced item.
 * `@tauri-apps/plugin-notification` is not part of this app's dependency
 * set — adding it means new Cargo.toml + capabilities + tauri.conf.json
 * wiring, which is out of scope for this pass. Rather than silently no-op
 * forever, this logs once so the gap stays visible until it's wired up. */
async function maybeSendDesktopNotification(title: string, body: string): Promise<void> {
  if (!loggedMissingDesktopPlugin) {
    loggedMissingDesktopPlugin = true;
    console.info(
      "[notifications] Desktop notification requested but @tauri-apps/plugin-notification " +
      "isn't installed — skipping (see L-4 in the hardening pass).",
      { title, body },
    );
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
