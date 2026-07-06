// notificationsRepo — v1.5.0 Notification Bell (Data Contract compliant).
// Soft delete only, optimistic concurrency, every mutation writes to
// notification_events. Dedup via unique index on dedup_key WHERE deleted_at
// IS NULL — upsert semantics: same key = update in place; escalation to a
// new tier produces a new key which naturally creates a new row.

import { db, execRetry } from "../lib/db";
import { uuidv4, nowIso } from "./ids";

export type Severity = "critical" | "warning" | "info";

export type NotificationCategory =
  | "staff_credential_expiring"
  | "staff_credential_expired"
  | "drill_overdue"
  | "document_expiring"
  | "document_expired"
  | "receipt_aging"
  | "schedule_not_published"
  | "schedule_change_ack_missing"
  | "meeting_action_due"
  | "followup_due"
  | "waitlist_offer_expiring"
  | "waitlist_new_application"
  | "agm_deadline"
  | "tslip_deadline"
  | "ccfri_claim_due"
  | "backup_stale"
  | "backup_failed"
  | "system_update_available"
  | "system_error";

export interface Notification {
  id: string;
  category: NotificationCategory;
  severity: Severity;
  title: string;
  body: string | null;
  source_kind: string | null;
  source_id: string | null;
  action_route: string | null;
  dedup_key: string;
  created_at: string;
  read_at: string | null;
  dismissed_at: string | null;
  snoozed_until: string | null;
  version: number;
  deleted_at: string | null;
}

export interface NotificationInput {
  category: NotificationCategory;
  severity: Severity;
  title: string;
  body?: string | null;
  source_kind?: string | null;
  source_id?: string | null;
  action_route?: string | null;
  dedup_key: string;
}

export interface NotificationSetting {
  category: string;
  enabled: number;
  desktop_enabled: number;
  min_severity: Severity;
  updated_at: string;
}

async function logEvent(
  entityId: string,
  eventType: string,
  payload?: unknown,
): Promise<void> {
  await execRetry(
    "INSERT INTO notification_events(id, entity_id, event_type, payload_json, created_at) VALUES(?,?,?,?,?)",
    [uuidv4(), entityId, eventType, payload === undefined ? null : JSON.stringify(payload), nowIso()],
  );
}

/** Insert or update by dedup_key. Returns the resulting row. */
export async function upsertByDedupKey(input: NotificationInput): Promise<Notification> {
  const d = await db();
  const existing = await d.select<Notification[]>(
    "SELECT * FROM notifications WHERE dedup_key = ? AND deleted_at IS NULL",
    [input.dedup_key],
  );
  if (existing.length > 0) {
    // Refresh title/body/severity in case source drifted (e.g. new expiry date).
    const row = existing[0];
    await execRetry(
      `UPDATE notifications
          SET title = ?, body = ?, severity = ?, action_route = ?,
              version = version + 1
        WHERE id = ? AND version = ?`,
      [input.title, input.body ?? null, input.severity, input.action_route ?? null, row.id, row.version],
    );
    return { ...row, title: input.title, body: input.body ?? null, severity: input.severity, action_route: input.action_route ?? null, version: row.version + 1 };
  }
  const id = uuidv4();
  const now = nowIso();
  await execRetry(
    `INSERT INTO notifications
      (id, category, severity, title, body, source_kind, source_id, action_route, dedup_key, created_at, version)
     VALUES (?,?,?,?,?,?,?,?,?,?,1)`,
    [
      id, input.category, input.severity, input.title, input.body ?? null,
      input.source_kind ?? null, input.source_id ?? null, input.action_route ?? null,
      input.dedup_key, now,
    ],
  );
  await logEvent(id, "created", { category: input.category, severity: input.severity });
  return {
    id, category: input.category, severity: input.severity, title: input.title, body: input.body ?? null,
    source_kind: input.source_kind ?? null, source_id: input.source_id ?? null, action_route: input.action_route ?? null,
    dedup_key: input.dedup_key, created_at: now, read_at: null, dismissed_at: null, snoozed_until: null,
    version: 1, deleted_at: null,
  };
}

export interface ListFilter {
  category?: string[];
  unreadOnly?: boolean;
  hideSnoozed?: boolean;
  hideDismissed?: boolean;
  sinceDays?: number;
  severity?: Severity[];
  limit?: number;
}

export async function listVisible(filter: ListFilter = {}): Promise<Notification[]> {
  const d = await db();
  const clauses: string[] = ["deleted_at IS NULL"];
  const args: any[] = [];
  if (filter.hideDismissed !== false) clauses.push("dismissed_at IS NULL");
  if (filter.hideSnoozed !== false) clauses.push("(snoozed_until IS NULL OR snoozed_until <= ?)"), args.push(nowIso());
  if (filter.unreadOnly) clauses.push("read_at IS NULL");
  if (filter.category && filter.category.length) {
    clauses.push(`category IN (${filter.category.map(() => "?").join(",")})`);
    args.push(...filter.category);
  }
  if (filter.severity && filter.severity.length) {
    clauses.push(`severity IN (${filter.severity.map(() => "?").join(",")})`);
    args.push(...filter.severity);
  }
  if (filter.sinceDays && filter.sinceDays > 0) {
    const cutoff = new Date(Date.now() - filter.sinceDays * 86400_000).toISOString();
    clauses.push("created_at >= ?");
    args.push(cutoff);
  }
  const limit = filter.limit ?? 200;
  return d.select<Notification[]>(
    `SELECT * FROM notifications WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
    [...args, limit],
  );
}

export async function countUnread(): Promise<{ total: number; critical: number }> {
  const d = await db();
  const rows = await d.select<{ severity: Severity; n: number }[]>(
    `SELECT severity, COUNT(*) AS n FROM notifications
      WHERE deleted_at IS NULL AND read_at IS NULL AND dismissed_at IS NULL
        AND (snoozed_until IS NULL OR snoozed_until <= ?)
      GROUP BY severity`,
    [nowIso()],
  );
  let total = 0, critical = 0;
  for (const r of rows) {
    total += r.n;
    if (r.severity === "critical") critical += r.n;
  }
  return { total, critical };
}

export async function markRead(id: string, expectedVersion: number): Promise<void> {
  const now = nowIso();
  const res = await execRetry(
    "UPDATE notifications SET read_at = ?, version = version + 1 WHERE id = ? AND version = ? AND read_at IS NULL",
    [now, id, expectedVersion],
  );
  if ((res as any).rowsAffected === 0) return; // idempotent: already read or version mismatch
  await logEvent(id, "read");
}

export async function markAllRead(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const now = nowIso();
  const placeholders = ids.map(() => "?").join(",");
  await execRetry(
    `UPDATE notifications SET read_at = ?, version = version + 1 WHERE id IN (${placeholders}) AND read_at IS NULL`,
    [now, ...ids],
  );
  for (const id of ids) await logEvent(id, "read");
}

export async function dismiss(id: string, expectedVersion: number): Promise<void> {
  const now = nowIso();
  const res = await execRetry(
    "UPDATE notifications SET dismissed_at = ?, version = version + 1 WHERE id = ? AND version = ? AND dismissed_at IS NULL",
    [now, id, expectedVersion],
  );
  if ((res as any).rowsAffected === 0) return;
  await logEvent(id, "dismissed");
}

export async function undoDismiss(id: string): Promise<void> {
  await execRetry(
    "UPDATE notifications SET dismissed_at = NULL, version = version + 1 WHERE id = ?",
    [id],
  );
  await logEvent(id, "undo_dismiss");
}

export async function snooze(id: string, until: string, expectedVersion: number): Promise<void> {
  const res = await execRetry(
    "UPDATE notifications SET snoozed_until = ?, version = version + 1 WHERE id = ? AND version = ?",
    [until, id, expectedVersion],
  );
  if ((res as any).rowsAffected === 0) return;
  await logEvent(id, "snoozed", { until });
}

/** Soft-delete any notifications whose dedup_key is NOT in the survivor set,
 *  within a category. Used by scanners to resolve fixed items. */
export async function softDeleteResolved(category: string, survivorDedupKeys: string[]): Promise<number> {
  const d = await db();
  const now = nowIso();
  const rows = await d.select<{ id: string; dedup_key: string }[]>(
    "SELECT id, dedup_key FROM notifications WHERE category = ? AND deleted_at IS NULL",
    [category],
  );
  const survivorSet = new Set(survivorDedupKeys);
  let count = 0;
  for (const r of rows) {
    if (!survivorSet.has(r.dedup_key)) {
      await execRetry(
        "UPDATE notifications SET deleted_at = ?, version = version + 1 WHERE id = ?",
        [now, r.id],
      );
      await logEvent(r.id, "resolved");
      count++;
    }
  }
  return count;
}

export async function purgeOldDismissed(olderThanDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86400_000).toISOString();
  const d = await db();
  const rows = await d.select<{ id: string }[]>(
    "SELECT id FROM notifications WHERE dismissed_at IS NOT NULL AND dismissed_at < ? AND deleted_at IS NULL",
    [cutoff],
  );
  const now = nowIso();
  for (const r of rows) {
    await execRetry("UPDATE notifications SET deleted_at = ? WHERE id = ?", [now, r.id]);
  }
  return rows.length;
}

export async function getSettings(): Promise<Map<string, NotificationSetting>> {
  const d = await db();
  const rows = await d.select<NotificationSetting[]>("SELECT * FROM notification_settings");
  const m = new Map<string, NotificationSetting>();
  for (const r of rows) m.set(r.category, r);
  return m;
}

export async function setEnabled(category: string, enabled: boolean): Promise<void> {
  const now = nowIso();
  await execRetry(
    `INSERT INTO notification_settings(category, enabled, updated_at) VALUES(?,?,?)
     ON CONFLICT(category) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    [category, enabled ? 1 : 0, now],
  );
}

export async function setMinSeverity(category: string, severity: Severity): Promise<void> {
  const now = nowIso();
  await execRetry(
    `INSERT INTO notification_settings(category, min_severity, updated_at) VALUES(?,?,?)
     ON CONFLICT(category) DO UPDATE SET min_severity = excluded.min_severity, updated_at = excluded.updated_at`,
    [category, severity, now],
  );
}

const SEV_ORDER: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };
export function severityGte(actual: Severity, min: Severity): boolean {
  return SEV_ORDER[actual] >= SEV_ORDER[min];
}
