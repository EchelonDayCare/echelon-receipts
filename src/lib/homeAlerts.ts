// v2.6.1 Home alert routing.
//
// Extracts the alert-computation that used to live inline in Home.tsx and
// re-emits it as a per-tile / per-sidebar-route map. The UI consumes this
// via useHomeAlerts() and renders dots on Home tiles + sidebar sub-items
// instead of a standalone "Needs your attention" section. Setup gaps
// (SMTP, cloud backup) roll up onto the Settings cog badge.
//
// This does NOT replace NotificationBell — the bell shows the richer
// scanner-driven notification history. This is the at-a-glance surface
// so users always know where to click next without a scroll.
//
// Non-negotiable: alert queries here must stay cheap. They run once per
// provider mount + on window focus. Anything slow gets a `Promise.race`
// against a 2s timeout via safeRun() below.

import { db, getSettings, listStudents } from "./db";
import { listAllCredentialsWithStaff, credStatus } from "./credentials";
import type { SettingsMap } from "../types";

export type Tone = "danger" | "warn" | "info";
export type TileKey =
  | "students"
  | "staff"
  | "comms"
  | "waitlist"
  | "expenses"
  | "reports"
  | "vault"
  | "organizer"
  | "graduation";

export interface AlertItem {
  tone: Tone;
  text: string;
  /** Sub-route inside the tile that actually resolves the alert. Sidebar
   *  dots are keyed off this. */
  sub?: string;
}

export interface TileAlerts {
  tone: Tone;    // highest severity in the tile
  count: number; // total alert count in the tile
  items: AlertItem[];
}

export interface HomeAlertsSnapshot {
  byTile: Partial<Record<TileKey, TileAlerts>>;
  /** Keyed by exact sidebar `to` prop, e.g. "/staff/credentials" or
   *  "/vault?expiring=60". Sidebar renderer looks up its own `to` here. */
  bySidebar: Record<string, TileAlerts>;
  setup: {
    smtp: boolean;    // true = SMTP is NOT configured
    backup: boolean;  // true = cloud backup is not configured OR overdue
    needsSetup: boolean;
    items: AlertItem[];
  };
  /** Labels of scanners that timed out or errored. If non-empty, the UI
   *  should surface a subtle "some checks failed" indicator so users don't
   *  falsely assume "no alerts = nothing to do". P1 from review. */
  partialLoad: string[];
  /** ISO timestamp of when this snapshot was produced. */
  computedAt: string;
}

const TONE_RANK: Record<Tone, number> = { info: 1, warn: 2, danger: 3 };
function bumpTone(current: Tone | undefined, next: Tone): Tone {
  if (!current) return next;
  return TONE_RANK[next] > TONE_RANK[current] ? next : current;
}

/** Emitted by a scanner. Merged into the outer maps ONLY if the scanner
 *  finished before its timeout — this prevents late-completing scans from
 *  mutating an already-published snapshot (P1 from Codex review). */
interface ScanResult {
  tile: TileKey;
  sub?: string;
  tone: Tone;
  text: string;
}

function mergeResults(
  byTile: Partial<Record<TileKey, TileAlerts>>,
  bySidebar: Record<string, TileAlerts>,
  results: ScanResult[],
) {
  for (const r of results) {
    const item: AlertItem = { tone: r.tone, text: r.text, sub: r.sub };
    const t = byTile[r.tile] ?? { tone: r.tone, count: 0, items: [] };
    t.tone = bumpTone(t.tone, r.tone);
    t.count += 1;
    t.items.push(item);
    byTile[r.tile] = t;

    if (r.sub) {
      const s = bySidebar[r.sub] ?? { tone: r.tone, count: 0, items: [] };
      s.tone = bumpTone(s.tone, r.tone);
      s.count += 1;
      s.items.push(item);
      bySidebar[r.sub] = s;
    }
  }
}

/** Runs a scanner with a timeout and error swallow. Returns the scanner's
 *  own local result list on success, or null on timeout/error. Late
 *  completions after timeout do NOT mutate outer state — the scanner
 *  writes only to its own local accumulator, which the caller merges
 *  only if the race resolved with the value (not the timeout). */
async function safeRun(
  label: string,
  scan: () => Promise<ScanResult[]>,
  timeoutMs = 2500,
): Promise<{ ok: true; results: ScanResult[] } | { ok: false; reason: "timeout" | "error" }> {
  let timedOut = false;
  const timeout = new Promise<null>((resolve) => setTimeout(() => { timedOut = true; resolve(null); }, timeoutMs));
  try {
    const winner = await Promise.race([scan(), timeout]);
    if (timedOut || winner === null) {
      console.warn(`[homeAlerts:${label}] timed out after ${timeoutMs}ms`);
      return { ok: false, reason: "timeout" };
    }
    return { ok: true, results: winner };
  } catch (e) {
    console.warn(`[homeAlerts:${label}] failed:`, e);
    return { ok: false, reason: "error" };
  }
}

export async function computeHomeAlerts(): Promise<HomeAlertsSnapshot> {
  const settings: SettingsMap = await getSettings();
  const byTile: Partial<Record<TileKey, TileAlerts>> = {};
  const bySidebar: Record<string, TileAlerts> = {};

  // ── Setup gaps (routed to cog badge, not a tile) ──────────────────────
  const smtpMissing = !settings.smtp_host?.trim() || settings.smtp_password_set !== "1";
  const backupCloudEnabled = settings.backup_cloud_enabled !== "0";
  const lastCloud = settings.last_cloud_backup_at;
  const backupUnconfigured = backupCloudEnabled && !lastCloud;
  const setupItems: AlertItem[] = [];
  if (smtpMissing) {
    setupItems.push({
      tone: "warn",
      text: "Email isn't configured — receipts can be saved but not emailed.",
      sub: "/config/email",
    });
  }
  if (backupUnconfigured) {
    setupItems.push({
      tone: "warn",
      text: "Cloud backup not configured yet — your data isn't being emailed anywhere.",
      sub: "/config/backups",
    });
  }
  // Backup stale (had one, now overdue) is a data alert but still belongs
  // to Config — surface it on the cog as danger.
  let backupStale = false;
  if (backupCloudEnabled && lastCloud) {
    const daysSinceCloud = Math.floor((Date.now() - Date.parse(lastCloud)) / 86_400_000);
    if (!Number.isNaN(daysSinceCloud) && daysSinceCloud > 35) {
      backupStale = true;
      setupItems.push({
        tone: "danger",
        text: `Last cloud backup was ${daysSinceCloud} days ago — overdue.`,
        sub: "/config/backups",
      });
    }
  }

  // ── Students: missing monthly receipts ───────────────────────────────
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const ym = `${y}-${String(m).padStart(2, "0")}`;
  const partialLoad: string[] = [];
  const runAndMerge = async (label: string, scan: () => Promise<ScanResult[]>) => {
    const outcome = await safeRun(label, scan);
    if (outcome.ok) mergeResults(byTile, bySidebar, outcome.results);
    else partialLoad.push(label);
  };

  await runAndMerge("issued", async () => {
    const d = await db();
    const [total, issued] = await Promise.all([
      listStudents(y, true),
      d.select<{ n: number }[]>(
        `SELECT COUNT(DISTINCT student_id) AS n
           FROM receipts
          WHERE substr(date,1,7) = ?
            AND voided = 0
            AND is_refund = 0`,
        [ym],
      ),
    ]);
    const issuedCount = issued[0]?.n ?? 0;
    const missing = total.length - issuedCount;
    const out: ScanResult[] = [];
    if (missing > 0) {
      out.push({
        tile: "students", sub: "/students/month", tone: "warn",
        text: `${missing} of ${total.length} students don't have a receipt for ${now.toLocaleString(undefined, { month: "long", year: "numeric" })} yet.`,
      });
    }
    return out;
  });

  // ── Staff: credentials expired / expiring, unpublished shifts ────────
  if (settings.feature_staff_hours_enabled === "1") {
    await runAndMerge("credentials", async () => {
      const alertDays = Number(settings.staff_cred_alert_days || "60");
      const creds = await listAllCredentialsWithStaff();
      let expired = 0, expiring = 0;
      for (const c of creds) {
        const st = credStatus(c.expiry_date, alertDays);
        if (st === "expired") expired++;
        else if (st === "expiring") expiring++;
      }
      const out: ScanResult[] = [];
      if (expired > 0) {
        out.push({
          tile: "staff", sub: "/staff/credentials", tone: "danger",
          text: `${expired} staff credential${expired === 1 ? " has" : "s have"} expired.`,
        });
      }
      if (expiring > 0) {
        out.push({
          tile: "staff", sub: "/staff/credentials", tone: "warn",
          text: `${expiring} staff credential${expiring === 1 ? "" : "s"} expir${expiring === 1 ? "es" : "e"} in the next ${alertDays} days.`,
        });
      }
      return out;
    });

    await runAndMerge("schedule", async () => {
      const { mondayOf, listShiftsForWeek, listWeeklyPublishes } = await import("../repo/scheduleRepo");
      const weekStart = mondayOf(new Date());
      const [shifts, publishes] = await Promise.all([
        listShiftsForWeek(weekStart),
        listWeeklyPublishes(weekStart),
      ]);
      const publishedStaff = new Set(publishes.map((p) => p.staffId));
      const unpubStaff = new Set<string>();
      for (const s of shifts) if (!publishedStaff.has(s.staffId)) unpubStaff.add(s.staffId);
      const out: ScanResult[] = [];
      if (unpubStaff.size > 0) {
        out.push({
          tile: "staff", sub: "/staff/schedule", tone: "warn",
          text: `${unpubStaff.size} staff have unpublished shifts this week.`,
        });
      }
      return out;
    });
  }

  // ── Communications: scheduled messages due ───────────────────────────
  await runAndMerge("scheduled", async () => {
    const { dueScheduled } = await import("./comms");
    const due = await dueScheduled();
    const out: ScanResult[] = [];
    if (due.length > 0) {
      out.push({
        tile: "comms", sub: "/communications/scheduled", tone: "info",
        text: `${due.length} scheduled message${due.length === 1 ? " is" : "s are"} ready to send.`,
      });
    }
    return out;
  });

  // ── Vault: docs expired / expiring ───────────────────────────────────
  await runAndMerge("vault", async () => {
    const { expiringSoon } = await import("../repo/documentsRepo");
    const soon = await expiringSoon(60);
    const out: ScanResult[] = [];
    if (soon.length > 0) {
      const today = new Date().toISOString().slice(0, 10);
      const overdue = soon.filter((doc) => doc.expiryDate && doc.expiryDate < today).length;
      const upcoming = soon.length - overdue;
      if (overdue > 0) {
        out.push({
          tile: "vault", sub: "/vault?expiring=60", tone: "danger",
          text: `${overdue} vault document${overdue === 1 ? " has" : "s have"} expired.`,
        });
      }
      if (upcoming > 0) {
        out.push({
          tile: "vault", sub: "/vault?expiring=60", tone: "warn",
          text: `${upcoming} vault document${upcoming === 1 ? "" : "s"} expir${upcoming === 1 ? "es" : "e"} within 60 days.`,
        });
      }
    }
    return out;
  });

  // ── Organizer: items due today / this week ───────────────────────────
  await runAndMerge("organizer", async () => {
    const { countDueToday, countDueThisWeek } = await import("../repo/organizerRepo");
    const [today, week] = await Promise.all([countDueToday(), countDueThisWeek()]);
    const out: ScanResult[] = [];
    if (today > 0) {
      out.push({
        tile: "organizer", sub: "/organizer", tone: "danger",
        text: `${today} item${today === 1 ? " is" : "s are"} due today.`,
      });
    } else if (week > 0) {
      out.push({
        tile: "organizer", sub: "/organizer", tone: "info",
        text: `${week} item${week === 1 ? "" : "s"} due within 7 days.`,
      });
    }
    return out;
  });

  return {
    byTile,
    bySidebar,
    setup: {
      smtp: smtpMissing,
      backup: backupUnconfigured || backupStale,
      needsSetup: setupItems.length > 0,
      items: setupItems,
    },
    partialLoad,
    computedAt: new Date().toISOString(),
  };
}
