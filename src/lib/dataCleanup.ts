// v3.25.0 — Data Cleanup tool (top-right icon stack, below the lock).
//
// Lets an owner permanently clear one or more categories of records —
// e.g. dummy students/receipts entered during setup/testing — before
// handing the app to real families. This is intentionally NOT a "reset
// everything" button:
//   * Settings, Security (PIN/MDK), email templates, and Website CMS
//     config are NEVER touched by this tool.
//   * Every category is opt-in (checkbox), with a live COUNT preview
//     before anything is deleted — and that preview is computed from the
//     EXACT same resource list + WHERE clause the delete step will run,
//     so the number shown can never drift from the number deleted.
//   * A full encrypted-DB safety copy is mandatory (not skippable), runs
//     INSIDE the same write-serialization lock as the delete so no other
//     write can land between the backup and the transaction, and fails
//     loudly (aborting the whole cleanup) if the checkpoint can't be
//     verified complete.
//   * All deletes for a run happen inside one BEGIN IMMEDIATE / COMMIT
//     so a crash mid-run can't leave orphaned rows (e.g. receipts
//     pointing at a deleted student).
//
// FK reality check (why "students" pulls in more than the roster):
// `receipts.student_id`, `accb_entries.student_id`, and
// `child_attendance.student_id` all reference `students(id)` with no
// ON DELETE CASCADE, so SQLite (foreign_keys=ON) refuses to delete a
// student that still has receipts/attendance/ACCB rows. Selecting
// "Students" therefore always cascades into Receipts & Billing and
// Attendance for consistency — the UI must say so up front.
import { invoke } from "@tauri-apps/api/core";
import { db, serializeWrite, checkpointWal } from "./db";

export type CleanupCategory =
  | "students"
  | "receipts"
  | "attendance"
  | "waitlist"
  | "expenses";

export const CLEANUP_CATEGORY_LABELS: Record<CleanupCategory, string> = {
  students: "Students / roster",
  receipts: "Receipts, Annual Tax Receipts, ACCB entries & Bank Deposits",
  attendance: "Attendance records",
  waitlist: "Waitlist applications",
  expenses: "Expenses, recurring bills & imports",
};

// Selecting "students" always cascades into these — shown to the user
// as a note, and enforced regardless of whether they're separately checked.
export const CLEANUP_CASCADE_NOTE =
  "Deleting Students also deletes their Receipts, Annual Tax Receipts, ACCB entries, Bank Deposits, and Attendance records — a student can't be removed while those still reference it.";

// Resources that actually delete/blank rows a user can select via a
// category. "Repair" steps (recalc totals, null dangling refs, reset
// waitlist sync state) are not resources here — they always run
// automatically inside runDataCleanup whenever a resource that could
// have orphaned them also ran; see the repairs block below.
type ResourceKey =
  | "clear_deposit_links"
  | "del_deposits"
  | "del_attendance"
  | "del_accb"
  | "del_annual"
  | "del_receipts"
  | "del_students"
  | "del_waitlist"
  | "del_expenses"
  | "del_recurring_expenses";

// Optional year (and month) scope. When present, only rows *dated* in
// that period are touched — the student/kid roster is NEVER deleted in
// this mode. (students.year means a child can have a separate row per
// enrollment year — see students.year usage in attendance.ts,
// monthAttendance.ts, agmMinutes.ts — so a year-scoped cleanup
// deliberately never touches the roster table; use "Whole categories"
// mode to remove roster rows.) Month is 1-12; omitted = the whole year.
export interface DateScope {
  year: number;
  month?: number;
}

// Every date column this tool ever filters on is stored as either
// 'YYYY-MM-DD' or an ISO datetime beginning 'YYYY-MM-DD...' (see
// receipts.date, child_attendance.work_date, expenses.date,
// deposits.deposit_date, waitlist_entries.created_at). The rest of the
// app (db.ts, expenses.ts, staff.ts, yearArchive.ts, homeAlerts.ts) all
// scope years with substr(col,1,4)/substr(col,6,2) rather than
// strftime() — strftime() returns NULL (silently excluding the row from
// both the count AND the delete) for any value it can't parse as a full
// datetime, which free-form imported/edited text can easily violate.
// Matching the rest of the app's convention keeps this tool's idea of
// "2026" identical to every report screen's idea of "2026".
function yearMonthWhere(col: string, scope: DateScope): { clause: string; params: (string | number)[] } {
  if (scope.month) {
    return {
      clause: `substr(${col},1,4) = ? AND substr(${col},6,2) = ?`,
      params: [String(scope.year), String(scope.month).padStart(2, "0")],
    };
  }
  return { clause: `substr(${col},1,4) = ?`, params: [String(scope.year)] };
}

// A sentinel meaning "this resource is not meaningful for this scope and
// must be skipped entirely" — e.g. annual_receipts (a whole-year document)
// when only a single month is selected. Skipping (rather than falling
// back to deleting the whole year) means the tool NEVER deletes more than
// the scope the user selected.
const SKIP = Symbol("skip-resource-for-scope");

// Table + WHERE-clause resolver shared verbatim by both the preview count
// and the actual delete — the single source of truth that keeps "the
// number you're shown" and "the number that gets deleted" identical.
function resolveResource(
  resource: ResourceKey,
  scope: DateScope | null,
): { table: string; clause: string; params: (string | number)[] } | typeof SKIP {
  switch (resource) {
    case "clear_deposit_links":
      // Not a delete — handled separately in runDataCleanup. Never
      // included in category count totals.
      return { table: "receipts", clause: "1=0", params: [] };
    case "del_deposits":
      return scope
        ? { table: "deposits", ...yearMonthWhere("deposit_date", scope) }
        : { table: "deposits", clause: "1=1", params: [] };
    case "del_attendance":
      return scope
        ? { table: "child_attendance", ...yearMonthWhere("work_date", scope) }
        : { table: "child_attendance", clause: "1=1", params: [] };
    case "del_accb":
      if (!scope) return { table: "accb_entries", clause: "1=1", params: [] };
      return scope.month
        ? { table: "accb_entries", clause: "year = ? AND month = ?", params: [scope.year, scope.month] }
        : { table: "accb_entries", clause: "year = ?", params: [scope.year] };
    case "del_annual":
      if (!scope) return { table: "annual_receipts", clause: "1=1", params: [] };
      // Annual receipts document a full calendar year; a partial-year
      // delete would destroy a document covering months the user did NOT
      // ask to clear. Skip rather than over-delete. Whole-year scope (no
      // month) is fine.
      if (scope.month) return SKIP;
      return { table: "annual_receipts", clause: "calendar_year = ?", params: [scope.year] };
    case "del_receipts":
      return scope
        ? { table: "receipts", ...yearMonthWhere("date", scope) }
        : { table: "receipts", clause: "1=1", params: [] };
    case "del_students":
      // Never scoped by date — see DateScope docs above. Whole-category
      // mode only.
      if (scope) return SKIP;
      return { table: "students", clause: "1=1", params: [] };
    case "del_waitlist":
      return scope
        ? { table: "waitlist_entries", ...yearMonthWhere("created_at", scope) }
        : { table: "waitlist_entries", clause: "1=1", params: [] };
    case "del_expenses":
      return scope
        ? { table: "expenses", ...yearMonthWhere("date", scope) }
        : { table: "expenses", clause: "1=1", params: [] };
    case "del_recurring_expenses":
      // Templates, not dated events — whole-category mode only.
      if (scope) return SKIP;
      return { table: "recurring_expenses", clause: "1=1", params: [] };
  }
}

function buildResourceStatement(
  resource: ResourceKey,
  scope: DateScope | null,
): { sql: string; params: (string | number)[] } | null {
  if (resource === "clear_deposit_links") {
    if (!scope) return { sql: "UPDATE receipts SET deposit_id=NULL, deposited_at=NULL", params: [] };
    // Null out links on any receipt whose deposit falls in the scoped
    // period — whether or not that receipt itself is being deleted.
    const { clause, params } = yearMonthWhere("deposit_date", scope);
    return {
      sql: `UPDATE receipts SET deposit_id=NULL, deposited_at=NULL WHERE deposit_id IN (SELECT id FROM deposits WHERE ${clause})`,
      params,
    };
  }
  const r = resolveResource(resource, scope);
  if (r === SKIP) return null;
  return { sql: `DELETE FROM ${r.table} WHERE ${r.clause}`, params: r.params };
}

// Fixed execution order — every resource that could be pulled in by any
// category is listed here exactly once, in an order that never violates
// a foreign key (children before the parents they reference).
const RESOURCE_ORDER: ResourceKey[] = [
  "clear_deposit_links",
  "del_deposits",
  "del_attendance",
  "del_accb",
  "del_annual",
  "del_receipts",
  "del_students",
  "del_waitlist",
  "del_expenses",
  "del_recurring_expenses",
];

const CATEGORY_RESOURCES: Record<CleanupCategory, ResourceKey[]> = {
  // Full cascade — a student row can't survive with receipts/attendance/
  // ACCB rows still pointing at it under foreign_keys=ON.
  students: [
    "clear_deposit_links",
    "del_deposits",
    "del_attendance",
    "del_accb",
    "del_annual",
    "del_receipts",
    "del_students",
  ],
  // Billing only — leaves the roster and attendance untouched.
  receipts: ["clear_deposit_links", "del_deposits", "del_accb", "del_annual", "del_receipts"],
  attendance: ["del_attendance"],
  waitlist: ["del_waitlist"],
  expenses: ["del_expenses", "del_recurring_expenses"],
};

// Resources that never contribute a visible "N records" count — the
// deposit-link UPDATE isn't a deletion the user is choosing to make, it's
// plumbing to keep FKs valid.
const NON_COUNTABLE: ReadonlySet<ResourceKey> = new Set(["clear_deposit_links"]);

// Which resources a category would actually touch for a given scope —
// i.e. CATEGORY_RESOURCES with anything SKIPped for this scope removed.
// Used both to compute previews and to defensively filter the category
// list right before a delete runs.
export function categoryResourcesForScope(category: CleanupCategory, scope: DateScope | null): ResourceKey[] {
  return CATEGORY_RESOURCES[category].filter((r) => resolveResource(r, scope) !== SKIP);
}

async function countResource(resource: ResourceKey, scope: DateScope | null): Promise<number> {
  if (NON_COUNTABLE.has(resource)) return 0;
  const r = resolveResource(resource, scope);
  if (r === SKIP) return 0;
  const rows = await (await db()).select<{ n: number }[]>(`SELECT COUNT(*) AS n FROM ${r.table} WHERE ${r.clause}`, r.params);
  return rows[0]?.n ?? 0;
}

// Per-category preview count, built from the EXACT resource list + WHERE
// clause `runDataCleanup` will execute for that category/scope — this is
// what guarantees "the number you're shown" and "the number that gets
// deleted" can never drift apart: there is only one source of truth for
// "what counts as this category," not two hand-maintained lists.
export async function getCategoryCount(category: CleanupCategory, scope: DateScope | null = null): Promise<number> {
  const resources = CATEGORY_RESOURCES[category];
  const counts = await Promise.all(resources.map((r) => countResource(r, scope)));
  return counts.reduce((a, b) => a + b, 0);
}

export type CleanupCounts = Record<CleanupCategory, number>;

// Preview counts for every category at once, scoped or unscoped. The
// modal renders these directly next to each checkbox and sums the
// selected ones for the confirmation total — both numbers now come from
// the same per-category totals computed here.
export async function getCleanupCounts(scope: DateScope | null = null): Promise<CleanupCounts> {
  const categories: CleanupCategory[] = ["students", "receipts", "attendance", "waitlist", "expenses"];
  const entries = await Promise.all(categories.map(async (c) => [c, await getCategoryCount(c, scope)] as const));
  return Object.fromEntries(entries) as CleanupCounts;
}

// Whether any annual tax receipt in the given (whole-year) scope has
// already been emailed to a family — deleting these destroys a document
// a parent may already be relying on for a CRA filing (T778). The modal
// uses this to require a stronger, separate confirmation before allowing
// the delete to proceed. Always false for a month scope (annual receipts
// are skipped entirely there).
export async function hasEmailedAnnualReceiptsInScope(scope: DateScope | null): Promise<boolean> {
  if (scope?.month) return false; // del_annual is skipped for month scope — nothing to warn about
  const d = await db();
  const rows = scope
    ? await d.select<{ n: number }[]>(
        "SELECT COUNT(*) AS n FROM annual_receipts WHERE calendar_year=? AND emailed_at IS NOT NULL AND emailed_at != ''",
        [scope.year],
      )
    : await d.select<{ n: number }[]>(
        "SELECT COUNT(*) AS n FROM annual_receipts WHERE emailed_at IS NOT NULL AND emailed_at != ''",
      );
  return (rows[0]?.n ?? 0) > 0;
}

// Distinct years present across every date-bearing table, newest first —
// used to populate the Year dropdown in the modal so the owner only ever
// sees years that actually have data. Uses the same substr() convention
// as everything else in this file (see yearMonthWhere's docstring).
export async function getAvailableYears(): Promise<number[]> {
  const d = await db();
  const queries = [
    "SELECT DISTINCT CAST(substr(date,1,4) AS INTEGER) AS y FROM receipts WHERE date IS NOT NULL",
    "SELECT DISTINCT CAST(substr(work_date,1,4) AS INTEGER) AS y FROM child_attendance WHERE work_date IS NOT NULL",
    "SELECT DISTINCT CAST(substr(date,1,4) AS INTEGER) AS y FROM expenses WHERE date IS NOT NULL",
    "SELECT DISTINCT CAST(substr(deposit_date,1,4) AS INTEGER) AS y FROM deposits WHERE deposit_date IS NOT NULL",
    "SELECT DISTINCT calendar_year AS y FROM annual_receipts",
    "SELECT DISTINCT year AS y FROM accb_entries",
    "SELECT DISTINCT CAST(substr(created_at,1,4) AS INTEGER) AS y FROM waitlist_entries WHERE created_at IS NOT NULL",
  ];
  const years = new Set<number>();
  for (const q of queries) {
    const rows = await d.select<{ y: number | null }[]>(q);
    for (const r of rows) if (r.y != null && !Number.isNaN(r.y)) years.add(r.y);
  }
  return Array.from(years).sort((a, b) => b - a);
}

export interface CleanupResult {
  backupPath: string;
  deletedRows: Partial<Record<ResourceKey, number>>;
  categoriesRun: CleanupCategory[];
}

// Runs the mandatory safety backup, then deletes every resource pulled in
// by `categories` inside one transaction, then writes one audit_log row
// per resource actually affected, then repairs anything the delete could
// have orphaned (deposit totals, dangling waitlist/comm-log references,
// stale waitlist sync counters). Throws (and rolls back cleanly) on any
// failure — nothing partial is ever left committed.
//
// `scope`: when provided, only rows dated in that year (and optional
// month) are deleted — everything outside the period, and the entire
// student roster, is left untouched regardless of which categories are
// checked. "students", "recurring_expenses", and (for a month scope)
// "annual_receipts" are skipped entirely in this mode.
export async function runDataCleanup(
  categories: CleanupCategory[],
  scope: DateScope | null = null,
): Promise<CleanupResult> {
  if (categories.length === 0) throw new Error("Pick at least one category to clear.");
  // Defensive: never let a category that shouldn't apply to this scope
  // (e.g. "students" while scope is set) reach the delete loop, even if
  // a caller's selection state got out of sync with the mode toggle.
  const safeCategories = categories.filter((c) => !scope || categoryResourcesForScope(c, scope).length > 0);
  if (safeCategories.length === 0) throw new Error("Nothing to delete for the selected scope.");

  const needed = new Set<ResourceKey>();
  for (const c of safeCategories) for (const r of CATEGORY_RESOURCES[c]) needed.add(r);
  const orderedResources = RESOURCE_ORDER.filter((r) => needed.has(r));
  const willTouchDeposits = needed.has("clear_deposit_links") || needed.has("del_deposits") || needed.has("del_receipts");
  const willTouchStudents = needed.has("del_students");
  const willTouchReceipts = needed.has("del_receipts");
  const willTouchAnnual = needed.has("del_annual");
  const willTouchWaitlist = needed.has("del_waitlist");

  return serializeWrite(async () => {
    // Mandatory, non-skippable safety copy of the still-encrypted live DB.
    // Runs INSIDE the same serialized-write slot as the delete (not
    // before it) so no other queued write (waitlist auto-sync, recurring
    // expense posting, notification scheduler) can land in the gap
    // between "copy the file" and "start the transaction." Checkpoint
    // first so the WAL is folded into the main file; if SQLite reports
    // it couldn't fully checkpoint (busy=1, e.g. a stale open read
    // transaction elsewhere), abort rather than hand back a backup that
    // is silently missing committed rows.
    const checkpoint = await checkpointWal();
    if (checkpoint.busy) {
      throw new Error(
        "Could not take a complete safety backup (database was busy mid-checkpoint). Close any other screens reading the database and try again.",
      );
    }
    const backupPath = await invoke<string>("backup_before_data_cleanup");

    const d = await db();
    await d.execute("BEGIN IMMEDIATE");
    const deletedRows: Partial<Record<ResourceKey, number>> = {};
    try {
      for (const resource of orderedResources) {
        const stmt = buildResourceStatement(resource, scope);
        if (!stmt) continue; // skipped in this scope (e.g. del_students when year-scoped)
        const res = await d.execute(stmt.sql, stmt.params);
        deletedRows[resource] = res.rowsAffected;
      }

      // ── Repairs: fix anything the deletes above could have orphaned ──
      // A deposit that lost some (but not all) of its linked receipts —
      // either because those receipts were deleted, or because
      // clear_deposit_links unlinked them — keeps stale cheque_count /
      // total_amount unless recomputed here. Cheap and safe to run
      // unconditionally whenever deposits/receipts were touched.
      if (willTouchDeposits) {
        await d.execute(`
          UPDATE deposits SET
            cheque_count = (SELECT COUNT(*) FROM receipts WHERE receipts.deposit_id = deposits.id),
            total_amount = (SELECT COALESCE(SUM(amount), 0) FROM receipts WHERE receipts.deposit_id = deposits.id)
        `);
      }

      // Null out references that have no FK (so SQLite won't catch them)
      // but do get displayed/joined elsewhere.
      if (willTouchStudents) {
        await d.execute("UPDATE waitlist_entries SET converted_student_id = NULL WHERE converted_student_id IS NOT NULL AND converted_student_id NOT IN (SELECT id FROM students)");
      }
      if (willTouchReceipts) {
        await d.execute("UPDATE communication_log SET related_id = NULL WHERE kind = 'receipt' AND related_id IS NOT NULL AND related_id NOT IN (SELECT id FROM receipts)");
      }
      if (willTouchAnnual) {
        await d.execute("UPDATE communication_log SET related_id = NULL WHERE kind = 'annual_receipt' AND related_id IS NOT NULL AND related_id NOT IN (SELECT id FROM annual_receipts)");
      }

      // waitlist_sync_state.row_count is a cached counter shown in
      // Settings → Waitlist; clearing waitlist_entries without resetting
      // it leaves a stale number.
      if (willTouchWaitlist) {
        await d.execute(
          "UPDATE waitlist_sync_state SET row_count = (SELECT COUNT(*) FROM waitlist_entries) WHERE id = 1",
        );
      }

      // One audit_log row per resource actually affected (not per
      // category) so the forensic trail shows real per-table counts
      // instead of one repeated blob — inserted on the same
      // connection/transaction, NOT via logAudit() (which calls
      // serializeWrite itself and would deadlock nested inside this one).
      const scopeLabel = scope ? `${scope.year}${scope.month ? `-${String(scope.month).padStart(2, "0")}` : ""}` : "all-time";
      const reason = scope
        ? `Data Cleanup: scoped to ${scopeLabel} via top-right Data Cleanup button`
        : "Pre-launch cleanup of test/dummy data via top-right Data Cleanup button";
      for (const [resource, count] of Object.entries(deletedRows)) {
        await d.execute(
          `INSERT INTO audit_log (ts, actor, action, target_type, target_id, before_json, after_json, reason)
           VALUES (datetime('now'), ?, 'data_cleanup', ?, 0, NULL, ?, ?)`,
          [
            "owner",
            resource,
            JSON.stringify({ rowsAffected: count, scope: scopeLabel, backupPath }),
            reason,
          ],
        );
      }
      await d.execute("COMMIT");
    } catch (e) {
      try {
        await d.execute("ROLLBACK");
      } catch (rollbackErr) {
        // The connection is now stuck inside an open transaction — every
        // subsequent write in this session would fail with "cannot start
        // a transaction within a transaction." Surface this distinctly
        // so the UI can tell the user to restart the app immediately,
        // rather than reporting a generic cleanup failure.
        throw new Error(
          `Data cleanup failed AND the rollback itself failed (${String((rollbackErr as any)?.message ?? rollbackErr)}). ` +
          `Restart the app now before doing anything else — a safety backup was already taken at: ${backupPath}`,
        );
      }
      // Record the failed attempt for the audit trail — outside the
      // failed transaction (which was just rolled back), on its own
      // write, so "a cleanup was attempted and failed" is never silently
      // lost.
      try {
        await d.execute(
          `INSERT INTO audit_log (ts, actor, action, target_type, target_id, before_json, after_json, reason)
           VALUES (datetime('now'), ?, 'data_cleanup_failed', 'error', 0, NULL, NULL, ?)`,
          ["owner", `Data Cleanup attempt failed and was rolled back: ${String((e as any)?.message ?? e)}`],
        );
      } catch { /* best effort — don't let audit logging mask the real error */ }
      throw e;
    }
    return { backupPath, deletedRows, categoriesRun: safeCategories };
  });
}
