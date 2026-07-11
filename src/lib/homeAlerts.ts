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
  /** ISO timestamp of when this snapshot was produced. */
  computedAt: string;
}

const TONE_RANK: Record<Tone, number> = { info: 1, warn: 2, danger: 3 };
function bumpTone(current: Tone | undefined, next: Tone): Tone {
  if (!current) return next;
  return TONE_RANK[next] > TONE_RANK[current] ? next : current;
}

function pushTile(
  byTile: Partial<Record<TileKey, TileAlerts>>,
  bySidebar: Record<string, TileAlerts>,
  tile: TileKey,
  sub: string | undefined,
  tone: Tone,
  text: string,
) {
  const item: AlertItem = { tone, text, sub };
  const t = byTile[tile] ?? { tone, count: 0, items: [] };
  t.tone = bumpTone(t.tone, tone);
  t.count += 1;
  t.items.push(item);
  byTile[tile] = t;

  if (sub) {
    const s = bySidebar[sub] ?? { tone, count: 0, items: [] };
    s.tone = bumpTone(s.tone, tone);
    s.count += 1;
    s.items.push(item);
    bySidebar[sub] = s;
  }
}

/** Best-effort wrapper: swallows errors + times out at 2.5s so one slow
 *  query never blocks the whole snapshot. */
async function safeRun<T>(label: string, p: Promise<T>): Promise<T | null> {
  try {
    const timeout = new Promise<T | null>((resolve) => setTimeout(() => resolve(null), 2500));
    return await Promise.race([p, timeout]);
  } catch (e) {
    console.warn(`[homeAlerts:${label}] failed:`, e);
    return null;
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
  await safeRun("issued", (async () => {
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
    if (missing > 0) {
      pushTile(
        byTile, bySidebar, "students", "/students/month", "warn",
        `${missing} of ${total.length} students don't have a receipt for ${now.toLocaleString(undefined, { month: "long", year: "numeric" })} yet.`,
      );
    }
  })());

  // ── Staff: credentials expired / expiring, unpublished shifts ────────
  if (settings.feature_staff_hours_enabled === "1") {
    await safeRun("credentials", (async () => {
      const alertDays = Number(settings.staff_cred_alert_days || "60");
      const creds = await listAllCredentialsWithStaff();
      let expired = 0, expiring = 0;
      for (const c of creds) {
        const st = credStatus(c.expiry_date, alertDays);
        if (st === "expired") expired++;
        else if (st === "expiring") expiring++;
      }
      if (expired > 0) {
        pushTile(
          byTile, bySidebar, "staff", "/staff/credentials", "danger",
          `${expired} staff credential${expired === 1 ? " has" : "s have"} expired.`,
        );
      }
      if (expiring > 0) {
        pushTile(
          byTile, bySidebar, "staff", "/staff/credentials", "warn",
          `${expiring} staff credential${expiring === 1 ? "" : "s"} expir${expiring === 1 ? "es" : "e"} in the next ${alertDays} days.`,
        );
      }
    })());

    await safeRun("schedule", (async () => {
      const { mondayOf, listShiftsForWeek, listWeeklyPublishes } = await import("../repo/scheduleRepo");
      const weekStart = mondayOf(new Date());
      const [shifts, publishes] = await Promise.all([
        listShiftsForWeek(weekStart),
        listWeeklyPublishes(weekStart),
      ]);
      const publishedStaff = new Set(publishes.map((p) => p.staffId));
      const unpubStaff = new Set<string>();
      for (const s of shifts) if (!publishedStaff.has(s.staffId)) unpubStaff.add(s.staffId);
      if (unpubStaff.size > 0) {
        pushTile(
          byTile, bySidebar, "staff", "/staff/schedule", "warn",
          `${unpubStaff.size} staff have unpublished shifts this week.`,
        );
      }
    })());
  }

  // ── Communications: scheduled messages due ───────────────────────────
  await safeRun("scheduled", (async () => {
    const { dueScheduled } = await import("./comms");
    const due = await dueScheduled();
    if (due.length > 0) {
      pushTile(
        byTile, bySidebar, "comms", "/communications/scheduled", "info",
        `${due.length} scheduled message${due.length === 1 ? " is" : "s are"} ready to send.`,
      );
    }
  })());

  // ── Vault: docs expired / expiring ───────────────────────────────────
  await safeRun("vault", (async () => {
    const { expiringSoon } = await import("../repo/documentsRepo");
    const soon = await expiringSoon(60);
    if (soon.length > 0) {
      const today = new Date().toISOString().slice(0, 10);
      const overdue = soon.filter((doc) => doc.expiryDate && doc.expiryDate < today).length;
      const upcoming = soon.length - overdue;
      if (overdue > 0) {
        pushTile(
          byTile, bySidebar, "vault", "/vault?expiring=60", "danger",
          `${overdue} vault document${overdue === 1 ? " has" : "s have"} expired.`,
        );
      }
      if (upcoming > 0) {
        pushTile(
          byTile, bySidebar, "vault", "/vault?expiring=60", "warn",
          `${upcoming} vault document${upcoming === 1 ? "" : "s"} expir${upcoming === 1 ? "es" : "e"} within 60 days.`,
        );
      }
    }
  })());

  // ── Organizer: items due today / this week ───────────────────────────
  await safeRun("organizer", (async () => {
    const { countDueToday, countDueThisWeek } = await import("../repo/organizerRepo");
    const [today, week] = await Promise.all([countDueToday(), countDueThisWeek()]);
    if (today > 0) {
      pushTile(
        byTile, bySidebar, "organizer", "/organizer", "danger",
        `${today} item${today === 1 ? " is" : "s are"} due today.`,
      );
    } else if (week > 0) {
      pushTile(
        byTile, bySidebar, "organizer", "/organizer", "info",
        `${week} item${week === 1 ? "" : "s"} due within 7 days.`,
      );
    }
  })());

  return {
    byTile,
    bySidebar,
    setup: {
      smtp: smtpMissing,
      backup: backupUnconfigured || backupStale,
      needsSetup: setupItems.length > 0,
      items: setupItems,
    },
    computedAt: new Date().toISOString(),
  };
}
