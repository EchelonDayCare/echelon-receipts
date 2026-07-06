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
const isoDate = (d: Date) => d.toISOString().slice(0,10);

function daysBetween(fromIso: string | null | undefined, to = startOfDay()): number | null {
  if (!fromIso) return null;
  const then = startOfDay(new Date(fromIso));
  if (isNaN(then.getTime())) return null;
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

/** Advance an MM-DD (e.g. "02-28") to the next calendar occurrence >= today.
 *  Returns null if the input is not a valid MM-DD. */
function nextMmDdOccurrence(mmdd: string): string | null {
  const m = /^(\d{2})-(\d{2})$/.exec((mmdd || "").trim());
  if (!m) return null;
  const mm = Number(m[1]); const dd = Number(m[2]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const today = startOfDay();
  let year = today.getFullYear();
  let candidate = new Date(year, mm - 1, dd);
  if (candidate < today) candidate = new Date(year + 1, mm - 1, dd);
  return isoDate(candidate);
}
/** Next monthly occurrence of a day-of-month (1-28), >= today. */
function nextDayOfMonthOccurrence(day: number): string | null {
  if (!(day >= 1 && day <= 28)) return null;
  const today = startOfDay();
  let cand = new Date(today.getFullYear(), today.getMonth(), day);
  if (cand < today) cand = new Date(today.getFullYear(), today.getMonth() + 1, day);
  return isoDate(cand);
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
      dedup_key: `${category}:staff_credential:${r.id}:${t}`,
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
      action_route: "/staff-credentials",
      dedup_key: `drill_overdue:drill_type:${type}:${t}`,
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
      dedup_key: `${category}:document:${r.id}:${t}`,
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
    const then = startOfDay(new Date(r.date));
    if (isNaN(then.getTime())) continue;
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
      action_route: "/receipts",
      dedup_key: `receipt_aging:receipt:${r.id}:${bucket}`,
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
  const out: NotificationInput[] = [];
  for (const st of staff) {
    const shifts = await d.select<{ n: number }[]>(
      `SELECT COUNT(*) AS n FROM staff_shifts
        WHERE deleted_at IS NULL AND staff_id = ?
          AND shift_date >= ? AND shift_date < date(?, '+7 days')`,
      [String(st.id), nextMonday, nextMonday],
    );
    if (!shifts[0]?.n) continue;
    const pub = await d.select<{ n: number }[]>(
      `SELECT COUNT(*) AS n FROM staff_weekly_publish
        WHERE deleted_at IS NULL AND staff_id = ? AND week_start_date = ?`,
      [String(st.id), nextMonday],
    );
    if (pub[0]?.n) continue;
    const daysUntil = daysBetween(nextMonday);
    if (daysUntil == null || daysUntil > 3) continue;
    const t = daysUntil <= 0 ? "0d" : (daysUntil <= 3 ? "3d" : "7d");
    out.push({
      category: "schedule_not_published",
      severity: daysUntil <= 0 ? "critical" : "warning",
      title: `Publish schedule for ${st.name}`,
      body: `Week of ${nextMonday} — ${shifts[0].n} shift(s) unpublished`,
      source_kind: "staff_weekly",
      source_id: `${st.id}:${nextMonday}`,
      action_route: "/staff-schedule",
      dedup_key: `schedule_not_published:staff_weekly:${st.id}:${nextMonday}:${t}`,
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
      action_route: "/staff-schedule",
      dedup_key: `schedule_change_ack_missing:staff_weekly:${r.id}:${tier}`,
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
      dedup_key: `meeting_action_due:meeting_action:${r.id}:${t}`,
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
      dedup_key: `followup_due:followup:${r.id}:${t}`,
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
      dedup_key: `waitlist_offer_expiring:waitlist_entry:${r.id}:${tier}`,
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
    action_route: "/agm-package",
    dedup_key: `agm_deadline:agm:${iso}:${t}`,
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
    action_route: "/annual-tax",
    dedup_key: `tslip_deadline:tslip:${iso}:${t}`,
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
    action_route: "/subsidy-statement",
    dedup_key: `ccfri_claim_due:ccfri:${iso}:${t}`,
  }];
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

// ─── Scanner: system update (stub — updater not wired) ────────────────
export async function scanSystemUpdate(): Promise<NotificationInput[]> {
  // TODO: wire to Tauri updater when the update pipeline is set up.
  return [];
}

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
  { id: "backupStale",       category: "backup_stale",               label: "Cloud backup stale",        run: scanBackup },
  { id: "backupFailed",      category: "backup_failed",              label: "Cloud backup failed",       run: noop },
  { id: "systemUpdate",      category: "system_update_available",    label: "App update available",      run: scanSystemUpdate },
];
