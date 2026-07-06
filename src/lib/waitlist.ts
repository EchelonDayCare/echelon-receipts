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

export function priorityScore(e: Pick<WaitlistEntry, "in_building" | "submitted_at">): number {
  return (e.in_building === 1 ? 100 : 0) + waitDays(e.submitted_at);
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
