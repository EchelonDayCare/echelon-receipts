// v1.5.0 Notification Bell — scanner registry.
// Each scanner returns the full set of currently-relevant notification
// INPUTS. The scheduler upserts them (dedup key ensures no duplicates) and
// soft-deletes anything that used to be surfaced for the same category but
// isn't returned this run (that's how "resolved" items disappear from the
// bell without leaving orphaned rows).
//
// Kept as one file (rather than 15 tiny files) because each scanner is a
// short SQL query; splitting would balloon the diff without improving
// readability. Every scanner is independently testable via `scanAll()` or
// by calling the exported function directly.

import { db, getSettings } from "../db";
import type { NotificationInput, NotificationCategory, Severity } from "../../repo/notificationsRepo";

// ─── Helpers ──────────────────────────────────────────────────────────
const DAY_MS = 86400_000;
const startOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
// Local-timezone ISO date formatter. Never use toISOString().slice(0,10) —
// that converts to UTC and can flip the day for anyone west of GMT.
const isoDate = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
};
// Parse "YYYY-MM-DD" as LOCAL midnight, not UTC. `new Date("2026-01-20")`
// is spec-defined as UTC midnight, which becomes Jan-19 evening in the
// Americas — that off-by-one silently shifted every due-date scanner.
function parseIsoLocal(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]) - 1, da = Number(m[3]);
    const d = new Date(y, mo, da);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : startOfDay(d);
}

function daysBetween(fromIso: string | null | undefined, to = startOfDay()): number | null {
  if (!fromIso) return null;
  const then = parseIsoLocal(fromIso);
  if (!then) return null;
  return Math.round((then.getTime() - to.getTime()) / DAY_MS);
}

type Tier = "60d" | "30d" | "14d" | "7d" | "3d" | "0d" | "overdue";
/** null = don't notify at this distance yet. */
function tierFor(daysUntil: number): Tier | null {
  if (daysUntil < 0) return "overdue";
  if (daysUntil === 0) return "0d";
  if (daysUntil <= 3) return "3d";
  if (daysUntil <= 7) return "7d";
  if (daysUntil <= 14) return "14d";
  if (daysUntil <= 30) return "30d";
  if (daysUntil <= 60) return "60d";
  return null;
}
function tierSeverity(t: Tier): Severity {
  if (t === "overdue" || t === "0d" || t === "3d") return "critical";
  if (t === "7d" || t === "14d") return "warning";
  return "info";
}
function tierLabel(t: Tier, dueIso: string, noun = "due"): string {
  if (t === "overdue") { const d = -1 * (daysBetween(dueIso) ?? 0); return `Overdue by ${d}d`; }
  if (t === "0d") return `${noun} today`;
  const d = daysBetween(dueIso) ?? 0;
  return `${noun} in ${d}d`;
}

/** Build a Date only if the (year, mm, dd) triple is a real calendar date.
 *  Guards against JS Date auto-rollover (Feb 29 non-leap → Mar 1, Apr 31 → May 1). */
function makeValidDate(y: number, mm: number, dd: number): Date | null {
  const d = new Date(y, mm - 1, dd);
  if (d.getFullYear() !== y || d.getMonth() !== mm - 1 || d.getDate() !== dd) return null;
  return d;
}

/** Advance an MM-DD (e.g. "02-28") to the next calendar occurrence >= today.
 *  Returns null if the input is not a valid MM-DD.
 *  Feb 29 in non-leap years advances to the next leap year (up to 4 tries). */
function nextMmDdOccurrence(mmdd: string): string | null {
  const m = /^(\d{2})-(\d{2})$/.exec((mmdd || "").trim());
  if (!m) return null;
  const mm = Number(m[1]); const dd = Number(m[2]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const today = startOfDay();
  const startYear = today.getFullYear();
  for (let offset = 0; offset < 5; offset++) {
    const candidate = makeValidDate(startYear + offset, mm, dd);
    if (candidate && candidate >= today) return isoDate(candidate);
  }
  return null;
}
/** Next monthly occurrence of a day-of-month (1-28), >= today. */
function nextDayOfMonthOccurrence(day: number): string | null {
  if (!(day >= 1 && day <= 28)) return null;
  const today = startOfDay();
  let cand = new Date(today.getFullYear(), today.getMonth(), day);
  if (cand < today) cand = new Date(today.getFullYear(), today.getMonth() + 1, day);
  return isoDate(cand);
}

/** All upcoming MM-DD occurrences within the given horizon (in days).
 *  Used by multi-date scanners so every configured date within window fires,
 *  not just the earliest. */
function upcomingMmDdOccurrences(mmdds: string[], horizonDays: number, overdueDays = 14): string[] {
  const today = startOfDay();
  const isos = new Set<string>();
  for (const raw of mmdds) {
    const iso = nextMmDdOccurrence(raw);
    if (!iso) continue;
    const days = daysBetween(iso) ?? Infinity;
    if (days <= horizonDays) isos.add(iso);
    // Also consider the previous year's occurrence if it's still within the
    // overdue window (e.g. WCB Jan 20 that she missed — still surface until
    // she acts). We reconstruct by subtracting a year from the "next".
    const parsed = parseIsoLocal(iso);
    if (parsed) {
      const prev = makeValidDate(parsed.getFullYear() - 1, parsed.getMonth() + 1, parsed.getDate());
      if (prev) {
        const prevDays = Math.round((prev.getTime() - today.getTime()) / DAY_MS);
        if (prevDays < 0 && prevDays >= -overdueDays) isos.add(isoDate(prev));
      }
    }
  }
  return Array.from(isos).sort();
}

// ─── Scanner: staff credentials ───────────────────────────────────────
export async function scanStaffCredentials(): Promise<NotificationInput[]> {
  const s = await getSettings();
  const alertDays = Number(s.staff_cred_alert_days || "60");
  const d = await db();
  const rows = await d.select<{ id: number; type: string; expiry_date: string; staff_id: number; staff_name: string }[]>(
    `SELECT c.id, c.type, c.expiry_date, c.staff_id, st.name AS staff_name
       FROM staff_credentials c
       JOIN staff st ON st.id = c.staff_id
      WHERE c.expiry_date IS NOT NULL AND st.active = 1`,
  );
  const out: NotificationInput[] = [];
  for (const r of rows) {
    const days = daysBetween(r.expiry_date);
    if (days == null) continue;
    const t = tierFor(days);
    if (!t) continue;
    if (days >= 0 && days > alertDays) continue;
    const category: NotificationCategory = days < 0 ? "staff_credential_expired" : "staff_credential_expiring";
    out.push({
      category,
      severity: tierSeverity(t),
      title: `${r.staff_name} — ${r.type}`,
      body: `${tierLabel(t, r.expiry_date, "Expires")} (${r.expiry_date})`,
      source_kind: "staff_credential",
      source_id: String(r.id),
      action_route: "/staff",
      dedup_key: `${category}:staff_credential:${r.id}`,
    });
  }
  return out;
}

// ─── Scanner: staff drills ────────────────────────────────────────────
export async function scanStaffDrills(): Promise<NotificationInput[]> {
  const s = await getSettings();
  const cadence: Record<string, number> = {
    fire: Number(s.drill_cadence_fire_days || "30"),
    earthquake: Number(s.drill_cadence_earthquake_days || "90"),
    lockdown: Number(s.drill_cadence_lockdown_days || "90"),
    evacuation: Number(s.drill_cadence_evacuation_days || "180"),
  };
  const d = await db();
  const rows = await d.select<{ drill_type: string; last_date: string }[]>(
    `SELECT drill_type, MAX(drill_date) AS last_date FROM staff_drills GROUP BY drill_type`,
  );
  const out: NotificationInput[] = [];
  for (const [type, days] of Object.entries(cadence)) {
    const row = rows.find(r => (r.drill_type || "").toLowerCase() === type);
    const nextDueIso = row?.last_date
      ? isoDate(new Date(new Date(row.last_date).getTime() + days * DAY_MS))
      : isoDate(startOfDay()); // never done → due today
    const daysUntil = daysBetween(nextDueIso);
    if (daysUntil == null) continue;
    const t = tierFor(daysUntil);
    if (!t) continue;
    out.push({
      category: "drill_overdue",
      severity: tierSeverity(t),
      title: `${type.charAt(0).toUpperCase() + type.slice(1)} drill ${daysUntil < 0 ? "overdue" : "due"}`,
      body: row?.last_date
        ? `Last: ${row.last_date} · ${tierLabel(t, nextDueIso, "Next")}`
        : `Never logged — cadence ${days}d`,
      source_kind: "drill_type",
      source_id: type,
      action_route: "/staff/credentials",
      dedup_key: `drill_overdue:drill_type:${type}`,
    });
  }
  return out;
}

// ─── Scanner: vault documents ─────────────────────────────────────────
export async function scanVaultDocuments(): Promise<NotificationInput[]> {
  const d = await db();
  const rows = await d.select<{ id: string; title: string; category: string; expiry_date: string }[]>(
    `SELECT id, title, category, expiry_date FROM documents
      WHERE deleted_at IS NULL AND is_current = 1 AND expiry_date IS NOT NULL`,
  );
  const out: NotificationInput[] = [];
  for (const r of rows) {
    const days = daysBetween(r.expiry_date);
    if (days == null) continue;
    const t = tierFor(days);
    if (!t) continue;
    const category: NotificationCategory = days < 0 ? "document_expired" : "document_expiring";
    out.push({
      category,
      severity: tierSeverity(t),
      title: r.title,
      body: `${r.category} · ${tierLabel(t, r.expiry_date, "Expires")}`,
      source_kind: "document",
      source_id: r.id,
      action_route: "/vault",
      dedup_key: `${category}:document:${r.id}`,
    });
  }
  return out;
}

// ─── Scanner: receipts aging (pending balances) ───────────────────────
export async function scanReceiptsAging(): Promise<NotificationInput[]> {
  const d = await db();
  const rows = await d.select<{ id: number; receipt_no: number; date: string; pending_amount: number; student_name_snapshot: string }[]>(
    `SELECT id, receipt_no, date, pending_amount, student_name_snapshot
       FROM receipts WHERE voided = 0 AND pending_amount > 0.005`,
  );
  const today = startOfDay();
  const out: NotificationInput[] = [];
  for (const r of rows) {
    const then = parseIsoLocal(r.date);
    if (!then) continue;
    const ageDays = Math.round((today.getTime() - then.getTime()) / DAY_MS);
    // Buckets: 30d / 60d / 90d (spec §aging)
    let bucket: string | null = null;
    let sev: Severity = "info";
    if (ageDays >= 90) { bucket = "90d"; sev = "critical"; }
    else if (ageDays >= 60) { bucket = "60d"; sev = "warning"; }
    else if (ageDays >= 30) { bucket = "30d"; sev = "info"; }
    if (!bucket) continue;
    out.push({
      category: "receipt_aging",
      severity: sev,
      title: `#${r.receipt_no} — ${r.student_name_snapshot}`,
      body: `$${r.pending_amount.toFixed(2)} pending · ${ageDays}d old`,
      source_kind: "receipt",
      source_id: String(r.id),
      action_route: "/students/history",
      // Dedup on receipt only — as the aging bucket escalates (30d → 60d → 90d)
      // upsertByDedupKey refreshes title/body/severity in place instead of
      // stacking three separate notifications for the same overdue receipt.
      dedup_key: `receipt_aging:receipt:${r.id}`,
    });
  }
  return out;
}

// ─── Scanner: schedule not published for next Monday ──────────────────
export async function scanSchedulePublish(): Promise<NotificationInput[]> {
  const d = await db();
  // Next Monday ISO date.
  const today = startOfDay();
  const dow = today.getDay(); // 0=Sun ... 6=Sat
  const daysToMon = ((8 - dow) % 7) || 7; // always the *next* Monday, at least 1 day away
  const nextMonday = isoDate(new Date(today.getTime() + daysToMon * DAY_MS));
  const staff = await d.select<{ id: number; name: string }[]>(
    "SELECT id, name FROM staff WHERE active = 1",
  );
  const daysUntil = daysBetween(nextMonday);
  if (daysUntil == null || daysUntil > 3 || staff.length === 0) return [];

  // M-13: this used to run 2 SELECT COUNT(*) queries per active staff member
  // (a classic N+1). Replaced with two bulk queries — one shift-count
  // GROUP BY, one set of already-published staff — so the whole scan is a
  // fixed 3 queries regardless of headcount.
  const shiftCounts = await d.select<{ staff_id: string; n: number }[]>(
    `SELECT staff_id, COUNT(*) AS n FROM staff_shifts
      WHERE deleted_at IS NULL AND shift_date >= ? AND shift_date < date(?, '+7 days')
      GROUP BY staff_id`,
    [nextMonday, nextMonday],
  );
  const shiftCountByStaff = new Map(shiftCounts.map((r) => [r.staff_id, r.n]));
  const published = await d.select<{ staff_id: string }[]>(
    `SELECT staff_id FROM staff_weekly_publish WHERE deleted_at IS NULL AND week_start_date = ?`,
    [nextMonday],
  );
  const publishedStaffIds = new Set(published.map((r) => r.staff_id));

  const out: NotificationInput[] = [];
  for (const st of staff) {
    const shiftCount = shiftCountByStaff.get(String(st.id)) ?? 0;
    if (!shiftCount) continue;
    if (publishedStaffIds.has(String(st.id))) continue;
    out.push({
      category: "schedule_not_published",
      severity: daysUntil <= 0 ? "critical" : "warning",
      title: `Publish schedule for ${st.name}`,
      body: `Week of ${nextMonday} — ${shiftCount} shift(s) unpublished`,
      source_kind: "staff_weekly",
      source_id: `${st.id}:${nextMonday}`,
      action_route: "/staff/schedule",
      dedup_key: `schedule_not_published:staff_weekly:${st.id}:${nextMonday}`,
    });
  }
  return out;
}

// ─── Scanner: schedule change ack missing ─────────────────────────────
export async function scanScheduleConfirmations(): Promise<NotificationInput[]> {
  const d = await db();
  const cutoff = new Date(Date.now() - 4 * 3600_000).toISOString();
  const rows = await d.select<{ id: string; staff_id: string; week_start_date: string; published_at: string }[]>(
    `SELECT p.id, p.staff_id, p.week_start_date, p.published_at
       FROM staff_weekly_publish p
      WHERE p.deleted_at IS NULL AND p.acknowledged_at IS NULL
        AND p.published_at < ?`,
    [cutoff],
  );
  const out: NotificationInput[] = [];
  for (const r of rows) {
    const ageHrs = Math.round((Date.now() - new Date(r.published_at).getTime()) / 3600_000);
    const tier = ageHrs >= 48 ? "48h" : ageHrs >= 24 ? "24h" : "4h";
    const sev: Severity = tier === "48h" ? "critical" : tier === "24h" ? "warning" : "info";
    out.push({
      category: "schedule_change_ack_missing",
      severity: sev,
      title: `Awaiting confirmation`,
      body: `Week of ${r.week_start_date} · published ${ageHrs}h ago`,
      source_kind: "staff_weekly",
      source_id: r.id,
      action_route: "/staff/schedule",
      dedup_key: `schedule_change_ack_missing:staff_weekly:${r.id}`,
    });
  }
  return out;
}

// ─── Scanner: meeting actions due ─────────────────────────────────────
export async function scanMeetingActions(): Promise<NotificationInput[]> {
  const d = await db();
  const rows = await d.select<{ id: string; description: string; due_date: string; owner_text: string | null; meeting_id: string }[]>(
    `SELECT id, description, due_date, owner_text, meeting_id
       FROM meeting_actions
      WHERE deleted_at IS NULL AND done_at IS NULL AND due_date IS NOT NULL`,
  );
  const out: NotificationInput[] = [];
  for (const r of rows) {
    const days = daysBetween(r.due_date);
    if (days == null) continue;
    const t = tierFor(days);
    if (!t) continue;
    out.push({
      category: "meeting_action_due",
      severity: tierSeverity(t),
      title: r.description.slice(0, 80),
      body: `${r.owner_text ? r.owner_text + " · " : ""}${tierLabel(t, r.due_date)}`,
      source_kind: "meeting_action",
      source_id: r.id,
      action_route: "/organizer",
      dedup_key: `meeting_action_due:meeting_action:${r.id}`,
    });
  }
  return out;
}

// ─── Scanner: follow-ups due ──────────────────────────────────────────
export async function scanFollowups(): Promise<NotificationInput[]> {
  const d = await db();
  const rows = await d.select<{ id: string; title: string; due_date: string; priority: string }[]>(
    `SELECT id, title, due_date, priority
       FROM followups
      WHERE deleted_at IS NULL AND done_at IS NULL AND due_date IS NOT NULL`,
  );
  const out: NotificationInput[] = [];
  for (const r of rows) {
    const days = daysBetween(r.due_date);
    if (days == null) continue;
    const t = tierFor(days);
    if (!t) continue;
    let sev = tierSeverity(t);
    if (r.priority === "high" && sev === "info") sev = "warning";
    out.push({
      category: "followup_due",
      severity: sev,
      title: r.title,
      body: `${r.priority.toUpperCase()} · ${tierLabel(t, r.due_date)}`,
      source_kind: "followup",
      source_id: r.id,
      action_route: "/organizer",
      dedup_key: `followup_due:followup:${r.id}`,
    });
  }
  return out;
}

// ─── Scanner: waitlist offer expiring ─────────────────────────────────
export async function scanWaitlistOffers(): Promise<NotificationInput[]> {
  const d = await db();
  const rows = await d.select<{ id: number; child_name: string; status_changed_at: string }[]>(
    `SELECT id, child_name, status_changed_at
       FROM waitlist_entries
      WHERE status = 'offered' AND status_changed_at IS NOT NULL`,
  );
  const out: NotificationInput[] = [];
  for (const r of rows) {
    const daysDiff = daysBetween(r.status_changed_at);
    if (daysDiff == null) continue;
    const daysSince = -daysDiff; // status_changed_at is in the past → daysBetween is negative
    if (daysSince < 5) continue;
    const tier = daysSince >= 10 ? "10d" : daysSince >= 7 ? "7d" : "5d";
    const sev: Severity = tier === "10d" ? "critical" : tier === "7d" ? "warning" : "info";
    out.push({
      category: "waitlist_offer_expiring",
      severity: sev,
      title: `Offer pending — ${r.child_name}`,
      body: `Offered ${daysSince}d ago, no response`,
      source_kind: "waitlist_entry",
      source_id: String(r.id),
      action_route: "/waitlist",
      dedup_key: `waitlist_offer_expiring:waitlist_entry:${r.id}`,
    });
  }
  return out;
}

// ─── Scanner: new waitlist applications (last 7 days) ─────────────────
export async function scanWaitlistApplications(): Promise<NotificationInput[]> {
  const d = await db();
  const cutoff = new Date(Date.now() - 7 * DAY_MS).toISOString();
  const rows = await d.select<{ id: number; child_name: string; parent_name: string; submitted_at: string }[]>(
    `SELECT id, child_name, parent_name, submitted_at
       FROM waitlist_entries
      WHERE status = 'new' AND (submitted_at >= ? OR created_at >= ?)
      ORDER BY submitted_at DESC LIMIT 50`,
    [cutoff, cutoff],
  );
  return rows.map(r => ({
    category: "waitlist_new_application" as const,
    severity: "info" as const,
    title: `New waitlist entry — ${r.child_name}`,
    body: r.parent_name ? `From ${r.parent_name}` : null,
    source_kind: "waitlist_entry",
    source_id: String(r.id),
    action_route: "/waitlist",
    dedup_key: `waitlist_new_application:waitlist_entry:${r.id}:new`,
  }));
}

// ─── Scanner: AGM annual deadline (MM-DD setting) ─────────────────────
export async function scanAgmDeadline(): Promise<NotificationInput[]> {
  const s = await getSettings();
  const iso = nextMmDdOccurrence(s.notif_agm_reminder_mmdd || "");
  if (!iso) return [];
  const days = daysBetween(iso);
  if (days == null) return [];
  const t = tierFor(days);
  if (!t) return [];
  return [{
    category: "agm_deadline",
    severity: tierSeverity(t),
    title: "AGM date approaching",
    body: `${tierLabel(t, iso)} (${iso})`,
    source_kind: "agm",
    source_id: iso,
    action_route: "/reports/agm",
    // Dedup on the target date only — as tier escalates (7d → 3d → 0d →
    // overdue) upsertByDedupKey refreshes title/body/severity in place
    // instead of creating a new notification each tier.
    dedup_key: `agm_deadline:agm:${iso}`,
  }];
}

// ─── Scanner: T-slip filing deadline (default Feb 28) ─────────────────
export async function scanTslipDeadline(): Promise<NotificationInput[]> {
  const s = await getSettings();
  const iso = nextMmDdOccurrence(s.notif_tslip_reminder_mmdd || "02-28");
  if (!iso) return [];
  const days = daysBetween(iso);
  if (days == null) return [];
  const t = tierFor(days);
  if (!t) return [];
  return [{
    category: "tslip_deadline",
    severity: tierSeverity(t),
    title: "T-slip deadline",
    body: `${tierLabel(t, iso)} (${iso})`,
    source_kind: "tslip",
    source_id: iso,
    action_route: "/students/annual",
    dedup_key: `tslip_deadline:tslip:${iso}`,
  }];
}

// ─── Scanner: monthly CCFRI claim day ─────────────────────────────────
export async function scanCcfriClaim(): Promise<NotificationInput[]> {
  const s = await getSettings();
  const dom = Number(s.notif_ccfri_claim_day_of_month || "15");
  const iso = nextDayOfMonthOccurrence(dom);
  if (!iso) return [];
  const days = daysBetween(iso);
  if (days == null) return [];
  if (days > 7) return []; // monthly — only 1 week ahead
  const t = tierFor(days) ?? "7d";
  return [{
    category: "ccfri_claim_due",
    severity: tierSeverity(t),
    title: "CCFRI claim due",
    body: `${tierLabel(t, iso)} (${iso})`,
    source_kind: "ccfri",
    source_id: iso,
    action_route: "/reports/subsidy",
    dedup_key: `ccfri_claim_due:ccfri:${iso}`,
  }];
}

// ─── Scanner: WCB quarterly (Apr 20 / Jul 20 / Oct 20 / Jan 20) ───────
// User setting `notif_wcb_days` (default "04-20,07-20,10-20,01-20").
// Surfaces each configured date from 7 days out through 14 days overdue,
// so a missed WCB filing stays visible until she acts on it.
export async function scanWcbQuarterly(): Promise<NotificationInput[]> {
  const s = await getSettings();
  const raw = (s.notif_wcb_days || "04-20,07-20,10-20,01-20").trim();
  const parts = raw.split(",").map(x => x.trim()).filter(Boolean);
  const isos = upcomingMmDdOccurrences(parts, 7, 14);
  const out: NotificationInput[] = [];
  for (const iso of isos) {
    const days = daysBetween(iso);
    if (days == null) continue;
    const t = tierFor(days);
    if (!t) continue;
    out.push({
      category: "wcb_quarterly_due",
      severity: tierSeverity(t),
      title: "WCB quarterly return due",
      body: `${tierLabel(t, iso)} (${iso})`,
      source_kind: "wcb",
      source_id: iso,
      action_route: "/reports/agm",
      dedup_key: `wcb_quarterly_due:wcb:${iso}`,
    });
  }
  return out;
}

// ─── Scanner: staff meeting quarterly (default end of Aug/Nov/Feb/May) ─
// Reminder surfaces from 7 days before through 14 days overdue.
export async function scanStaffMeetingQuarterly(): Promise<NotificationInput[]> {
  const s = await getSettings();
  const raw = (s.notif_staff_meeting_days || "08-31,11-30,02-28,05-31").trim();
  const parts = raw.split(",").map(x => x.trim()).filter(Boolean);
  const isos = upcomingMmDdOccurrences(parts, 7, 14);
  const out: NotificationInput[] = [];
  for (const iso of isos) {
    const days = daysBetween(iso);
    if (days == null) continue;
    const t = tierFor(days);
    if (!t) continue;
    out.push({
      category: "staff_meeting_quarterly",
      severity: tierSeverity(t),
      title: "Staff meeting approaching",
      body: `${tierLabel(t, iso)} (${iso})`,
      source_kind: "staff_meeting",
      source_id: iso,
      action_route: "/organizer",
      dedup_key: `staff_meeting_quarterly:staff_meeting:${iso}`,
    });
  }
  return out;
}

// ─── Scanner: monthly payroll remittance (default day-of-month 12) ────
// Surfaces from 7 days before through 14 days overdue.
export async function scanRemittanceMonthly(): Promise<NotificationInput[]> {
  const s = await getSettings();
  const dom = Number(s.notif_remittance_day_of_month || "12");
  const nextIso = nextDayOfMonthOccurrence(dom);
  if (!nextIso) return [];
  // Also consider last month's occurrence if it's within the overdue window.
  const candidates: string[] = [];
  const nextParsed = parseIsoLocal(nextIso);
  if (nextParsed) {
    const prev = new Date(nextParsed.getFullYear(), nextParsed.getMonth() - 1, nextParsed.getDate());
    const prevDays = daysBetween(isoDate(prev));
    if (prevDays != null && prevDays < 0 && prevDays >= -14) candidates.push(isoDate(prev));
  }
  candidates.push(nextIso);
  const out: NotificationInput[] = [];
  for (const iso of candidates) {
    const days = daysBetween(iso);
    if (days == null) continue;
    if (days > 7) continue;
    const t = tierFor(days);
    if (!t) continue;
    out.push({
      category: "remittance_monthly_due",
      severity: tierSeverity(t),
      title: "Payroll remittance due",
      body: `${tierLabel(t, iso)} (${iso})`,
      source_kind: "remittance",
      source_id: iso,
      action_route: "/reports/agm",
      dedup_key: `remittance_monthly_due:remittance:${iso}`,
    });
  }
  return out;
}

// ─── Scanner: backup stale / failed ───────────────────────────────────
export async function scanBackup(): Promise<NotificationInput[]> {
  const s = await getSettings();
  const out: NotificationInput[] = [];
  const lastErr = (s.last_backup_error || "").trim();
  if (lastErr) {
    out.push({
      category: "backup_failed",
      severity: "critical",
      title: "Cloud backup failed",
      body: lastErr.slice(0, 200),
      source_kind: "backup",
      source_id: "last",
      action_route: "/settings",
      dedup_key: `backup_failed:backup:last:current`,
    });
  }
  const lastAt = (s.last_cloud_backup_at || "").trim();
  if (lastAt) {
    const ageDays = Math.round((Date.now() - new Date(lastAt).getTime()) / DAY_MS);
    let bucket: string | null = null;
    let sev: Severity = "info";
    if (ageDays >= 60) { bucket = "60d"; sev = "critical"; }
    else if (ageDays >= 45) { bucket = "45d"; sev = "warning"; }
    else if (ageDays >= 35) { bucket = "35d"; sev = "info"; }
    if (bucket) {
      out.push({
        category: "backup_stale",
        severity: sev,
        title: "Cloud backup is stale",
        body: `Last backup ${ageDays}d ago (${lastAt.slice(0,10)})`,
        source_kind: "backup",
        source_id: "last",
        action_route: "/settings",
        dedup_key: `backup_stale:backup:last:${bucket}`,
      });
    }
  }
  return out;
}

// M-12: scanSystemUpdate was a permanent stub (never wired to a real
// updater) that always returned []. Rather than ship a Settings toggle that
// visibly does nothing, the scanner and its registry entry are removed.
// Wiring `@tauri-apps/plugin-updater` is tracked as a follow-up — see the
// "system update" notification category kept in NotificationCategory for
// forward-compatibility, just with no scanner currently producing it.

// ─── Registry ─────────────────────────────────────────────────────────
// Note: some scanners cover multiple categories (e.g. scanStaffCredentials
// emits both expiring and expired). We list one entry per user-visible
// category so the Settings UI can enumerate all 19 knobs, but avoid
// running the underlying query twice by pointing the "shadow" entries at
// a no-op runner.
export interface ScannerDef {
  id: string;
  category: NotificationCategory;
  label: string;
  run: () => Promise<NotificationInput[]>;
}
const noop = async () => [] as NotificationInput[];
export const SCANNERS: ScannerDef[] = [
  { id: "staffCredExpiring", category: "staff_credential_expiring",  label: "Staff credential expiring", run: scanStaffCredentials },
  { id: "staffCredExpired",  category: "staff_credential_expired",   label: "Staff credential expired",  run: noop },
  { id: "drillOverdue",      category: "drill_overdue",              label: "Emergency drill overdue",   run: scanStaffDrills },
  { id: "docExpiring",       category: "document_expiring",          label: "Vault document expiring",   run: scanVaultDocuments },
  { id: "docExpired",        category: "document_expired",           label: "Vault document expired",    run: noop },
  { id: "receiptAging",      category: "receipt_aging",              label: "Receipt with pending balance aging", run: scanReceiptsAging },
  { id: "schedulePublish",   category: "schedule_not_published",     label: "Schedule not yet published", run: scanSchedulePublish },
  { id: "scheduleAck",       category: "schedule_change_ack_missing",label: "Schedule confirmation missing", run: scanScheduleConfirmations },
  { id: "meetingAction",     category: "meeting_action_due",         label: "Meeting action item due",   run: scanMeetingActions },
  { id: "followup",          category: "followup_due",               label: "Follow-up due",             run: scanFollowups },
  { id: "waitlistOffer",     category: "waitlist_offer_expiring",    label: "Waitlist offer aging",      run: scanWaitlistOffers },
  { id: "waitlistNew",       category: "waitlist_new_application",   label: "New waitlist application",  run: scanWaitlistApplications },
  { id: "agm",               category: "agm_deadline",               label: "AGM date reminder",         run: scanAgmDeadline },
  { id: "tslip",             category: "tslip_deadline",             label: "T-slip deadline",           run: scanTslipDeadline },
  { id: "ccfri",             category: "ccfri_claim_due",            label: "CCFRI monthly claim",       run: scanCcfriClaim },
  { id: "wcb",               category: "wcb_quarterly_due",          label: "WCB quarterly return",      run: scanWcbQuarterly },
  { id: "staffMeeting",      category: "staff_meeting_quarterly",    label: "Staff meeting (quarterly)", run: scanStaffMeetingQuarterly },
  { id: "remittance",        category: "remittance_monthly_due",     label: "Payroll remittance (monthly)", run: scanRemittanceMonthly },
  { id: "backupStale",       category: "backup_stale",               label: "Cloud backup stale",        run: scanBackup },
  { id: "backupFailed",      category: "backup_failed",              label: "Cloud backup failed",       run: noop },
];
