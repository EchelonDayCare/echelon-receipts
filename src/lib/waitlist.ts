// Waitlist sync + local model (v0.8.0).
//
// Pipeline:
//   1. Rust `waitlist_fetch_rows` returns the parsed Sheet rows.
//   2. This module computes dedupe_key / sheet_row_hash / derived fields.
//   3. Upserts into waitlist_entries preserving local-only fields
//      (status, status_note, status_changed_at, converted_student_id).
//   4. Rows not seen in the last successful fetch are soft-archived UNLESS
//      the user has already moved them to a terminal status.
//
// Safety:
//   • Never invokes any write endpoint on Sheets (the Rust side only exposes
//     read commands).
//   • Rate limits itself: minimum 30 sec between syncs, module-scoped.
//   • Google Sheet ID default is preserved via db.ts setting.

import { invoke } from "@tauri-apps/api/core";
import { db, execRetry } from "./db";
import { logError } from "./errorLog";

export type WaitlistStatus =
  | "new" | "contacted" | "offered" | "enrolled" | "withdrawn" | "archived";

export const WAITLIST_STATUSES: WaitlistStatus[] = [
  "new", "contacted", "offered", "enrolled", "withdrawn", "archived",
];

export interface WaitlistEntry {
  id: number;
  dedupe_key: string;
  sheet_row_hash: string;
  submitted_at: string;
  child_name: string;
  birthday: string | null;
  gender: string | null;
  parent_name: string | null;
  parent_email: string | null;
  phone: string | null;
  target_start: string | null;
  toilet_trained: number | null;
  in_building: number | null;
  notes: string | null;
  status: WaitlistStatus;
  status_note: string | null;
  status_changed_at: string | null;
  last_seen_in_sheet: string;
  created_at: string;
  updated_at: string;
  converted_student_id: number | null;
  // v1.4.0 prioritization signals (all nullable — absence = no bonus)
  full_time: number | null;
  days_per_week: number | null;
  sibling_student_id: number | null;
  priority_notes: string | null;
}

export type AgeBand = "Infant" | "Toddler" | "3-5yr" | "School-age" | "Unknown";

export interface SyncStateRow {
  last_synced_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  row_count: number;
}

export interface SyncResult {
  ok: boolean;
  fetched: number;
  inserted: number;
  updated: number;
  archived: number;
  error?: string;
}

// ── Derived helpers ─────────────────────────────────────────────────────

export function parseTimestamp(raw: string): string {
  const s = (raw || "").trim();
  if (!s) return "";
  // Google Forms typical format: "12/25/2024 14:30:05" or ISO. Try Date.parse.
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString();
  // Fallback: "M/D/YYYY H:MM:SS"
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [, mo, da, yr, hh, mi, se] = m;
    // Assume US-style M/D since Google Forms defaults to spreadsheet locale
    // and BC daycare sheets in our sample are M/D/YYYY.
    const d = new Date(
      Number(yr),
      Number(mo) - 1,
      Number(da),
      Number(hh || 0),
      Number(mi || 0),
      Number(se || 0),
    );
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return s; // best-effort, keep raw string
}

// Birthday parser — auto-detect D/M/Y vs M/D/Y. If any component > 12, treat
// as day. When ambiguous, prefer D/M/Y (Canadian daycare convention).
export function parseBirthday(raw: string): string | null {
  const s = (raw || "").trim();
  if (!s) return null;
  // ISO already?
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    const y = Number(iso[1]), mo = Number(iso[2]), d = Number(iso[3]);
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  const parts = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
  if (!parts) return null;
  let a = Number(parts[1]), b = Number(parts[2]);
  const yr = Number(parts[3]);
  let year = yr < 100 ? (yr < 30 ? 2000 + yr : 1900 + yr) : yr;
  let day: number, month: number;
  if (a > 12 && b <= 12) { day = a; month = b; }
  else if (b > 12 && a <= 12) { month = a; day = b; }
  else if (a > 12 && b > 12) return null;
  else { day = a; month = b; } // ambiguous → D/M/Y (spec)
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseYesNo(raw: string): number | null {
  const s = (raw || "").trim().toLowerCase();
  if (!s) return null;
  if (s === "yes" || s === "y" || s === "true" || s === "1") return 1;
  if (s === "no" || s === "n" || s === "false" || s === "0") return 0;
  return null;
}

export function ageBand(birthday: string | null | undefined): AgeBand {
  if (!birthday) return "Unknown";
  const t = Date.parse(birthday);
  if (Number.isNaN(t)) return "Unknown";
  const months = (Date.now() - t) / (1000 * 60 * 60 * 24 * 30.4375);
  if (months < 0) return "Unknown";
  if (months <= 18) return "Infant";
  if (months <= 36) return "Toddler";
  if (months <= 60) return "3-5yr";
  return "School-age";
}

export function waitDays(submittedAt: string | null | undefined): number {
  if (!submittedAt) return 0;
  const t = Date.parse(submittedAt);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

export function priorityScore(
  e: WaitlistEntry,
  weights: PriorityWeights = DEFAULT_PRIORITY_WEIGHTS,
  ctx: PriorityCtx = {},
): number {
  return scoreBreakdown(e, weights, ctx).reduce((sum, l) => sum + l.points, 0);
}

// ─── v1.4.0 Prioritization ────────────────────────────────────────────
// A weighted linear score so the owner can rank a busy waitlist without
// staring at every row. All weights are user-editable in Settings; the
// breakdown is exposed to the UI so a parent asking "why not us?" gets a
// defensible answer.

export interface PriorityWeights {
  retention_per_month: number;   // × min(months_until_kindergarten, 24)
  toilet_trained:      number;   // flat if toilet_trained = 1
  in_building:         number;   // flat if in_building = 1
  sibling_current:     number;   // flat if sibling_student_id → active student
  sibling_alumni:      number;   // flat if sibling_student_id → inactive student
  wait_day:            number;   // × min(days_since_submitted, 365)
  days_per_week:       number;   // × (days_per_week ?? full_time?5:0), capped 5
}

export const DEFAULT_PRIORITY_WEIGHTS: PriorityWeights = {
  retention_per_month: 3,
  toilet_trained:      15,
  in_building:         20,
  sibling_current:     30,
  sibling_alumni:      10,
  wait_day:            0.1,
  days_per_week:       3,
};

const WEIGHT_KEYS: Record<keyof PriorityWeights, string> = {
  retention_per_month: "waitlist_weight_retention_per_month",
  toilet_trained:      "waitlist_weight_toilet_trained",
  in_building:         "waitlist_weight_in_building",
  sibling_current:     "waitlist_weight_sibling_current",
  sibling_alumni:      "waitlist_weight_sibling_alumni",
  wait_day:            "waitlist_weight_wait_day",
  days_per_week:       "waitlist_weight_days_per_week",
};

export async function loadPriorityWeights(): Promise<PriorityWeights> {
  // Import lazily to avoid a static cycle (db.ts ← waitlist.ts).
  const { getSettings } = await import("./db");
  const s = await getSettings();
  const out = { ...DEFAULT_PRIORITY_WEIGHTS };
  (Object.keys(WEIGHT_KEYS) as (keyof PriorityWeights)[]).forEach((k) => {
    const raw = s[WEIGHT_KEYS[k]];
    const n = raw == null ? NaN : Number(raw);
    if (Number.isFinite(n)) out[k] = n;
  });
  return out;
}

export async function savePriorityWeights(w: PriorityWeights): Promise<void> {
  const { setSetting } = await import("./db");
  await Promise.all(
    (Object.keys(WEIGHT_KEYS) as (keyof PriorityWeights)[]).map((k) =>
      setSetting(WEIGHT_KEYS[k], String(w[k])),
    ),
  );
}

export interface PriorityCtx {
  /** Map from student.id → active flag (1|0). Enables sibling scoring. */
  siblingStudentActive?: Map<number, number>;
  /** Injectable clock for tests. Defaults to now(). */
  today?: Date;
}

export interface ScoreLine {
  label: string;
  points: number;
  note?: string;
}

// BC kindergarten cutoff: Sep 1 of the calendar year the child turns 5 by Dec 31.
// (School Act — school-age is age-5-by-Dec-31.)
export function kindergartenStartFor(birthdayISO: string): Date | null {
  const bd = new Date(birthdayISO);
  if (isNaN(bd.getTime())) return null;
  return new Date(bd.getUTCFullYear() + 5, 8, 1); // month 8 = September
}

export function retentionMonths(
  e: Pick<WaitlistEntry, "birthday" | "target_start">,
  today: Date = new Date(),
): number {
  if (!e.birthday) return 0;
  const kStart = kindergartenStartFor(e.birthday);
  if (!kStart) return 0;
  const targetStart = e.target_start ? new Date(e.target_start) : today;
  const from = isNaN(targetStart.getTime()) || targetStart < today ? today : targetStart;
  const months = (kStart.getTime() - from.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  return Math.max(0, Math.min(24, months));
}

export function scoreBreakdown(
  e: WaitlistEntry,
  weights: PriorityWeights = DEFAULT_PRIORITY_WEIGHTS,
  ctx: PriorityCtx = {},
): ScoreLine[] {
  const today = ctx.today ?? new Date();
  const lines: ScoreLine[] = [];

  // Retention: capped 24 months, rounded for display
  const months = retentionMonths(e, today);
  if (months > 0 && weights.retention_per_month > 0) {
    lines.push({
      label: "Retention runway",
      points: round1(months * weights.retention_per_month),
      note: `${months.toFixed(1)} mo until BC kindergarten`,
    });
  }

  if (e.toilet_trained === 1 && weights.toilet_trained > 0) {
    lines.push({ label: "Toilet trained", points: weights.toilet_trained });
  }

  if (e.in_building === 1 && weights.in_building > 0) {
    lines.push({ label: "In-building family", points: weights.in_building });
  }

  if (e.sibling_student_id != null) {
    const active = ctx.siblingStudentActive?.get(e.sibling_student_id);
    if (active === 1 && weights.sibling_current > 0) {
      lines.push({
        label: "Sibling of current student",
        points: weights.sibling_current,
        note: `Student #${e.sibling_student_id}`,
      });
    } else if (active === 0 && weights.sibling_alumni > 0) {
      lines.push({
        label: "Sibling of alumni",
        points: weights.sibling_alumni,
        note: `Student #${e.sibling_student_id}`,
      });
    }
  }

  const waited = Math.min(waitDays(e.submitted_at), 365);
  if (waited > 0 && weights.wait_day > 0) {
    lines.push({
      label: "Wait time",
      points: round1(waited * weights.wait_day),
      note: `${waited} d on list`,
    });
  }

  // days_per_week wins if set; else fall back to full_time as 5-day proxy
  let dpw = e.days_per_week ?? null;
  if (dpw == null && e.full_time === 1) dpw = 5;
  if (dpw != null && dpw > 0 && weights.days_per_week > 0) {
    const capped = Math.min(5, Math.max(0, dpw));
    lines.push({
      label: "Enrollment intensity",
      points: round1(capped * weights.days_per_week),
      note: `${capped} d/wk`,
    });
  }

  return lines;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// SHA-256 → hex string via SubtleCrypto (available in Tauri webview).
async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const arr = Array.from(new Uint8Array(digest));
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function dedupeKey(
  submittedAt: string,
  childName: string,
  parentEmail: string,
): Promise<string> {
  return sha256Hex(`${submittedAt}|${childName.toLowerCase().trim()}|${parentEmail.toLowerCase().trim()}`);
}

export async function sheetRowHash(row: string[]): Promise<string> {
  return sha256Hex(row.join("|"));
}

// ── Row parsing ─────────────────────────────────────────────────────────

interface ParsedRow {
  dedupe_key: string;
  sheet_row_hash: string;
  submitted_at: string;
  child_name: string;
  birthday: string | null;
  gender: string | null;
  parent_name: string | null;
  parent_email: string | null;
  phone: string | null;
  target_start: string | null;
  toilet_trained: number | null;
  in_building: number | null;
  notes: string | null;
}

async function parseRow(row: string[]): Promise<ParsedRow | null> {
  // Sheets may return short arrays when trailing cells are blank.
  const cell = (i: number) => (row[i] ?? "").toString();
  const submittedAt = parseTimestamp(cell(0));
  const childName = cell(1).trim();
  if (!submittedAt || !childName) return null; // skip garbage rows
  const parentEmail = cell(7).trim().toLowerCase();
  return {
    dedupe_key: await dedupeKey(submittedAt, childName, parentEmail),
    sheet_row_hash: await sheetRowHash(row),
    submitted_at: submittedAt,
    child_name: childName,
    birthday: parseBirthday(cell(2)),
    gender: cell(3).trim() || null,
    parent_name: cell(4).trim() || null,
    parent_email: parentEmail || null,
    phone: cell(5).trim() || null,
    target_start: cell(6).trim() || null,
    toilet_trained: parseYesNo(cell(8)),
    in_building: parseYesNo(cell(9)),
    notes: cell(10).trim() || null,
  };
}

// ── Sync engine ─────────────────────────────────────────────────────────

const MIN_SYNC_INTERVAL_MS = 30_000;
let lastSyncAt = 0;
let consecutiveFailures = 0;
let syncInFlight: Promise<SyncResult> | null = null;

export function timeSinceLastSyncMs(): number {
  return Date.now() - lastSyncAt;
}

async function readSetting(key: string): Promise<string> {
  const d = await db();
  const r = await d.select<{ value: string }[]>("SELECT value FROM settings WHERE key=?", [key]);
  return r[0]?.value ?? "";
}

export async function readSyncState(): Promise<SyncStateRow> {
  const d = await db();
  const r = await d.select<SyncStateRow[]>(
    "SELECT last_synced_at, last_success_at, last_error, row_count FROM waitlist_sync_state WHERE id=1",
  );
  return r[0] ?? { last_synced_at: null, last_success_at: null, last_error: null, row_count: 0 };
}

async function writeSyncState(patch: Partial<SyncStateRow>): Promise<void> {
  const fields: string[] = [];
  const vals: any[] = [];
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = ?`);
    vals.push(v);
  }
  if (!fields.length) return;
  vals.push(1);
  await execRetry(`UPDATE waitlist_sync_state SET ${fields.join(", ")} WHERE id = ?`, vals);
}

export async function syncWaitlist(opts: { force?: boolean } = {}): Promise<SyncResult> {
  if (syncInFlight) return syncInFlight;
  const now = Date.now();
  if (!opts.force && now - lastSyncAt < MIN_SYNC_INTERVAL_MS) {
    return { ok: true, fetched: 0, inserted: 0, updated: 0, archived: 0, error: "rate-limited" };
  }
  lastSyncAt = now;

  const run = (async (): Promise<SyncResult> => {
    const syncStartedAt = new Date().toISOString();
    try {
      const sheetId = (await readSetting("waitlist_sheet_id")).trim();
      const range = (await readSetting("waitlist_sheet_range")).trim() || "Form_Responses!A:K";
      if (!sheetId) throw new Error("Waitlist sheet ID is not configured.");

      const resp = await invoke<{ header: string[]; rows: string[][] }>(
        "waitlist_fetch_rows",
        { sheetId, range },
      );

      let inserted = 0, updated = 0;
      const seenDedupeKeys: string[] = [];
      for (const raw of resp.rows) {
        const p = await parseRow(raw);
        if (!p) continue;
        seenDedupeKeys.push(p.dedupe_key);

        const d = await db();
        const existing = await d.select<{ id: number; sheet_row_hash: string }[]>(
          "SELECT id, sheet_row_hash FROM waitlist_entries WHERE dedupe_key = ?",
          [p.dedupe_key],
        );

        if (existing.length === 0) {
          await execRetry(
            `INSERT INTO waitlist_entries
              (dedupe_key, sheet_row_hash, submitted_at, child_name, birthday, gender,
               parent_name, parent_email, phone, target_start, toilet_trained, in_building,
               notes, status, last_seen_in_sheet, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)`,
            [
              p.dedupe_key, p.sheet_row_hash, p.submitted_at, p.child_name, p.birthday, p.gender,
              p.parent_name, p.parent_email, p.phone, p.target_start, p.toilet_trained, p.in_building,
              p.notes, syncStartedAt, syncStartedAt, syncStartedAt,
            ],
          );
          inserted++;
        } else {
          const changed = existing[0].sheet_row_hash !== p.sheet_row_hash;
          if (changed) {
            // Preserve local status / note / converted_student_id — sheet is
            // authoritative for form-answer fields only.
            await execRetry(
              `UPDATE waitlist_entries SET
                sheet_row_hash = ?, submitted_at = ?, child_name = ?, birthday = ?, gender = ?,
                parent_name = ?, parent_email = ?, phone = ?, target_start = ?, toilet_trained = ?,
                in_building = ?, notes = ?, last_seen_in_sheet = ?, updated_at = ?
               WHERE dedupe_key = ?`,
              [
                p.sheet_row_hash, p.submitted_at, p.child_name, p.birthday, p.gender,
                p.parent_name, p.parent_email, p.phone, p.target_start, p.toilet_trained,
                p.in_building, p.notes, syncStartedAt, syncStartedAt,
                p.dedupe_key,
              ],
            );
            updated++;
          } else {
            await execRetry(
              "UPDATE waitlist_entries SET last_seen_in_sheet = ? WHERE dedupe_key = ?",
              [syncStartedAt, p.dedupe_key],
            );
          }
        }
      }

      // Soft-archive: rows not seen in this sync AND not already terminal.
      // Use a 5-minute grace window on last_seen_in_sheet so we don't archive
      // rows updated in the same second as a race.
      const graceThreshold = new Date(Date.parse(syncStartedAt) - 5 * 60_000).toISOString();
      const archivedRes = await execRetry(
        `UPDATE waitlist_entries
            SET status = 'archived', status_changed_at = ?, updated_at = ?
          WHERE last_seen_in_sheet < ?
            AND status NOT IN ('enrolled', 'withdrawn', 'archived')`,
        [syncStartedAt, syncStartedAt, graceThreshold],
      );

      // Aged-out archive: kids over 60 months (5 yrs) as of today. Runs on
      // every sync so records self-clean over time. Applies regardless of
      // current status (per owner preference — historical enrolled/withdrawn
      // over-age records also get archived to keep active views clean).
      // The status_note is set so the reason is visible in the Archived tab.
      const agedOutCutoff = new Date();
      agedOutCutoff.setMonth(agedOutCutoff.getMonth() - 60);
      const agedOutIso = agedOutCutoff.toISOString().slice(0, 10);
      const agedRes = await execRetry(
        `UPDATE waitlist_entries
            SET status = 'archived',
                status_note = COALESCE(NULLIF(status_note, ''), 'Aged out — over daycare age (>5 yrs)'),
                status_changed_at = COALESCE(status_changed_at, ?),
                updated_at = ?
          WHERE status != 'archived'
            AND birthday IS NOT NULL
            AND birthday != ''
            AND birthday < ?`,
        [syncStartedAt, syncStartedAt, agedOutIso],
      );

      await writeSyncState({
        last_synced_at: syncStartedAt,
        last_success_at: syncStartedAt,
        last_error: null,
        row_count: seenDedupeKeys.length,
      });

      // Cache convenience setting (used by UI without hitting sync state).
      await execRetry(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        ["waitlist_last_synced_at", syncStartedAt],
      );

      consecutiveFailures = 0;
      return {
        ok: true,
        fetched: seenDedupeKeys.length,
        inserted,
        updated,
        archived: archivedRes.rowsAffected + agedRes.rowsAffected,
      };
    } catch (e: any) {
      const msg = String(e?.message || e);
      consecutiveFailures++;
      await writeSyncState({ last_synced_at: syncStartedAt, last_error: msg });
      if (consecutiveFailures >= 3) {
        await logError("ERROR", `[waitlist] sync failed ${consecutiveFailures}x: ${msg}`);
      }
      return { ok: false, fetched: 0, inserted: 0, updated: 0, archived: 0, error: msg };
    }
  })();

  syncInFlight = run;
  try {
    return await run;
  } finally {
    syncInFlight = null;
  }
}

// ── Auto-sync orchestration ─────────────────────────────────────────────

let autoSyncTimer: number | null = null;
let autoSyncInstalled = false;

export function consecutiveFailureCount(): number {
  return consecutiveFailures;
}

export async function startAutoSync(): Promise<void> {
  if (autoSyncInstalled) return;
  autoSyncInstalled = true;

  const maybeRun = async () => {
    try {
      const enabled = (await readSetting("waitlist_sync_enabled")) === "1";
      if (!enabled) return;
      const status = await invoke<{ credentials_loaded: boolean }>("waitlist_get_status");
      if (!status.credentials_loaded) return;
      await syncWaitlist();
    } catch (e: any) {
      // Never throw from auto-sync heartbeat.
      console.warn("[waitlist] auto-sync tick failed:", e);
    }
  };

  // Immediate on launch.
  void maybeRun();

  // Interval — read setting each tick so the frequency updates without restart.
  const scheduleNext = async () => {
    const raw = await readSetting("waitlist_sync_interval_min");
    // Cap at 1440 min (24 h) — must be ≥ the largest option in Settings.tsx.
    const min = Math.max(1, Math.min(1440, Number(raw || "720")));
    if (autoSyncTimer !== null) window.clearTimeout(autoSyncTimer);
    autoSyncTimer = window.setTimeout(async () => {
      await maybeRun();
      void scheduleNext();
    }, min * 60_000);
  };
  void scheduleNext();

  // Refresh on window focus if stale (>2 min).
  window.addEventListener("focus", () => {
    if (timeSinceLastSyncMs() > 2 * 60_000) void maybeRun();
  });
}

// Called from waitlist screens on mount — refresh if stale (30 sec).
export async function syncOnScreenOpen(): Promise<void> {
  try {
    const enabled = (await readSetting("waitlist_sync_enabled")) === "1";
    if (!enabled) return;
    const status = await invoke<{ credentials_loaded: boolean }>("waitlist_get_status");
    if (!status.credentials_loaded) return;
    if (timeSinceLastSyncMs() > 30_000) await syncWaitlist();
  } catch {
    /* silent */
  }
}

// ── Queries used by screens ─────────────────────────────────────────────

export async function listWaitlist(opts: {
  statuses?: WaitlistStatus[];
  search?: string;
} = {}): Promise<WaitlistEntry[]> {
  const d = await db();
  const clauses: string[] = [];
  const args: any[] = [];
  if (opts.statuses && opts.statuses.length) {
    clauses.push(`status IN (${opts.statuses.map(() => "?").join(",")})`);
    args.push(...opts.statuses);
  }
  if (opts.search && opts.search.trim()) {
    const q = `%${opts.search.trim().toLowerCase()}%`;
    clauses.push("(LOWER(child_name) LIKE ? OR LOWER(COALESCE(parent_email,'')) LIKE ? OR LOWER(COALESCE(parent_name,'')) LIKE ? OR COALESCE(phone,'') LIKE ?)");
    args.push(q, q, q, q);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return d.select<WaitlistEntry[]>(
    `SELECT * FROM waitlist_entries ${where} ORDER BY submitted_at DESC`,
    args,
  );
}

export async function getWaitlistEntry(id: number): Promise<WaitlistEntry | null> {
  const d = await db();
  const rows = await d.select<WaitlistEntry[]>(
    "SELECT * FROM waitlist_entries WHERE id = ?",
    [id],
  );
  return rows[0] ?? null;
}

export async function updateWaitlistStatus(
  id: number,
  status: WaitlistStatus,
  note?: string | null,
): Promise<void> {
  const nowIso = new Date().toISOString();
  await execRetry(
    `UPDATE waitlist_entries
        SET status = ?, status_note = ?, status_changed_at = ?, updated_at = ?
      WHERE id = ?`,
    [status, note ?? null, nowIso, nowIso, id],
  );
}

export async function markConverted(id: number, studentId: number): Promise<void> {
  const nowIso = new Date().toISOString();
  await execRetry(
    `UPDATE waitlist_entries
        SET converted_student_id = ?, status = 'enrolled',
            status_changed_at = ?, updated_at = ?
      WHERE id = ?`,
    [studentId, nowIso, nowIso, id],
  );
}

export interface PriorityFields {
  full_time: number | null;
  days_per_week: number | null;
  sibling_student_id: number | null;
  priority_notes: string | null;
}

export async function updateWaitlistPriority(id: number, p: PriorityFields): Promise<void> {
  const nowIso = new Date().toISOString();
  await execRetry(
    `UPDATE waitlist_entries
        SET full_time = ?, days_per_week = ?, sibling_student_id = ?,
            priority_notes = ?, updated_at = ?
      WHERE id = ?`,
    [p.full_time, p.days_per_week, p.sibling_student_id, p.priority_notes, nowIso, id],
  );
}

export async function loadActiveStudentMap(): Promise<Map<number, number>> {
  const d = await db();
  const rows = await d.select<{ id: number; active: number }[]>(
    "SELECT id, active FROM students",
  );
  const m = new Map<number, number>();
  for (const r of rows) m.set(r.id, r.active);
  return m;
}

// Convenience for KPIs.
export interface WaitlistKpis {
  totalActive: number;
  medianWaitDays: number;
  byBand: Record<AgeBand, number>;
  recent: WaitlistEntry[];
  stale: WaitlistEntry[];
}

export async function waitlistKpis(): Promise<WaitlistKpis> {
  const d = await db();
  const active = await d.select<WaitlistEntry[]>(
    `SELECT * FROM waitlist_entries
      WHERE status NOT IN ('enrolled','withdrawn','archived')
      ORDER BY submitted_at DESC`,
  );
  const byBand: Record<AgeBand, number> = {
    Infant: 0, Toddler: 0, "3-5yr": 0, "School-age": 0, Unknown: 0,
  };
  const waits: number[] = [];
  for (const e of active) {
    byBand[ageBand(e.birthday)]++;
    waits.push(waitDays(e.submitted_at));
  }
  waits.sort((a, b) => a - b);
  const median = waits.length ? waits[Math.floor(waits.length / 2)] : 0;
  const stale = active.filter((e) => e.status === "new" && waitDays(e.submitted_at) > 30);
  return {
    totalActive: active.length,
    medianWaitDays: median,
    byBand,
    recent: active.slice(0, 5),
    stale,
  };
}
