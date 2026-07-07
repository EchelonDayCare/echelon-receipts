import { invoke } from "@tauri-apps/api/core";
import type { Student, Receipt, SettingsMap, AnnualReceipt, AccbEntry, FeeBreakdown, Deposit } from "../types";

// ---------- Database shim ----------
// v2.0.0 replaced @tauri-apps/plugin-sql with a Rust-side db_gate module
// (single-connection SQLite pool behind a Tokio Mutex). This shim mimics
// the tauri-plugin-sql Database interface so the rest of db.ts (and
// every screen that goes through it) needs zero changes.
//
// * Match method signatures exactly: execute(sql, args) -> {lastInsertId, rowsAffected},
//   select<T>(sql, args) -> T[], close() -> Promise<void>.
// * The Rust side already opened and ran migrations on startup; load()
//   is a no-op returning the same singleton instance.
class Database {
  private constructor() {}

  static async load(_url: string): Promise<Database> {
    // Rust startup already opened the connection and ran migrations.
    // We do a cheap round-trip so any early breakage surfaces here
    // rather than deep inside a repository call.
    const ok = await invoke<boolean>("db_is_open");
    if (!ok) throw new Error("[db] db_gate not open at load()");
    return _instance;
  }

  async execute(sql: string, args: any[] = []): Promise<{ lastInsertId: number; rowsAffected: number }> {
    return invoke<{ lastInsertId: number; rowsAffected: number }>("db_execute", { sql, args });
  }

  async select<T = any>(sql: string, args: any[] = []): Promise<T> {
    // db_query returns Vec<Map<String, Value>>; callers annotate with
    // arrays of row shapes so the cast lines up.
    return invoke<T>("db_query", { sql, args });
  }

  async close(): Promise<boolean> {
    await invoke("db_close");
    return true;
  }
}

const _instance = new (Database as any)() as Database;
export type { Database };

let _db: Database | null = null;
let _schemaChecked = false;
let _schemaPromise: Promise<void> | null = null;
let _pragmasApplied = false;

// ---------- Concurrency & error-handling primitives ----------
// tauri-plugin-sql uses sqlx with a multi-connection SqlitePool. Several PRAGMAs
// (busy_timeout, foreign_keys) are per-connection in SQLite, so they don't
// propagate to other pooled connections. Combined with JS-side BEGIN/COMMIT
// landing on different physical connections, this causes intermittent
// "database is locked" (code 5) and "transaction within a transaction"
// (code 1) errors — especially on macOS where the pool churns faster.
//
// JS is single-threaded; the simplest correct fix is to serialize every write
// through a Promise chain. Reads run normally (WAL allows concurrent readers).
let _writeTail: Promise<unknown> = Promise.resolve();
export function serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
  const next = _writeTail.then(fn, fn);
  _writeTail = next.catch(() => undefined);
  return next as Promise<T>;
}

// Money rounding helper — keeps every dollar amount written to DB at 2 decimals
// so a year of subtraction/SUM operations never drifts a cent off the T778 total.
export function roundMoney(x: number | null | undefined): number {
  if (x == null || !isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

// Execute a write with automatic retry on SQLITE_BUSY/LOCKED. All writes go
// through here so we don't have to remember to retry at every call site.
export async function execRetry(sql: string, args: any[] = []): Promise<{ lastInsertId: number; rowsAffected: number }> {
  return serializeWrite(async () => {
    const d = await db();
    let lastErr: any = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const r = await d.execute(sql, args);
        return { lastInsertId: r.lastInsertId ?? 0, rowsAffected: r.rowsAffected };
      } catch (e: any) {
        lastErr = e;
        const msg = String(e?.message || e);
        if (!/locked|busy|code: 5|code: 6/i.test(msg)) throw e;
        await new Promise((r) => setTimeout(r, 100 + attempt * 150));
      }
    }
    throw lastErr;
  });
}

// Force WAL checkpoint — call before any file-level backup of the .db so the
// snapshot is complete. Otherwise recent commits live only in echelon.db-wal
// and a restore from the backup silently loses them.
export async function checkpointWal(): Promise<void> {
  try { await (await db()).execute("PRAGMA wal_checkpoint(TRUNCATE)"); }
  catch (e) { console.warn("[db] wal_checkpoint failed:", e); }
}

export async function db(): Promise<Database> {
  if (!_db) _db = await Database.load("sqlite:echelon.db");
  if (!_pragmasApplied) {
    _pragmasApplied = true;
    try {
      // journal_mode=WAL and page_size are persisted in the DB file header, so they
      // apply across all connections regardless of which one issued the PRAGMA.
      await _db.execute("PRAGMA journal_mode = WAL");
      await _db.execute("PRAGMA synchronous = NORMAL");
      await _db.execute("PRAGMA temp_store = MEMORY");
      await _db.execute("PRAGMA mmap_size = 268435456");
      await _db.execute("PRAGMA cache_size = -16000");
      await _db.execute("PRAGMA busy_timeout = 5000");
      // Enforce FK constraints (ON DELETE CASCADE etc). Per-connection, but
      // since we serialize writes through serializeWrite the first connection
      // taken by execRetry sees it; readers don't need FK enforcement.
      await _db.execute("PRAGMA foreign_keys = ON");
      // Truncate WAL on startup so the .db-wal file stays bounded across long
      // desktop sessions, and so any in-progress write from a hard kill is
      // either committed (good) or already rolled back by SQLite recovery.
      try { await _db.execute("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* fine */ }
      // Defensively clear any stale transaction left over from a prior crash.
      try { await _db.execute("ROLLBACK"); } catch { /* no active tx, fine */ }
    } catch (e) { console.warn("[db] pragma setup:", e); }
  }
  if (!_schemaChecked) {
    // Gate on an in-flight promise so N concurrent db() callers all AWAIT the
    // SAME ensureSchema run instead of each firing their own. Parallel DDL
    // (CREATE TABLE, ALTER TABLE) on tauri-plugin-sql's pooled connections
    // deadlocks; the H-9 fix moved `_schemaChecked=true` to after success,
    // which correctly retries on transient failure but reopened the door
    // to concurrent runs. The promise gate closes it: only one ensureSchema
    // actually runs; every other caller awaits the same result and then
    // sees `_schemaChecked=true` on their next pass.
    //
    // IMPORTANT: helpers called from *inside* `ensureSchema` MUST NOT call
    // `db()` — that would await the very promise their own async ancestor
    // owns and self-deadlock. Pass `d: Database` explicitly to any helper
    // reachable from ensureSchema (see `backfillIssuerSnapshot(d)` and the
    // in-scope `execWithRetry` helper).
    if (!_schemaPromise) {
      _schemaPromise = (async () => {
        try {
          await ensureSchema(_db!);
          _schemaChecked = true;
        } catch (e) {
          console.error("[ensureSchema] failed:", e);
          _schemaPromise = null;
          throw e;
        }
      })();
    }
    // Re-throw schema failure to callers so they don't proceed against an
    // un-checked / partial DB. Retry semantics still hold: `_schemaChecked`
    // stayed false and `_schemaPromise` was cleared on failure, so the next
    // `db()` call becomes a fresh leader and re-runs ensureSchema.
    await _schemaPromise;
  }
  return _db;
}

// ---------- Schema safety net ----------
// Tauri-plugin-sql migration tracker has been observed to silently skip pending
// migrations on pre-existing DBs. This idempotently patches anything missing so
// the app self-heals on startup. Add new expectations as schema evolves.
async function ensureSchema(d: Database): Promise<void> {
  // In-scope replacement for `execRetry` for use *inside* ensureSchema. Uses
  // the passed-in `d` directly instead of calling the top-level `execRetry`
  // (which calls `db()` — a re-entrant path that would await our own schema
  // promise and self-deadlock). Retries on SQLITE_BUSY/LOCKED, matching
  // `execRetry`'s behavior for the callers below that used to use it.
  const execWithRetry = async (sql: string, args: any[] = []): Promise<void> => {
    let lastErr: any = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try { await d.execute(sql, args); return; }
      catch (e: any) {
        lastErr = e;
        const msg = String(e?.message || e);
        if (!/locked|busy|code: 5|code: 6/i.test(msg)) throw e;
        await new Promise((r) => setTimeout(r, 100 + attempt * 150));
      }
    }
    throw lastErr;
  };

  // Cache table and column lookups so we don't pay PRAGMA round-trips repeatedly.
  const _tableCache = new Map<string, boolean>();
  const _colCache = new Map<string, Set<string>>();
  const tableExists = async (name: string): Promise<boolean> => {
    if (_tableCache.has(name)) return _tableCache.get(name)!;
    const r = await d.select<{ n: number }[]>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?", [name]
    );
    const v = (r[0]?.n ?? 0) > 0;
    _tableCache.set(name, v);
    return v;
  };
  const colExists = async (table: string, col: string): Promise<boolean> => {
    if (!(await tableExists(table))) return false;
    let cols = _colCache.get(table);
    if (!cols) {
      // Validate identifier before interpolating into PRAGMA (defense-in-depth).
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
        throw new Error(`ensureSchema: invalid table identifier: ${table}`);
      }
      const rows = await d.select<{ name: string }[]>(`PRAGMA table_info(${table})`);
      cols = new Set(rows.map((r) => r.name));
      _colCache.set(table, cols);
    }
    return cols.has(col);
  };
  const addCol = async (table: string, col: string, decl: string) => {
    if (!(await colExists(table, col))) {
      console.warn(`[ensureSchema] adding ${table}.${col}`);
      await d.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
      _colCache.get(table)?.add(col);
    }
  };
  const setting = async (key: string, value: string) => {
    await d.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", [key, value]);
  };

  // Baseline self-heal: if migration 001 was skipped on this DB (we've seen
  // this happen on tauri-plugin-sql's silent-skip path), ensureSchema's first
  // INSERT OR IGNORE INTO settings will throw. CREATE TABLE IF NOT EXISTS for
  // the three baseline tables guards against that.
  await d.execute(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
  await d.execute(`CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    father_name TEXT,
    mother_name TEXT,
    email TEXT,
    year INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await d.execute(`CREATE TABLE IF NOT EXISTS receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_no INTEGER NOT NULL UNIQUE,
    date TEXT NOT NULL,
    student_id INTEGER NOT NULL,
    student_name_snapshot TEXT NOT NULL,
    father_name_snapshot TEXT,
    mother_name_snapshot TEXT,
    description TEXT NOT NULL,
    amount REAL NOT NULL,
    pending_amount REAL NOT NULL DEFAULT 0,
    comments TEXT,
    voided INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (student_id) REFERENCES students(id)
  )`);

  // Migration 002 — pdf_folder
  await setting("pdf_folder", "");
  await setting("reports_folder", "");

  // Migration 003 — email audit + settings
  await addCol("receipts", "emailed_at", "TEXT");
  await addCol("receipts", "emailed_to", "TEXT");
  for (const [k, v] of [
    ["sender_email", ""], ["sender_name", "Echelon Daycare Society"],
    ["smtp_host", "smtp-mail.outlook.com"], ["smtp_port", "587"],
    ["smtp_user", ""], ["bcc_self", "1"],
    ["email_subject", "Receipt #{{receipt_no}} - {{student}} - {{description}}"],
    ["email_body", "Hi,\n\nPlease find attached the receipt for {{student}} ({{description}}).\n\n{{amount_label}}: ${{amount}}{{pending_line}}\n\nThank you,\nEchelon Daycare Society\n{{contact_email}} | {{contact_phone}}"],
  ] as const) await setting(k, v);

  // Migration 004 — person_id, is_refund, annual_receipts
  await addCol("students", "person_id", "TEXT");
  await d.execute("CREATE INDEX IF NOT EXISTS idx_students_person ON students(person_id)");
  await addCol("receipts", "is_refund", "INTEGER DEFAULT 0");
  for (const [k, v] of [
    ["business_number", ""], ["director_name", ""],
    ["director_title", "Managing Director"], ["next_ar_no", "1"],
    ["annual_email_subject", "Annual Child Care Receipt {{year}} - {{student}}"],
    ["annual_email_body",
      "Hi,\n\nPlease find attached the Annual Child Care Receipt for {{student}} covering {{year}} (January through December).\n\nTotal paid in {{year}}: ${{total}} across {{count}} payments.\n\nYou may use this receipt when claiming the Child Care Expenses Deduction (CRA Form T778, Line 21400) on your personal tax return.\n\nIf you notice any discrepancy, please reply to this email and we will reissue.\n\nThank you for trusting us with your child this year.\n\nEchelon Daycare Society\n{{contact_email}} | {{contact_phone}}"],
  ] as const) await setting(k, v);
  if (!(await tableExists("annual_receipts"))) {
    console.warn("[ensureSchema] creating annual_receipts");
    await d.execute(`CREATE TABLE annual_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ar_number TEXT UNIQUE NOT NULL,
      person_id TEXT NOT NULL,
      student_name TEXT NOT NULL,
      father_name TEXT,
      mother_name TEXT,
      calendar_year INTEGER NOT NULL,
      recipient_label TEXT NOT NULL,
      total_amount REAL NOT NULL,
      receipt_count INTEGER NOT NULL,
      receipt_ids_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      issued_at TEXT NOT NULL DEFAULT (datetime('now')),
      emailed_at TEXT,
      emailed_to TEXT,
      superseded_by INTEGER REFERENCES annual_receipts(id),
      notes TEXT
    )`);
    await d.execute("CREATE INDEX IF NOT EXISTS idx_annual_person_year ON annual_receipts(person_id, calendar_year)");
  }

  // Migration 005 — CCFRI + ACCB
  for (const [k, v] of [
    ["subsidies_enabled", "0"],
    ["gross_monthly_fee", ""],
    ["ccfri_monthly_reduction", ""],
    ["subsidy_stmt_subject", "Monthly Fee Breakdown - {{student}} - {{month_label}} {{year}}"],
    ["subsidy_stmt_body",
      "Hi,\n\nPlease find attached the monthly fee breakdown for {{student}} for {{month_label}} {{year}}.\n\nThis shows how the BC government subsidies (CCFRI and any Affordable Child Care Benefit) reduced your gross monthly fee to the amount you actually paid. The amount you paid is what appears on your Annual Tax Receipt for the CRA.\n\nIf you have any questions, please reply to this email.\n\nThank you,\nEchelon Daycare Society\n{{contact_email}} | {{contact_phone}}"],
  ] as const) await setting(k, v);
  await addCol("students", "gross_override", "REAL");
  await addCol("receipts", "gross_amount", "REAL");
  await addCol("receipts", "ccfri_amount", "REAL");
  await addCol("receipts", "accb_amount", "REAL");
  if (!(await tableExists("accb_entries"))) {
    console.warn("[ensureSchema] creating accb_entries");
    await d.execute(`CREATE TABLE accb_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      amount REAL NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(student_id, year, month),
      FOREIGN KEY (student_id) REFERENCES students(id)
    )`);
    await d.execute("CREATE INDEX IF NOT EXISTS idx_accb_student ON accb_entries(student_id)");
    await d.execute("CREATE INDEX IF NOT EXISTS idx_accb_period ON accb_entries(year, month)");
  }

  // Migration 006 — void audit
  await addCol("receipts", "void_reason", "TEXT");
  await addCol("receipts", "voided_at", "TEXT");

  // Migration 007 — issuer snapshot (frozen daycare details per receipt)
  await addCol("receipts", "issuer_snapshot_json", "TEXT");
  await addCol("annual_receipts", "issuer_snapshot_json", "TEXT");
  // Backfill: any pre-existing receipt without a snapshot gets the *current*
  // settings stamped on it. Best-effort — better than letting the PDF re-render
  // with future settings changes.
  await backfillIssuerSnapshot(d);

  // Migration 008 — Staff Hours (optional feature)
  if (!(await tableExists("staff"))) {
    console.warn("[ensureSchema] creating staff");
    await d.execute(`CREATE TABLE staff (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      role TEXT,
      hourly_rate REAL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT
    )`);
    await d.execute("CREATE INDEX IF NOT EXISTS ix_staff_active ON staff(active)");
  }
  if (!(await tableExists("staff_hours"))) {
    console.warn("[ensureSchema] creating staff_hours");
    await d.execute(`CREATE TABLE staff_hours (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      work_date TEXT NOT NULL,
      in_time TEXT,
      out_time TEXT,
      hours_decimal REAL NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'manual',
      sheet_image_path TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(staff_id, work_date)
    )`);
    await d.execute("CREATE INDEX IF NOT EXISTS ix_staff_hours_date ON staff_hours(work_date)");
    await d.execute("CREATE INDEX IF NOT EXISTS ix_staff_hours_staff ON staff_hours(staff_id)");
  }
  for (const [k, v] of [
    ["feature_staff_hours_enabled", ""],
    ["azure_ai_key_set", ""],
    ["staff_default_hourly_rate", ""],
    ["staff_cred_alert_days", "60"],
  ] as const) await setting(k, v);

  // Migration 009 — Staff credentials & drill log
  if (!(await tableExists("staff_credentials"))) {
    console.warn("[ensureSchema] creating staff_credentials");
    await d.execute(`CREATE TABLE staff_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      issued_date TEXT,
      expiry_date TEXT,
      file_path TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await d.execute("CREATE INDEX IF NOT EXISTS ix_staff_credentials_staff ON staff_credentials(staff_id)");
    await d.execute("CREATE INDEX IF NOT EXISTS ix_staff_credentials_expiry ON staff_credentials(expiry_date)");
  }
  if (!(await tableExists("staff_drills"))) {
    console.warn("[ensureSchema] creating staff_drills");
    await d.execute(`CREATE TABLE staff_drills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drill_date TEXT NOT NULL,
      drill_type TEXT NOT NULL,
      duration_min INTEGER,
      children_present INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await d.execute("CREATE INDEX IF NOT EXISTS ix_staff_drills_date ON staff_drills(drill_date)");
  }

  if (!(await tableExists("child_attendance"))) {
    console.warn("[ensureSchema] creating child_attendance");
    await d.execute(`CREATE TABLE child_attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      work_date TEXT NOT NULL,
      in_time TEXT,
      out_time TEXT,
      hours_decimal REAL NOT NULL DEFAULT 0,
      signed_in_by TEXT,
      signed_out_by TEXT,
      status TEXT NOT NULL DEFAULT 'present',
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(student_id, work_date)
    )`);
    await d.execute("CREATE INDEX IF NOT EXISTS ix_child_attendance_date ON child_attendance(work_date)");
    await d.execute("CREATE INDEX IF NOT EXISTS ix_child_attendance_student ON child_attendance(student_id)");
  }

  // Backup bookkeeping (not a real migration — stored in settings)
  for (const [k, v] of [
    ["last_backup_at", ""],
    ["last_backup_path", ""],
    ["last_cloud_backup_at", ""],
    ["last_cloud_backup_month", ""],
    ["last_cloud_backup_recipient", ""],
    ["backup_recipient_email", ""],
    // PIPEDA / consent: default OFF so cloud backup is opt-in.
    ["backup_cloud_enabled", "0"],
    // C-1: encrypted cloud backup passphrase. The passphrase itself lives
    // in the OS keychain (see backup_crypto.rs) — only a non-secret
    // presence flag and an Argon2id verification hash are stored here.
    ["backup_passphrase_set", "0"],
    ["backup_passphrase_hash", ""],
  ] as const) await setting(k, v);

  // Migration 010 — Communications module (group email, templates, history, scheduled)
  if (!(await tableExists("message_templates"))) {
    console.warn("[ensureSchema] creating message_templates");
    await d.execute(`CREATE TABLE message_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'general',
      is_builtin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    // Seed built-in starter templates.
    const seeds: Array<[string, string, string, string]> = [
      ["Holiday Closure", "Echelon Daycare will be closed {{date_range}}",
        "Hi {{parent_name}},\n\nThis is a reminder that Echelon Daycare will be closed from {{date_range}} for {{reason}}. We will reopen on {{reopen_date}}.\n\nPlease make alternate care arrangements for {{student_name}} during this period.\n\nThank you,\n{{daycare_name}}\n{{contact_email}} | {{contact_phone}}",
        "closure"],
      ["Monthly Newsletter", "{{daycare_name}} — {{month}} newsletter",
        "Hi {{parent_name}},\n\nHere's what's happening at {{daycare_name}} in {{month}}:\n\n• \n• \n• \n\nUpcoming dates:\n• \n\nThank you for being part of our community.\n\n{{daycare_name}}\n{{contact_email}} | {{contact_phone}}",
        "newsletter"],
      ["Sick Child Pickup", "Please pick up {{student_name}} — feeling unwell",
        "Hi {{parent_name}},\n\n{{student_name}} isn't feeling well today and we need you to pick them up as soon as possible. Our sick-child policy asks that they stay home until symptom-free for 24 hours.\n\nPlease call {{contact_phone}} when you're on your way.\n\nThank you,\n{{daycare_name}}",
        "reminder"],
      ["Fee Change Notice", "Fee update effective {{effective_date}}",
        "Hi {{parent_name}},\n\nWe're writing to let you know that our monthly fee for {{student_name}}'s program will change effective {{effective_date}}.\n\nNew monthly fee: $\n\nThe change reflects [reason]. If you have any questions or concerns, please reply to this email.\n\nThank you,\n{{daycare_name}}\n{{contact_email}} | {{contact_phone}}",
        "fees"],
      ["Missing Form Reminder", "Reminder: forms outstanding for {{student_name}}",
        "Hi {{parent_name}},\n\nWe're missing the following form(s) for {{student_name}}:\n\n• \n\nPlease drop them off at the front desk or email a scan by {{due_date}}. Provincial licensing requires these to be on file.\n\nThank you,\n{{daycare_name}}\n{{contact_email}} | {{contact_phone}}",
        "forms"],
      ["Field Trip Notice", "Field trip permission: {{trip_name}} on {{trip_date}}",
        "Hi {{parent_name}},\n\nWe've planned a field trip to {{trip_name}} on {{trip_date}}. Departure: {{depart_time}}, return: {{return_time}}. Transportation: {{transport}}. Additional cost: $ .\n\nPlease sign and return the attached permission form by {{signup_deadline}} so {{student_name}} can join.\n\nThank you,\n{{daycare_name}}",
        "general"],
      ["Waitlist – Spot Offered", "Great news — a spot is available for {{student_name}} at {{daycare_name}}",
        "Hi {{parent_name}},\n\nWe're delighted to let you know that a spot has opened up for {{student_name}} at {{daycare_name}}. Based on your application we can offer a start date of {{start_date}}.\n\nTo accept, please reply to this email by {{reply_by}} and we'll send you the enrollment paperwork and first-month invoice. If we don't hear back by that date the spot will be released to the next family on the waitlist.\n\nHappy to answer any questions before you decide — just reply here or call {{contact_phone}}.\n\nWarmly,\n{{daycare_name}}\n{{contact_email}} | {{contact_phone}}",
        "waitlist"],
      ["Waitlist – Still Waiting Check-in", "Checking in about {{student_name}}'s waitlist spot",
        "Hi {{parent_name}},\n\nJust a quick note to let you know {{student_name}} is still on our waitlist at {{daycare_name}}. We don't have an opening yet, but you're still in our list and we wanted to make sure you're still interested.\n\nCould you reply to confirm:\n  1. Yes, please keep {{student_name}} on the waitlist.\n  2. Our situation has changed — please remove us.\n\nAlso let us know if your preferred start date has changed. If we don't hear back within two weeks we'll assume option 2 and archive the application (you can always re-apply).\n\nThank you,\n{{daycare_name}}\n{{contact_email}} | {{contact_phone}}",
        "waitlist"],
      ["Waitlist – No Spot Available", "Update on {{student_name}}'s waitlist application",
        "Hi {{parent_name}},\n\nThank you for your patience while we worked through the waitlist. Unfortunately we don't have a spot for {{student_name}} available at this time and, given our current enrollment, we don't expect one to open in the short term.\n\nIf you'd like we can keep {{student_name}} on the list in case something changes, or archive the application if you've already made other arrangements. Just reply and let us know.\n\nWe wish you the very best in finding great care for {{student_name}}.\n\nWarmly,\n{{daycare_name}}\n{{contact_email}} | {{contact_phone}}",
        "waitlist"],
    ];
    for (const [name, subject, body, kind] of seeds) {
      await d.execute(
        "INSERT INTO message_templates(name, subject, body, kind, is_builtin) VALUES(?,?,?,?,1)",
        [name, subject, body, kind]
      );
    }
  }

  // Idempotently seed newer built-in templates for existing installs
  // (name lookup — no UNIQUE constraint on the column). Adds waitlist
  // starters to DBs created before v1.3.x.
  const laterBuiltins: Array<[string, string, string, string]> = [
    ["Waitlist – Spot Offered", "Great news — a spot is available for {{student_name}} at {{daycare_name}}",
      "Hi {{parent_name}},\n\nWe're delighted to let you know that a spot has opened up for {{student_name}} at {{daycare_name}}. Based on your application we can offer a start date of {{start_date}}.\n\nTo accept, please reply to this email by {{reply_by}} and we'll send you the enrollment paperwork and first-month invoice. If we don't hear back by that date the spot will be released to the next family on the waitlist.\n\nHappy to answer any questions before you decide — just reply here or call {{contact_phone}}.\n\nWarmly,\n{{daycare_name}}\n{{contact_email}} | {{contact_phone}}",
      "waitlist"],
    ["Waitlist – Still Waiting Check-in", "Checking in about {{student_name}}'s waitlist spot",
      "Hi {{parent_name}},\n\nJust a quick note to let you know {{student_name}} is still on our waitlist at {{daycare_name}}. We don't have an opening yet, but you're still in our list and we wanted to make sure you're still interested.\n\nCould you reply to confirm:\n  1. Yes, please keep {{student_name}} on the waitlist.\n  2. Our situation has changed — please remove us.\n\nAlso let us know if your preferred start date has changed. If we don't hear back within two weeks we'll assume option 2 and archive the application (you can always re-apply).\n\nThank you,\n{{daycare_name}}\n{{contact_email}} | {{contact_phone}}",
      "waitlist"],
    ["Waitlist – No Spot Available", "Update on {{student_name}}'s waitlist application",
      "Hi {{parent_name}},\n\nThank you for your patience while we worked through the waitlist. Unfortunately we don't have a spot for {{student_name}} available at this time and, given our current enrollment, we don't expect one to open in the short term.\n\nIf you'd like we can keep {{student_name}} on the list in case something changes, or archive the application if you've already made other arrangements. Just reply and let us know.\n\nWe wish you the very best in finding great care for {{student_name}}.\n\nWarmly,\n{{daycare_name}}\n{{contact_email}} | {{contact_phone}}",
      "waitlist"],
  ];
  for (const [name, subject, body, kind] of laterBuiltins) {
    const existing = await d.select<{ n: number }[]>(
      "SELECT COUNT(*) AS n FROM message_templates WHERE name = ?",
      [name],
    );
    if ((existing[0]?.n ?? 0) === 0) {
      await d.execute(
        "INSERT INTO message_templates(name, subject, body, kind, is_builtin) VALUES(?,?,?,?,1)",
        [name, subject, body, kind],
      );
    }
  }
  if (!(await tableExists("communication_log"))) {
    console.warn("[ensureSchema] creating communication_log");
    await d.execute(`CREATE TABLE communication_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sent_at TEXT NOT NULL DEFAULT (datetime('now')),
      kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT,
      recipient_count INTEGER NOT NULL DEFAULT 1,
      recipients TEXT NOT NULL,
      attachment_names TEXT,
      status TEXT NOT NULL DEFAULT 'sent',
      error TEXT,
      related_id INTEGER
    )`);
    await d.execute("CREATE INDEX IF NOT EXISTS ix_comm_log_sent_at ON communication_log(sent_at DESC)");
    await d.execute("CREATE INDEX IF NOT EXISTS ix_comm_log_kind ON communication_log(kind)");
    // Backfill existing emailed receipts so History shows them from day one.
    try {
      await d.execute(`INSERT INTO communication_log (sent_at, kind, subject, body, recipient_count, recipients, status, related_id)
        SELECT emailed_at, 'receipt',
          'Receipt #' || receipt_no || ' - ' || student_name_snapshot,
          NULL, 1, COALESCE(emailed_to, ''), 'sent', id
        FROM receipts
        WHERE emailed_at IS NOT NULL AND emailed_at != ''`);
      await d.execute(`INSERT INTO communication_log (sent_at, kind, subject, body, recipient_count, recipients, status, related_id)
        SELECT emailed_at, 'annual_receipt',
          'Annual Receipt ' || ar_number || ' - ' || student_name,
          NULL, 1, COALESCE(emailed_to, ''), 'sent', id
        FROM annual_receipts
        WHERE emailed_at IS NOT NULL AND emailed_at != ''`);
    } catch (e) { console.warn("[ensureSchema] comm_log backfill failed:", e); }
  }
  if (!(await tableExists("scheduled_messages"))) {
    console.warn("[ensureSchema] creating scheduled_messages");
    await d.execute(`CREATE TABLE scheduled_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scheduled_for TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      recipient_filter TEXT NOT NULL,
      attachments TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT
    )`);
    await d.execute("CREATE INDEX IF NOT EXISTS ix_sched_status ON scheduled_messages(status, scheduled_for)");
  }

  // Migration 011 — Expenses module (expense entries + recurring templates)
  if (!(await tableExists("expenses"))) {
    console.warn("[ensureSchema] creating expenses");
    await d.execute(`CREATE TABLE expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      category TEXT NOT NULL,
      subcategory TEXT,
      vendor TEXT,
      amount REAL NOT NULL,
      payment_method TEXT NOT NULL,
      reference TEXT,
      notes TEXT,
      recurring_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await d.execute("CREATE INDEX IF NOT EXISTS ix_expenses_date ON expenses(date DESC)");
    await d.execute("CREATE INDEX IF NOT EXISTS ix_expenses_category ON expenses(category)");
    await d.execute("CREATE INDEX IF NOT EXISTS ix_expenses_recurring ON expenses(recurring_id)");
  }
  if (!(await tableExists("recurring_expenses"))) {
    console.warn("[ensureSchema] creating recurring_expenses");
    await d.execute(`CREATE TABLE recurring_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      subcategory TEXT,
      vendor TEXT,
      amount REAL NOT NULL,
      payment_method TEXT NOT NULL,
      frequency TEXT NOT NULL DEFAULT 'monthly',
      day_of_month INTEGER NOT NULL DEFAULT 1,
      start_date TEXT NOT NULL,
      end_date TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      last_posted_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  }

  // Migration 012 — Expense import batches + per-txn source hash + per-period
  // recurring uniqueness. Enables one-click "undo last import" and crash-safe
  // idempotent recurring posting.
  await addCol("expenses", "import_batch_id", "TEXT");
  await addCol("expenses", "source_txn_hash", "TEXT");
  await d.execute("CREATE INDEX IF NOT EXISTS ix_expenses_batch ON expenses(import_batch_id)");
  await d.execute("CREATE UNIQUE INDEX IF NOT EXISTS ix_expenses_source_hash ON expenses(source_txn_hash) WHERE source_txn_hash IS NOT NULL");

  // Deduplicate any pre-existing double-posts before creating the UNIQUE
  // (recurring_id, month) index. Prior to migration-012, postRecurring used an
  // in-row last_posted_date high-water mark that a mid-post crash or two rapid
  // clicks could bypass, leaving multiple expenses for the same recurring bill
  // in the same month. Creating the UNIQUE index against that data would throw
  // and block app startup — so we scrub duplicates first, keeping the earliest.
  await execWithRetry(
    `DELETE FROM expenses
      WHERE recurring_id IS NOT NULL
        AND id NOT IN (
          SELECT MIN(id) FROM expenses
          WHERE recurring_id IS NOT NULL
          GROUP BY recurring_id, substr(date,1,7)
        )`
  ).catch(() => {});
  await d.execute("CREATE UNIQUE INDEX IF NOT EXISTS ix_expenses_recurring_period ON expenses(recurring_id, substr(date,1,7)) WHERE recurring_id IS NOT NULL");

  // Remove obsolete Gemini setting seed (Migration 013 — see azure_ai refactor).
  await execWithRetry("DELETE FROM settings WHERE key='gemini_api_key_set'").catch(() => {});

  // Migration 014 — Per-recipient scheduled-message delivery ledger. Prevents
  // duplicate sends on retry after a partial failure: successful recipients get
  // logged here and skipped on subsequent runDueScheduled ticks.
  await d.execute(`CREATE TABLE IF NOT EXISTS scheduled_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scheduled_id INTEGER NOT NULL,
    recipient_email TEXT NOT NULL,
    status TEXT NOT NULL,           -- 'sent' | 'failed'
    error TEXT,
    attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await d.execute("CREATE INDEX IF NOT EXISTS ix_sched_deliv_msg ON scheduled_deliveries(scheduled_id)");
  await d.execute("CREATE INDEX IF NOT EXISTS ix_sched_deliv_status ON scheduled_deliveries(scheduled_id, recipient_email, status)");

  // Migration 015 — Ask Echelon (natural-language query) saved queries.
  await d.execute(`CREATE TABLE IF NOT EXISTS saved_queries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT NOT NULL,
    sql TEXT NOT NULL,
    chart_hint TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  // M-1: saved_queries used to hard-delete. Soft delete only — not a full
  // Data Contract migration (still an autoincrement PK, not in scope here),
  // just deleted_at + filtered reads so an accidental delete isn't
  // unrecoverable.
  await addCol("saved_queries", "deleted_at", "TEXT");
  // Migration 016 — Log of every question asked, for a "top asked" panel.
  await d.execute(`CREATE TABLE IF NOT EXISTS asked_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT NOT NULL COLLATE NOCASE,
    ask_count INTEGER NOT NULL DEFAULT 1,
    last_asked_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(question) ON CONFLICT IGNORE
  )`);
  await d.execute("CREATE INDEX IF NOT EXISTS ix_asked_top ON asked_questions(ask_count DESC, last_asked_at DESC)");
  for (const [k, v] of [
    ["ask_echelon_enabled", "1"],
    ["ask_echelon_redact",  "1"],
  ] as const) await setting(k, v);

  // Migration 017 — AGM Minutes draft persistence. One row per fiscal-year
  // label ("2024-25"). The draft JSON stores the full form state so a user
  // can walk away mid-edit and come back. `finalized_at` marks the year the
  // .docx was generated (used as carry-forward source for the following year).
  await d.execute(`CREATE TABLE IF NOT EXISTS agm_drafts (
    year_label TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    finalized_at TEXT
  )`);

  // Migration 018 — AGM AI provenance. Every AI drafting call for AGM Minutes
  // is recorded with the full prompt + response so the board can audit what
  // was generated by AI vs. authored by a human. Data stays local; nothing is
  // exfiltrated. Purge policy: manual for now.
  await d.execute(`CREATE TABLE IF NOT EXISTS agm_ai_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year_label TEXT,
    section TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_text TEXT NOT NULL,
    response_text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await d.execute("CREATE INDEX IF NOT EXISTS ix_agm_ai_events_year ON agm_ai_events(year_label, created_at DESC)");

  // M-7: agm_ai_events had no purge policy and could grow unbounded (every
  // AI drafting call stores the full prompt + response text). Purge rows
  // older than 180 days on each startup. Note: if the board wants a longer
  // audit-retention window than ~6 months, bump this constant rather than
  // remove the purge entirely.
  try {
    await d.execute("DELETE FROM agm_ai_events WHERE created_at < datetime('now', '-180 days')");
  } catch (e) { console.warn("[ensureSchema] agm_ai_events purge failed:", e); }

  // AGM AI opt-in — defaults OFF so packaged builds don't call Azure until the
  // user explicitly turns it on in Settings.
  await setting("agm_ai_enabled", "0");
  // AGM AI redact — defaults ON: staff names replaced with Staff #N tokens in
  // prompts. Users can turn this off if they want richer prose.
  await setting("agm_ai_redact", "1");

  // ─── Waitlist Sync (v0.8.0) ────────────────────────────────────────
  // Google Sheets → local mirror. Service-account JSON stays in Keychain,
  // never in SQLite. See src-tauri/src/waitlist.rs.
  if (!(await tableExists("waitlist_entries"))) {
    console.warn("[ensureSchema] creating waitlist_entries");
  }
  await d.execute(`CREATE TABLE IF NOT EXISTS waitlist_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key TEXT UNIQUE NOT NULL,
    sheet_row_hash TEXT NOT NULL,
    submitted_at TEXT NOT NULL,
    child_name TEXT NOT NULL,
    birthday TEXT,
    gender TEXT,
    parent_name TEXT,
    parent_email TEXT,
    phone TEXT,
    target_start TEXT,
    toilet_trained INTEGER,
    in_building INTEGER,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    status_note TEXT,
    status_changed_at TEXT,
    last_seen_in_sheet TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    converted_student_id INTEGER
  )`);
  await d.execute("CREATE INDEX IF NOT EXISTS idx_waitlist_status ON waitlist_entries(status)");
  await d.execute("CREATE INDEX IF NOT EXISTS idx_waitlist_dedupe ON waitlist_entries(dedupe_key)");

  await d.execute(`CREATE TABLE IF NOT EXISTS waitlist_sync_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_synced_at TEXT,
    last_success_at TEXT,
    last_error TEXT,
    row_count INTEGER DEFAULT 0
  )`);
  await d.execute("INSERT OR IGNORE INTO waitlist_sync_state (id) VALUES (1)");

  for (const [k, v] of [
    // Deployment-specific; blank by default. Set via Settings → Waitlist.
    ["waitlist_sheet_id", ""],
    ["waitlist_sheet_range", "FormResponse!A:K"],
    ["waitlist_sync_enabled", "1"],
    ["waitlist_sync_interval_min", "720"],
    ["waitlist_last_synced_at", ""],
  ] as const) await setting(k, v);

  // One-time migration: sheet tab was renamed from "Form_Responses" to
  // "FormResponse". If an existing install still has the old default, replace
  // it (but leave any user-customized range untouched).
  await d.execute(
    "UPDATE settings SET value = 'FormResponse!A:K' WHERE key = 'waitlist_sheet_range' AND value = 'Form_Responses!A:K'"
  );

  // ─── Migration 019 — Document Vault (v1.1.0) ──────────────────────────
  // First module built on the Phase-2 Data Contract: UUID PKs, UTC ISO
  // timestamps, soft delete + optimistic concurrency + per-entity event
  // log. Blob content is content-addressed (SHA-256) so re-uploads
  // dedupe automatically; entity rows only reference blob_key.
  if (!(await tableExists("blobs"))) {
    console.warn("[ensureSchema] creating blobs");
    await d.execute(`CREATE TABLE blobs (
      blob_key    TEXT PRIMARY KEY,
      content     BLOB NOT NULL,
      size_bytes  INTEGER NOT NULL,
      mime_type   TEXT,
      ref_count   INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL
    )`);
  }
  if (!(await tableExists("documents"))) {
    console.warn("[ensureSchema] creating documents");
    await d.execute(`CREATE TABLE documents (
      id                 TEXT PRIMARY KEY,
      title              TEXT NOT NULL,
      category           TEXT NOT NULL,
      linked_kind        TEXT,
      linked_id          TEXT,
      blob_key           TEXT NOT NULL,
      file_name          TEXT NOT NULL,
      mime_type          TEXT NOT NULL,
      size_bytes         INTEGER NOT NULL,
      issued_date        TEXT,
      expiry_date        TEXT,
      issuer             TEXT,
      reference_no       TEXT,
      notes              TEXT,
      tags_json          TEXT NOT NULL DEFAULT '[]',
      parent_document_id TEXT,
      version_no         INTEGER NOT NULL DEFAULT 1,
      is_current         INTEGER NOT NULL DEFAULT 1,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL,
      updated_by         TEXT NOT NULL DEFAULT 'owner',
      version            INTEGER NOT NULL DEFAULT 1,
      deleted_at         TEXT
    )`);
    await d.execute("CREATE INDEX ix_documents_category ON documents(category) WHERE deleted_at IS NULL");
    await d.execute("CREATE INDEX ix_documents_expiry   ON documents(expiry_date) WHERE deleted_at IS NULL AND is_current = 1");
    await d.execute("CREATE INDEX ix_documents_linked   ON documents(linked_kind, linked_id) WHERE deleted_at IS NULL");
    await d.execute("CREATE INDEX ix_documents_current  ON documents(parent_document_id, version_no)");
  }
  if (!(await tableExists("document_events"))) {
    console.warn("[ensureSchema] creating document_events");
    await d.execute(`CREATE TABLE document_events (
      id           TEXT PRIMARY KEY,
      entity_id    TEXT NOT NULL,
      event_type   TEXT NOT NULL,
      payload_json TEXT,
      actor        TEXT NOT NULL,
      channel      TEXT,
      message_ref  TEXT,
      created_at   TEXT NOT NULL
    )`);
    await d.execute("CREATE INDEX ix_document_events_entity ON document_events(entity_id, created_at)");
  }
  // Link column on existing staff_credentials so a credential can point at
  // its source PDF in the Vault (integration hook — see StaffCredentials.tsx).
  await addCol("staff_credentials", "document_id", "TEXT");

  // ─── Migration 020 — Staff Schedule (v1.2.0) ──────────────────────────
  // Grid-based weekly shift editor + wa.me publish pipeline. Every
  // mutation writes to staff_shift_events (see Data Contract §5). One
  // row in staff_weekly_publish per (staff, week_start_date).
  if (!(await tableExists("staff_shifts"))) {
    console.warn("[ensureSchema] creating staff_shifts");
    await d.execute(`CREATE TABLE staff_shifts (
      id             TEXT PRIMARY KEY,
      staff_id       TEXT NOT NULL,
      shift_date     TEXT NOT NULL,
      start_time     TEXT NOT NULL,
      end_time       TEXT NOT NULL,
      room           TEXT,
      break_minutes  INTEGER NOT NULL DEFAULT 0,
      notes          TEXT,
      status         TEXT NOT NULL DEFAULT 'planned',
      revision_of    TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      updated_by     TEXT NOT NULL DEFAULT 'owner',
      version        INTEGER NOT NULL DEFAULT 1,
      deleted_at     TEXT
    )`);
    await d.execute("CREATE INDEX ix_staff_shifts_date  ON staff_shifts(shift_date) WHERE deleted_at IS NULL");
    await d.execute("CREATE INDEX ix_staff_shifts_staff ON staff_shifts(staff_id, shift_date) WHERE deleted_at IS NULL");
  }
  if (!(await tableExists("staff_shift_events"))) {
    console.warn("[ensureSchema] creating staff_shift_events");
    await d.execute(`CREATE TABLE staff_shift_events (
      id           TEXT PRIMARY KEY,
      entity_id    TEXT NOT NULL,
      event_type   TEXT NOT NULL,
      payload_json TEXT,
      actor        TEXT NOT NULL DEFAULT 'owner',
      channel      TEXT,
      message_ref  TEXT,
      created_at   TEXT NOT NULL
    )`);
    await d.execute("CREATE INDEX ix_shift_events_entity ON staff_shift_events(entity_id, created_at)");
  }
  if (!(await tableExists("staff_weekly_publish"))) {
    console.warn("[ensureSchema] creating staff_weekly_publish");
    await d.execute(`CREATE TABLE staff_weekly_publish (
      id                 TEXT PRIMARY KEY,
      staff_id           TEXT NOT NULL,
      week_start_date    TEXT NOT NULL,
      shift_ids_json     TEXT NOT NULL,
      message_body       TEXT NOT NULL,
      wa_me_url          TEXT NOT NULL,
      published_at       TEXT NOT NULL,
      acknowledged_at    TEXT,
      ack_notes          TEXT,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL,
      updated_by         TEXT NOT NULL DEFAULT 'owner',
      version            INTEGER NOT NULL DEFAULT 1,
      deleted_at         TEXT,
      UNIQUE(staff_id, week_start_date)
    )`);
  }
  await addCol("staff", "whatsapp_phone_e164", "TEXT");
  for (const [k, v] of [
    ["shift_msg_weekly",
`Hi {{staff_first_name}},

Here is your schedule for {{week_range}}:

{{shift_lines}}

Total: {{total_hours}}h

Please reply YES to confirm, or let me know if you need any changes.

Thanks,
{{owner_first_name}}`],
    ["shift_msg_change",
`Hi {{staff_first_name}},

Quick change to your {{shift_date_pretty}} shift:

Was:  {{old_shift}}
Now:  {{new_shift}}

Please reply YES to confirm.

Thanks,
{{owner_first_name}}`],
    ["shift_msg_cancel",
`Hi {{staff_first_name}},

Your {{shift_date_pretty}} shift ({{old_shift}}) has been cancelled.

Reason: {{reason_or_none}}

Thanks,
{{owner_first_name}}`],
  ] as const) await setting(k, v);

  // ─── Migration 021 — Organizer / Ops Dashboard (v1.3.0) ───────────────
  // Panels 2+3 tables (Upcoming panel is view-only, no schema).
  if (!(await tableExists("meetings"))) {
    console.warn("[ensureSchema] creating meetings");
    await d.execute(`CREATE TABLE meetings (
      id                TEXT PRIMARY KEY,
      meeting_date      TEXT NOT NULL,
      meeting_time      TEXT,
      kind              TEXT NOT NULL,
      subject           TEXT NOT NULL,
      attendees_text    TEXT,
      linked_kind       TEXT,
      linked_id         TEXT,
      notes_md          TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      updated_by        TEXT NOT NULL DEFAULT 'owner',
      version           INTEGER NOT NULL DEFAULT 1,
      deleted_at        TEXT
    )`);
    await d.execute("CREATE INDEX ix_meetings_date ON meetings(meeting_date DESC) WHERE deleted_at IS NULL");
    await d.execute("CREATE INDEX ix_meetings_linked ON meetings(linked_kind, linked_id) WHERE deleted_at IS NULL");
  }
  if (!(await tableExists("meeting_actions"))) {
    console.warn("[ensureSchema] creating meeting_actions");
    await d.execute(`CREATE TABLE meeting_actions (
      id            TEXT PRIMARY KEY,
      meeting_id    TEXT NOT NULL,
      description   TEXT NOT NULL,
      owner_text    TEXT,
      due_date      TEXT,
      done_at       TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      updated_by    TEXT NOT NULL DEFAULT 'owner',
      version       INTEGER NOT NULL DEFAULT 1,
      deleted_at    TEXT
    )`);
    await d.execute("CREATE INDEX ix_meeting_actions_meeting ON meeting_actions(meeting_id) WHERE deleted_at IS NULL");
    await d.execute("CREATE INDEX ix_meeting_actions_open ON meeting_actions(due_date) WHERE deleted_at IS NULL AND done_at IS NULL");
  }
  if (!(await tableExists("meeting_events"))) {
    console.warn("[ensureSchema] creating meeting_events");
    await d.execute(`CREATE TABLE meeting_events (
      id           TEXT PRIMARY KEY,
      entity_id    TEXT NOT NULL,
      event_type   TEXT NOT NULL,
      payload_json TEXT,
      actor        TEXT NOT NULL DEFAULT 'owner',
      channel      TEXT,
      message_ref  TEXT,
      created_at   TEXT NOT NULL
    )`);
  }
  if (!(await tableExists("followups"))) {
    console.warn("[ensureSchema] creating followups");
    await d.execute(`CREATE TABLE followups (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      notes         TEXT,
      due_date      TEXT,
      priority      TEXT NOT NULL DEFAULT 'normal',
      linked_kind   TEXT,
      linked_id     TEXT,
      done_at       TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      updated_by    TEXT NOT NULL DEFAULT 'owner',
      version       INTEGER NOT NULL DEFAULT 1,
      deleted_at    TEXT
    )`);
    await d.execute("CREATE INDEX ix_followups_open ON followups(due_date) WHERE deleted_at IS NULL AND done_at IS NULL");
  }
  for (const [k, v] of [
    ["drill_cadence_fire_days", "30"],
    ["drill_cadence_earthquake_days", "90"],
    ["drill_cadence_lockdown_days", "90"],
    ["drill_cadence_evacuation_days", "180"],
  ] as const) await setting(k, v);

  // ─── Migration 022 — Waitlist Prioritization (v1.4.0) ─────────────────
  // Additive columns on waitlist_entries capturing owner-editable operational
  // signals used by the priority score (see src/lib/waitlist.ts). All nullable;
  // absence just means "no bonus for that signal" — safe on existing rows.
  //   full_time            1 if the family wants full-time, 0 for part-time
  //   days_per_week        0–5 (dominant signal — overrides full_time if set)
  //   sibling_student_id   FK-lite into students(id); enables sibling bonus
  //   priority_notes       owner memo about the priority call (audit)
  await addCol("waitlist_entries", "full_time", "INTEGER");
  await addCol("waitlist_entries", "days_per_week", "INTEGER");
  await addCol("waitlist_entries", "sibling_student_id", "INTEGER");
  await addCol("waitlist_entries", "priority_notes", "TEXT");

  // Weight settings — owner-tunable via /waitlist/settings. Stored as strings
  // (settings table is TEXT-typed), parsed as Number() in loadPriorityWeights.
  // Defaults are chosen so an in-building, toilet-trained 3-yr-old with a
  // current-family sibling comfortably outranks a fresh unrelated applicant.
  for (const [k, v] of [
    ["waitlist_weight_retention_per_month", "3"],
    ["waitlist_weight_toilet_trained",       "15"],
    ["waitlist_weight_in_building",          "20"],
    ["waitlist_weight_sibling_current",      "30"],
    ["waitlist_weight_sibling_alumni",       "10"],
    ["waitlist_weight_wait_day",             "0.1"],
    ["waitlist_weight_days_per_week",        "3"],
  ] as const) await setting(k, v);

  // ─── Migration 023 — Notification Bell (v1.5.0) ───────────────────────
  // Global notification centre. See prompt file in the session folder for
  // the full contract. Dedup_key = deterministic composite so a notification
  // for the same source at the same tier is upserted, but escalation to a
  // stricter tier produces a NEW row (user sees the reminder ratchet up).
  if (!(await tableExists("notifications"))) {
    console.warn("[ensureSchema] creating notifications");
    await d.execute(`CREATE TABLE notifications (
      id             TEXT PRIMARY KEY,
      category       TEXT NOT NULL,
      severity       TEXT NOT NULL,
      title          TEXT NOT NULL,
      body           TEXT,
      source_kind    TEXT,
      source_id      TEXT,
      action_route   TEXT,
      dedup_key      TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      read_at        TEXT,
      dismissed_at   TEXT,
      snoozed_until  TEXT,
      version        INTEGER NOT NULL DEFAULT 1,
      deleted_at     TEXT
    )`);
    await d.execute("CREATE UNIQUE INDEX ux_notifications_dedup ON notifications(dedup_key) WHERE deleted_at IS NULL");
    await d.execute("CREATE INDEX ix_notifications_unread ON notifications(created_at DESC) WHERE deleted_at IS NULL AND read_at IS NULL AND dismissed_at IS NULL");
    await d.execute("CREATE INDEX ix_notifications_category ON notifications(category) WHERE deleted_at IS NULL");
  }
  if (!(await tableExists("notification_settings"))) {
    console.warn("[ensureSchema] creating notification_settings");
    await d.execute(`CREATE TABLE notification_settings (
      category           TEXT PRIMARY KEY,
      enabled            INTEGER NOT NULL DEFAULT 1,
      desktop_enabled    INTEGER NOT NULL DEFAULT 0,
      min_severity       TEXT NOT NULL DEFAULT 'info',
      updated_at         TEXT NOT NULL
    )`);
  }
  if (!(await tableExists("notification_events"))) {
    console.warn("[ensureSchema] creating notification_events");
    await d.execute(`CREATE TABLE notification_events (
      id           TEXT PRIMARY KEY,
      entity_id    TEXT NOT NULL,
      event_type   TEXT NOT NULL,
      payload_json TEXT,
      actor        TEXT NOT NULL DEFAULT 'owner',
      channel      TEXT,
      message_ref  TEXT,
      created_at   TEXT NOT NULL
    )`);
    await d.execute("CREATE INDEX ix_notification_events_entity ON notification_events(entity_id, created_at)");
  }
  // Reminder-date settings: stored as MM-DD (no year) so they auto-repeat
  // annually. Empty string means "not configured yet" and the scanner skips.
  // ccfri_claim_day_of_month is 1-28 (day-of-month only, monthly cadence).
  // quiet_hours_start / _end are HH:MM 24h, empty = always on.
  // last_backup_error is written by cloudBackup on failure, cleared on success.
  for (const [k, v] of [
    ["notif_agm_reminder_mmdd",       ""],
    ["notif_tslip_reminder_mmdd",     "02-28"],
    ["notif_ccfri_claim_day_of_month","15"],
    ["notif_wcb_days",                "04-20,07-20,10-20,01-20"],
    ["notif_staff_meeting_days",      "08-31,11-30,02-28,05-31"],
    ["notif_remittance_day_of_month", "12"],
    ["notif_quiet_hours_start",       ""],
    ["notif_quiet_hours_end",         ""],
    ["notif_last_scan_at",            ""],
    ["last_backup_error",             ""],
  ] as const) await setting(k, v);

  // H-12: notifications gained soft-delete/version columns at creation but
  // never got the `updated_at`/`updated_by` pair every other Data-Contract
  // table has — self-heal them in rather than a new migration number.
  await addCol("notifications", "updated_at", "TEXT");
  await addCol("notifications", "updated_by", "TEXT NOT NULL DEFAULT 'owner'");

  // H-1: follow-ups had no audit trail table at all. Data Contract §5 —
  // every state-changing mutation on a user-facing entity needs one.
  if (!(await tableExists("followup_events"))) {
    console.warn("[ensureSchema] creating followup_events");
    await d.execute(`CREATE TABLE followup_events (
      id           TEXT PRIMARY KEY,
      entity_id    TEXT NOT NULL,
      event_type   TEXT NOT NULL,
      payload_json TEXT,
      actor        TEXT NOT NULL DEFAULT 'owner',
      channel      TEXT,
      message_ref  TEXT,
      created_at   TEXT NOT NULL
    )`);
    await d.execute("CREATE INDEX ix_followup_events_entity ON followup_events(entity_id, created_at)");
  }

  // M-11: meeting_events had no lookup index (unlike every sibling
  // <entity>_events table), making "audit trail for this meeting" scans a
  // full table scan as the log grows.
  await d.execute("CREATE INDEX IF NOT EXISTS ix_meeting_events_entity ON meeting_events(entity_id, created_at)");

  // M-10: SQLite can't ALTER TABLE ADD CONSTRAINT, so `documents.blob_key`
  // and `meeting_actions.meeting_id` (added before either referenced table
  // existed, in the case of documents/blobs) have no declared FK — and
  // PRAGMA foreign_key_check only inspects *declared* FKs. Run our own
  // orphan check plus the built-in one, and just log — this is a startup
  // diagnostic, not an enforcement mechanism (out of scope to migrate
  // existing rows here).
  // ─── Migration 024 — Deposit Slips (v1.7.0) ───────────────────────────
  // Tracks which cheque/cash receipts have been physically deposited at the
  // bank so a printable TD-style deposit slip can be produced. Deposits are
  // append-only from the app's perspective; voiding is a status flip, not
  // a delete (rule: never delete data).
  if (!(await tableExists("deposits"))) {
    console.warn("[ensureSchema] creating deposits");
    await d.execute(`CREATE TABLE deposits (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      deposit_date  TEXT NOT NULL,
      cheque_count  INTEGER NOT NULL DEFAULT 0,
      total_amount  REAL NOT NULL DEFAULT 0,
      notes         TEXT,
      voided        INTEGER NOT NULL DEFAULT 0,
      voided_at     TEXT,
      void_reason   TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await d.execute("CREATE INDEX ix_deposits_date ON deposits(deposit_date DESC)");
  }
  await addCol("receipts", "deposited_at", "TEXT");
  await addCol("receipts", "deposit_id",   "INTEGER REFERENCES deposits(id)");
  await d.execute("CREATE INDEX IF NOT EXISTS ix_receipts_deposit ON receipts(deposit_id)");

  // ─── Migration 025 — Organizer Voice Capture (v1.8.0) ─────────────────
  // Voice-dictated meetings/followups/action items. The transcript+parse
  // round-trip is audited to organizer_ai_events so the owner can review
  // what the model heard/inferred. Transcripts are hashed by default
  // (sha256); the raw text is only kept when
  // organizer_ai_store_transcripts=1. 180-day rolling purge, same as
  // agm_ai_events.
  if (!(await tableExists("organizer_ai_events"))) {
    console.warn("[ensureSchema] creating organizer_ai_events");
    await d.execute(`CREATE TABLE organizer_ai_events (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      kind           TEXT NOT NULL,
      prompt_hash    TEXT,
      prompt_text    TEXT,
      response_text  TEXT,
      latency_ms     INTEGER,
      error          TEXT
    )`);
    await d.execute("CREATE INDEX ix_organizer_ai_events_created ON organizer_ai_events(created_at DESC)");
  }
  // 180-day rolling purge — matches the agm_ai_events retention.
  await d.execute("DELETE FROM organizer_ai_events WHERE created_at < datetime('now', '-180 days')");

  for (const [k, v] of [
    ["azure_whisper_endpoint",           ""],
    ["azure_whisper_key_set",            ""],
    ["voice_organizer_enabled",          "1"],
    ["organizer_ai_store_transcripts",   ""],
  ] as const) await setting(k, v);

  // ─── Migration 026 — Staff Meeting Notes (v1.8.0) ────────────────────
  // Persistent record of staff meetings: title, date, agenda, notes, who
  // attended, and structured action items. Meetings are never hard-deleted
  // (history-of-record rule); voiding is a status flip. Action items are
  // in a separate table so we can later surface "my open action items" per
  // staff member without JSON parsing.
  if (!(await tableExists("staff_meetings"))) {
    console.warn("[ensureSchema] creating staff_meetings");
    await d.execute(`CREATE TABLE staff_meetings (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_date    TEXT NOT NULL,
      title           TEXT NOT NULL,
      agenda          TEXT,
      notes           TEXT,
      attendees_json  TEXT,
      voided          INTEGER NOT NULL DEFAULT 0,
      voided_at       TEXT,
      void_reason     TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await d.execute("CREATE INDEX ix_staff_meetings_date ON staff_meetings(meeting_date DESC)");
  }
  if (!(await tableExists("staff_meeting_actions"))) {
    console.warn("[ensureSchema] creating staff_meeting_actions");
    await d.execute(`CREATE TABLE staff_meeting_actions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id      INTEGER NOT NULL REFERENCES staff_meetings(id),
      text            TEXT NOT NULL,
      owner_staff_id  INTEGER REFERENCES staff(id),
      due_date        TEXT,
      done            INTEGER NOT NULL DEFAULT 0,
      done_at         TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await d.execute("CREATE INDEX ix_staff_meeting_actions_mtg ON staff_meeting_actions(meeting_id)");
    await d.execute("CREATE INDEX ix_staff_meeting_actions_open ON staff_meeting_actions(done, owner_staff_id)");
  }

  await logIntegrityWarnings(d);
}

async function logIntegrityWarnings(d: Database): Promise<void> {
  try {
    const orphanBlobs = await d.select<{ n: number }[]>(
      `SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NULL AND blob_key NOT IN (SELECT blob_key FROM blobs)`
    );
    if ((orphanBlobs[0]?.n ?? 0) > 0) {
      console.warn(`[ensureSchema] integrity: ${orphanBlobs[0].n} live document(s) reference a missing blob_key`);
    }
  } catch (e) { console.warn("[ensureSchema] documents/blobs orphan check failed:", e); }
  try {
    const orphanActions = await d.select<{ n: number }[]>(
      `SELECT COUNT(*) AS n FROM meeting_actions WHERE deleted_at IS NULL AND meeting_id NOT IN (SELECT id FROM meetings)`
    );
    if ((orphanActions[0]?.n ?? 0) > 0) {
      console.warn(`[ensureSchema] integrity: ${orphanActions[0].n} live meeting_action(s) reference a missing meeting_id`);
    }
  } catch (e) { console.warn("[ensureSchema] meeting_actions/meetings orphan check failed:", e); }
  try {
    const violations = await d.select<Record<string, unknown>[]>("PRAGMA foreign_key_check");
    if (violations.length > 0) {
      console.warn(`[ensureSchema] PRAGMA foreign_key_check found ${violations.length} violation(s):`, violations);
    }
  } catch (e) { console.warn("[ensureSchema] foreign_key_check failed:", e); }
}

// ---------- Person identity ----------
// Stable ID for the same human across roster years.
// Built from normalized name + parents so siblings or same-first-name kids don't merge.
function norm(s: string | null | undefined): string {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim().replace(/[^\p{L}\p{N} ]/gu, "");
}
export function personIdFor(name: string, father?: string | null, mother?: string | null): string {
  const seed = `${norm(name)}|${norm(father)}|${norm(mother)}`;
  // simple deterministic 8-char hash (DJB2)
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h) ^ seed.charCodeAt(i);
  const hex = (h >>> 0).toString(16).padStart(8, "0");
  return `P-${hex}`;
}

// ---------- Settings ----------
let _settingsCache: SettingsMap | null = null;
// Bulk version — small loop of upserts via execRetry. We deliberately do NOT
// wrap this in BEGIN/COMMIT: tauri-plugin-sql pools connections, so a JS-side
// BEGIN may execute on a different physical connection than the subsequent
// INSERTs, leading to code 5 (locked) or code 1 (transaction within a
// transaction). serializeWrite inside execRetry ensures the upserts happen
// in order. Each upsert is independently atomic.
export async function setSettings(entries: Record<string, string>) {
  const keys = Object.keys(entries);
  if (keys.length === 0) return;
  try {
    for (const k of keys) {
      await execRetry(
        "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [k, entries[k] ?? ""]
      );
      if (_settingsCache) _settingsCache[k] = entries[k] ?? "";
    }
  } catch (e) {
    // If any write failed, the in-memory cache may now disagree with disk.
    // Invalidate so the next getSettings() re-reads truth from DB.
    _settingsCache = null;
    throw e;
  }
}

// Bulk ACCB lookup for a single month — replaces N+1 calls in ThisMonth.
export async function getAccbForMonthBulk(year: number, month: number): Promise<Map<number, number>> {
  const rows = await (await db()).select<{ student_id: number; amount: number }[]>(
    "SELECT student_id, amount FROM accb_entries WHERE year=? AND month=?",
    [year, month]
  );
  const m = new Map<number, number>();
  rows.forEach((r) => m.set(r.student_id, r.amount));
  return m;
}

export async function getSettings(): Promise<SettingsMap> {
  if (_settingsCache) return _settingsCache;
  const rows = await (await db()).select<{ key: string; value: string }[]>(
    "SELECT key, value FROM settings"
  );
  const m: SettingsMap = {};
  rows.forEach((r) => (m[r.key] = r.value ?? ""));
  _settingsCache = m;
  return m;
}
export function invalidateSettingsCache() { _settingsCache = null; }
export async function setSetting(key: string, value: string) {
  await execRetry(
    "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [key, value]
  );
  if (_settingsCache) _settingsCache[key] = value;
}
export async function nextReceiptNo(): Promise<number> {
  const s = await getSettings();
  return parseInt(s.next_receipt_no || "1001", 10);
}
export async function bumpReceiptNo(used: number) {
  await setSetting("next_receipt_no", String(used + 1));
}
// Atomic-ish: bump first, then return the pre-bump number. If the caller's
// INSERT crashes between this call and committing the AR, we leak one AR
// number (acceptable — auditable gap) instead of producing two ARs with the
// same number (a UNIQUE constraint violation that fails the user's save).
// serializeWrite ensures concurrent generate-all loops don't interleave.
export async function nextAnnualReceiptNumber(year: number): Promise<string> {
  return serializeWrite(async () => {
    const s = await getSettings();
    const n = parseInt(s.next_ar_no || "1", 10);
    // Use raw d.execute here — we already hold the serialize lock; recursing
    // through execRetry would deadlock on _writeTail.
    const d = await db();
    await d.execute(
      "INSERT INTO settings(key,value) VALUES('next_ar_no',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [String(n + 1)]
    );
    if (_settingsCache) _settingsCache["next_ar_no"] = String(n + 1);
    return `AR-${year}-${String(n).padStart(4, "0")}`;
  });
}

// ---------- Students ----------
export async function listStudents(year?: number, activeOnly = true): Promise<Student[]> {
  let sql = "SELECT * FROM students WHERE 1=1";
  const args: any[] = [];
  if (year) { sql += " AND year=?"; args.push(year); }
  if (activeOnly) sql += " AND active=1";
  sql += " ORDER BY name COLLATE NOCASE";
  return await (await db()).select<Student[]>(sql, args);
}
export async function listYears(): Promise<number[]> {
  const rows = await (await db()).select<{ year: number }[]>(
    "SELECT DISTINCT year FROM students ORDER BY year DESC"
  );
  return rows.map((r) => r.year);
}
export async function upsertStudent(s: Partial<Student> & { name: string; year: number }): Promise<{ id: number }> {
  const pid = s.person_id || personIdFor(s.name, s.father_name, s.mother_name);
  const grossOv = s.gross_override === undefined ? null : (s.gross_override == null ? null : roundMoney(Number(s.gross_override)));
  if (s.id) {
    await execRetry(
      "UPDATE students SET name=?, father_name=?, mother_name=?, email=?, year=?, active=?, person_id=?, gross_override=? WHERE id=?",
      [s.name, s.father_name ?? null, s.mother_name ?? null, s.email ?? null, s.year, s.active ?? 1, pid, grossOv, s.id]
    );
    return { id: s.id };
  }
  const res = await execRetry(
    "INSERT INTO students(name,father_name,mother_name,email,year,active,person_id,gross_override) VALUES(?,?,?,?,?,1,?,?)",
    [s.name, s.father_name ?? null, s.mother_name ?? null, s.email ?? null, s.year, pid, grossOv]
  );
  // Tauri SQL plugin returns { lastInsertId, rowsAffected }. Fall back to
  // person_id lookup if the runtime doesn't expose lastInsertId for some reason.
  const inserted = (res as any)?.lastInsertId;
  if (typeof inserted === "number" && inserted > 0) return { id: inserted };
  const rows = await (await db()).select<{ id: number }[]>(
    "SELECT id FROM students WHERE person_id=? AND year=? ORDER BY id DESC LIMIT 1",
    [pid, s.year],
  );
  return { id: rows[0]?.id ?? 0 };
}
export async function deleteStudent(id: number) {
  await execRetry("UPDATE students SET active=0 WHERE id=?", [id]);
}
export async function reactivateStudent(id: number) {
  await execRetry("UPDATE students SET active=1 WHERE id=?", [id]);
}

// Persist an updated email to every student row that shares this person_id
// (a family may appear across multiple years). Returns rows updated.
export async function updateStudentEmailByPerson(personId: string, email: string): Promise<number> {
  const clean = email.trim();
  await execRetry("UPDATE students SET email=? WHERE person_id=?", [clean || null, personId]);
  const r = await (await db()).select<{ n: number }[]>(
    "SELECT COUNT(*) AS n FROM students WHERE person_id=?", [personId]
  );
  return r[0]?.n ?? 0;
}

// Hard-delete a student and everything attached to them. Two-step by design:
//   1) Called with force=false → returns receiptCount without deleting.
//   2) Called with force=true  → wipes accb_entries, child_attendance,
//      annual_receipts, receipts, then the student row itself.
// This is destructive and CRA-relevant; UI must confirm loudly before force=true.
export async function hardDeleteStudent(
  id: number,
  force = false
): Promise<{ deleted: boolean; receiptCount: number }> {
  const d = await db();
  const rc = await d.select<{ n: number }[]>(
    "SELECT COUNT(*) AS n FROM receipts WHERE student_id=?",
    [id]
  );
  const receiptCount = rc[0]?.n ?? 0;
  if (receiptCount > 0 && !force) {
    return { deleted: false, receiptCount };
  }
  await serializeWrite(async () => {
    // Collect person_id first so we can also drop any annual receipts pinned
    // to this student. Annual receipts key off person_id, not student_id.
    const d = await db();
    const pidRow = await d.select<{ person_id: string | null }[]>(
      "SELECT person_id FROM students WHERE id=?",
      [id]
    );
    const personId = pidRow[0]?.person_id || null;
    // Use raw execute here — the outer serializeWrite already provides the
    // serialization guarantee, and re-entering serializeWrite (via execRetry)
    // from inside itself deadlocks the write-tail Promise chain.
    await d.execute("DELETE FROM accb_entries WHERE student_id=?", [id]);
    await d.execute("DELETE FROM child_attendance WHERE student_id=?", [id]);
    await d.execute("DELETE FROM receipts WHERE student_id=?", [id]);
    if (personId) {
      await d.execute("DELETE FROM annual_receipts WHERE person_id=?", [personId]);
    }
    await d.execute("DELETE FROM students WHERE id=?", [id]);
  });
  return { deleted: true, receiptCount };
}
// One-time backfill: any student without a person_id gets one computed from current names.
// Memoised — only the first call per process does any work.
let _personIdBackfillDone = false;
export async function backfillPersonIds(): Promise<number> {
  if (_personIdBackfillDone) return 0;
  const rows = await (await db()).select<Student[]>(
    "SELECT * FROM students WHERE person_id IS NULL OR person_id=''"
  );
  for (const r of rows) {
    const pid = personIdFor(r.name, r.father_name, r.mother_name);
    await execRetry("UPDATE students SET person_id=? WHERE id=?", [pid, r.id]);
  }
  _personIdBackfillDone = true;
  return rows.length;
}

// ---------- Receipts ----------

// Issuer snapshot — the daycare details frozen at the moment a receipt is issued
// so that re-rendering an old PDF years later doesn't pick up new settings.
export interface IssuerSnapshot {
  daycare_name: string;
  daycare_address: string;
  contact_email: string;
  contact_phone: string;
  business_number: string;
  director_name: string;
  director_title: string;
  logo_data_url: string;
  signature_data_url: string;
  snapshot_version: 1;
  snapshot_at: string;
}
export function buildIssuerSnapshot(s: SettingsMap): IssuerSnapshot {
  return {
    daycare_name: s.daycare_name || "",
    daycare_address: s.daycare_address || "",
    contact_email: s.contact_email || "",
    contact_phone: s.contact_phone || "",
    business_number: s.business_number || "",
    director_name: s.director_name || "",
    director_title: s.director_title || "",
    logo_data_url: s.logo_data_url || "",
    signature_data_url: s.signature_data_url || "",
    snapshot_version: 1,
    snapshot_at: new Date().toISOString(),
  };
}
// Returns a SettingsMap-like view where issuer fields come from the snapshot
// if present, otherwise from the live settings (legacy receipts).
export function issuerViewFor(receipt: Pick<Receipt, "issuer_snapshot_json"> | { issuer_snapshot_json?: string | null }, settings: SettingsMap): SettingsMap {
  if (!receipt.issuer_snapshot_json) return settings;
  try {
    const snap = JSON.parse(receipt.issuer_snapshot_json) as Partial<IssuerSnapshot>;
    return { ...settings, ...snap } as SettingsMap;
  } catch {
    return settings;
  }
}

async function backfillIssuerSnapshot(d: Database): Promise<void> {
  // Read settings inline via `d` (do NOT call getSettings/db() — this runs
  // from inside ensureSchema, and re-entering db() deadlocks on the schema
  // promise gate).
  const rows = await d.select<{ key: string; value: string }[]>("SELECT key, value FROM settings");
  const settings: SettingsMap = {};
  for (const r of rows) settings[r.key] = r.value ?? "";
  const snap = JSON.stringify(buildIssuerSnapshot(settings));
  await d.execute("UPDATE receipts SET issuer_snapshot_json=? WHERE issuer_snapshot_json IS NULL OR issuer_snapshot_json=''", [snap]);
  await d.execute("UPDATE annual_receipts SET issuer_snapshot_json=? WHERE issuer_snapshot_json IS NULL OR issuer_snapshot_json=''", [snap]);
}

export async function createReceipt(r: Omit<Receipt, "id" | "created_at" | "voided" | "emailed_at" | "emailed_to" | "void_reason" | "voided_at" | "issuer_snapshot_json">): Promise<number> {
  const settings = await getSettings();
  const snap = JSON.stringify(buildIssuerSnapshot(settings));
  // Bump first so even if INSERT fails we leak a number (a harmless gap)
  // instead of returning the same number twice on a fast double-click race —
  // which would crash the second INSERT on the receipt_no UNIQUE constraint.
  await bumpReceiptNo(r.receipt_no);
  const res = await execRetry(
    `INSERT INTO receipts(receipt_no,date,student_id,student_name_snapshot,
      father_name_snapshot,mother_name_snapshot,description,amount,pending_amount,comments,is_refund,
      gross_amount,ccfri_amount,accb_amount,issuer_snapshot_json)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      r.receipt_no, r.date, r.student_id, r.student_name_snapshot,
      r.father_name_snapshot, r.mother_name_snapshot,
      r.description, roundMoney(r.amount), roundMoney(r.pending_amount), r.comments,
      r.is_refund ? 1 : 0,
      r.gross_amount == null ? null : roundMoney(r.gross_amount),
      r.ccfri_amount == null ? null : roundMoney(r.ccfri_amount),
      r.accb_amount  == null ? null : roundMoney(r.accb_amount),
      snap,
    ]
  );
  return Number(res.lastInsertId);
}

// ---------- BC Subsidies (CCFRI + ACCB) ----------
export function subsidiesEnabled(s: SettingsMap): boolean {
  return s.subsidies_enabled === "1";
}
export function computeFeeBreakdown(
  student: Pick<Student, "id" | "gross_override"> | null,
  settings: SettingsMap,
  accbAmount: number = 0
): FeeBreakdown {
  const enabled = subsidiesEnabled(settings);
  const baseGross = parseFloat(settings.gross_monthly_fee || "0") || 0;
  const gross = student?.gross_override != null ? Number(student.gross_override) : baseGross;
  const ccfri = enabled ? (parseFloat(settings.ccfri_monthly_reduction || "0") || 0) : 0;
  const accb  = enabled ? Math.max(0, accbAmount) : 0;
  const cappedCcfri = Math.min(ccfri, gross);
  const afterCcfri  = Math.max(0, gross - cappedCcfri);
  const cappedAccb  = Math.min(accb, afterCcfri);
  const parent_pays = Math.max(0, afterCcfri - cappedAccb);
  return { gross, ccfri: cappedCcfri, accb: cappedAccb, parent_pays, enabled };
}

export async function getAccbForMonth(studentId: number, year: number, month: number): Promise<number> {
  const rows = await (await db()).select<{ amount: number }[]>(
    "SELECT amount FROM accb_entries WHERE student_id=? AND year=? AND month=?",
    [studentId, year, month]
  );
  return rows[0]?.amount ?? 0;
}
export async function listAccbForStudent(studentId: number): Promise<AccbEntry[]> {
  return await (await db()).select<AccbEntry[]>(
    "SELECT * FROM accb_entries WHERE student_id=? ORDER BY year DESC, month DESC",
    [studentId]
  );
}
export async function upsertAccb(studentId: number, year: number, month: number, amount: number, notes: string | null) {
  if (!amount || amount <= 0) {
    await execRetry(
      "DELETE FROM accb_entries WHERE student_id=? AND year=? AND month=?",
      [studentId, year, month]
    );
    return;
  }
  await execRetry(
    `INSERT INTO accb_entries(student_id,year,month,amount,notes)
     VALUES(?,?,?,?,?)
     ON CONFLICT(student_id,year,month)
     DO UPDATE SET amount=excluded.amount, notes=excluded.notes`,
    [studentId, year, month, roundMoney(amount), notes]
  );
}
export async function deleteAccb(id: number) {
  await execRetry("DELETE FROM accb_entries WHERE id=?", [id]);
}

// Subsidy reconciliation: totals collected per calendar month.
export interface SubsidyMonthRow {
  year: number;
  month: number;
  receipt_count: number;
  gross_total: number;
  ccfri_total: number;
  accb_total: number;
  parent_paid_total: number;
}
export async function subsidyReconciliation(year?: number, fiscalYear?: number): Promise<SubsidyMonthRow[]> {
  const args: any[] = [];
  let where = "WHERE voided=0";
  if (fiscalYear !== undefined) {
    where += " AND date>=? AND date<=?";
    args.push(`${fiscalYear}-09-01`, `${fiscalYear + 1}-08-31`);
  } else if (year) {
    where += " AND substr(date,1,4)=?"; args.push(String(year));
  }
  const rows = await (await db()).select<any[]>(
    `SELECT substr(date,1,4) AS y, substr(date,6,2) AS m,
            COUNT(*) AS receipt_count,
            COALESCE(SUM(CASE WHEN is_refund=1 THEN -gross_amount ELSE gross_amount END),0) AS gross_total,
            COALESCE(SUM(CASE WHEN is_refund=1 THEN -ccfri_amount ELSE ccfri_amount END),0) AS ccfri_total,
            COALESCE(SUM(CASE WHEN is_refund=1 THEN -accb_amount ELSE accb_amount END),0) AS accb_total,
            COALESCE(SUM(CASE WHEN is_refund=1 THEN -amount ELSE amount END),0) AS parent_paid_total
     FROM receipts ${where}
     GROUP BY y, m ORDER BY y DESC, m DESC`,
    args
  );
  return rows.map((r) => ({
    year: parseInt(r.y, 10),
    month: parseInt(r.m, 10),
    receipt_count: r.receipt_count,
    gross_total: r.gross_total,
    ccfri_total: r.ccfri_total,
    accb_total: r.accb_total,
    parent_paid_total: r.parent_paid_total,
  }));
}
export async function listReceipts(opts: {
  search?: string; year?: number; month?: number; studentId?: number; fiscalYear?: number;
} = {}): Promise<Receipt[]> {
  let sql = "SELECT * FROM receipts WHERE 1=1";
  const args: any[] = [];
  if (opts.fiscalYear !== undefined) {
    sql += " AND date>=? AND date<=?";
    args.push(`${opts.fiscalYear}-09-01`, `${opts.fiscalYear + 1}-08-31`);
  } else if (opts.year) {
    sql += " AND substr(date,1,4)=?"; args.push(String(opts.year));
  }
  if (opts.month) {
    sql += " AND substr(date,6,2)=?"; args.push(String(opts.month).padStart(2, "0"));
  }
  if (opts.studentId) { sql += " AND student_id=?"; args.push(opts.studentId); }
  if (opts.search) {
    sql += ` AND (student_name_snapshot LIKE ? OR description LIKE ?
              OR comments LIKE ? OR CAST(receipt_no AS TEXT) LIKE ?)`;
    const q = `%${opts.search}%`;
    args.push(q, q, q, q);
  }
  sql += " ORDER BY receipt_no DESC";
  return await (await db()).select<Receipt[]>(sql, args);
}
export async function getReceipt(id: number): Promise<Receipt | null> {
  const rows = await (await db()).select<Receipt[]>("SELECT * FROM receipts WHERE id=?", [id]);
  return rows[0] ?? null;
}
export async function voidReceipt(id: number, reason?: string) {
  await execRetry(
    "UPDATE receipts SET voided=1, void_reason=?, voided_at=datetime('now') WHERE id=?",
    [reason ?? null, id]
  );
}
export async function markEmailed(id: number, recipients: string[]) {
  await execRetry(
    "UPDATE receipts SET emailed_at=datetime('now'), emailed_to=? WHERE id=?",
    [recipients.join(", "), id]
  );
}

// ---------- Deposit Slips ----------
// Receipts eligible for a bank deposit: not voided and not already deposited.
// Ordered oldest-first so the printed slip matches collection order.
export async function listUndepositedReceipts(): Promise<Receipt[]> {
  return await (await db()).select<Receipt[]>(
    "SELECT * FROM receipts WHERE voided=0 AND deposited_at IS NULL AND is_refund=0 ORDER BY date ASC, id ASC"
  );
}

export async function createDeposit(
  receiptIds: number[],
  depositDate: string,
  notes: string | null
): Promise<number> {
  if (receiptIds.length === 0) throw new Error("Deposit must include at least one receipt");
  const d = await db();
  // Compute totals from the receipts themselves so the deposit header is
  // guaranteed to match the sum of its members.
  const placeholders = receiptIds.map(() => "?").join(",");
  const rows = await d.select<{ n: number; total: number }[]>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total
     FROM receipts
     WHERE id IN (${placeholders}) AND voided=0 AND deposited_at IS NULL AND is_refund=0`,
    receiptIds
  );
  const { n, total } = rows[0] ?? { n: 0, total: 0 };
  if (n !== receiptIds.length) {
    throw new Error(
      `One or more selected receipts are no longer eligible (voided, refunded, or already deposited). Refresh the list and try again.`
    );
  }
  const ins = await execRetry(
    "INSERT INTO deposits (deposit_date, cheque_count, total_amount, notes) VALUES (?, ?, ?, ?)",
    [depositDate, n, roundMoney(total), notes]
  );
  const depositId = ins.lastInsertId;
  await execRetry(
    `UPDATE receipts SET deposit_id=?, deposited_at=datetime('now')
     WHERE id IN (${placeholders})`,
    [depositId, ...receiptIds]
  );
  return depositId;
}

export async function listDeposits(): Promise<Deposit[]> {
  return await (await db()).select<Deposit[]>(
    "SELECT * FROM deposits ORDER BY deposit_date DESC, id DESC"
  );
}

export async function getDepositWithReceipts(
  id: number
): Promise<{ deposit: Deposit; receipts: Receipt[] } | null> {
  const d = await db();
  const drows = await d.select<Deposit[]>("SELECT * FROM deposits WHERE id=?", [id]);
  if (drows.length === 0) return null;
  const rrows = await d.select<Receipt[]>(
    "SELECT * FROM receipts WHERE deposit_id=? ORDER BY date ASC, id ASC",
    [id]
  );
  return { deposit: drows[0], receipts: rrows };
}

// Reverse a deposit — clears the deposit_id/deposited_at on member receipts so
// they reappear in the undeposited list, and flags the deposit voided (never
// deleted, per data-retention rule).
export async function voidDeposit(id: number, reason?: string): Promise<void> {
  await execRetry(
    "UPDATE receipts SET deposit_id=NULL, deposited_at=NULL WHERE deposit_id=?",
    [id]
  );
  await execRetry(
    "UPDATE deposits SET voided=1, voided_at=datetime('now'), void_reason=? WHERE id=?",
    [reason ?? null, id]
  );
}

// ---------- Reports ----------
export interface MonthlyTotal { ym: string; count: number; total: number; }
export async function monthlyTotals(year?: number, fiscalYear?: number): Promise<MonthlyTotal[]> {
  // Refunds carry a positive `amount` with is_refund=1. Sum them as negatives so
  // monthly revenue reflects net cash received (matching AnnualGroup / subsidy math).
  let sql = `SELECT substr(date,1,7) AS ym,
                    COUNT(*) AS count,
                    COALESCE(SUM(CASE WHEN is_refund=1 THEN -amount ELSE amount END),0) AS total
             FROM receipts WHERE voided=0`;
  const args: any[] = [];
  if (fiscalYear !== undefined) {
    sql += " AND date>=? AND date<=?";
    args.push(`${fiscalYear}-09-01`, `${fiscalYear + 1}-08-31`);
  } else if (year) {
    sql += " AND substr(date,1,4)=?"; args.push(String(year));
  }
  sql += " GROUP BY ym ORDER BY ym DESC";
  return await (await db()).select<MonthlyTotal[]>(sql, args);
}

// ---------- Annual receipts (CRA tax-year aggregation) ----------
// Group all receipts in a given calendar year by person_id of the originating student.
// Falls back to grouping by student_name_snapshot when the student row has no person_id
// (legacy data). Voided receipts are excluded from totals.
export interface AnnualGroup {
  person_id: string;        // synthesized when needed
  student_name: string;
  father_name: string | null;
  mother_name: string | null;
  email: string | null;
  receipts: Receipt[];
  total: number;
  count: number;
  last_issued?: AnnualReceipt | null;
}
export async function annualGroupsForYear(year: number): Promise<AnnualGroup[]> {
  await backfillPersonIds();
  const rs = await (await db()).select<Receipt[]>(
    `SELECT * FROM receipts WHERE voided=0 AND substr(date,1,4)=? ORDER BY date ASC, receipt_no ASC`,
    [String(year)]
  );
  // map student_id -> person_id, name details, email
  const studentRows = await (await db()).select<Student[]>("SELECT * FROM students");
  const sById = new Map(studentRows.map((s) => [s.id, s]));

  const groups = new Map<string, AnnualGroup>();
  for (const r of rs) {
    const s = sById.get(r.student_id);
    const pid = s?.person_id || personIdFor(
      r.student_name_snapshot, r.father_name_snapshot, r.mother_name_snapshot
    );
    let g = groups.get(pid);
    if (!g) {
      // Prefer current student row's name / email if we still have it on roster; otherwise use snapshot.
      g = {
        person_id: pid,
        student_name: s?.name || r.student_name_snapshot,
        father_name: s?.father_name || r.father_name_snapshot,
        mother_name: s?.mother_name || r.mother_name_snapshot,
        email: s?.email || null,
        receipts: [], total: 0, count: 0,
      };
      groups.set(pid, g);
    }
    g.receipts.push(r);
    g.total += r.is_refund ? -Math.abs(r.amount) : r.amount;
    g.count++;
  }

  // Attach the most recent NON-superseded annual receipt for this person+year.
  // Single query → in-memory bucketing avoids N+1 SELECTs.
  const annualRows = await (await db()).select<AnnualReceipt[]>(
    `SELECT * FROM annual_receipts
     WHERE calendar_year=? AND superseded_by IS NULL
     ORDER BY issued_at DESC`,
    [year]
  );
  const latestByPerson = new Map<string, AnnualReceipt>();
  for (const a of annualRows) {
    if (!latestByPerson.has(a.person_id)) latestByPerson.set(a.person_id, a);
  }
  for (const g of groups.values()) {
    g.last_issued = latestByPerson.get(g.person_id) ?? null;
  }
  return Array.from(groups.values()).sort((a, b) => a.student_name.localeCompare(b.student_name));
}

// Stable hash of the payload (used to detect "nothing changed" re-issues)
export function annualPayloadHash(g: AnnualGroup): string {
  const ids = g.receipts.map((r) => `${r.id}:${r.amount}:${r.is_refund}`).sort().join(",");
  const seed = `${g.person_id}|${ids}`;
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h) ^ seed.charCodeAt(i);
  return (h >>> 0).toString(16).padStart(8, "0");
}

export async function recordAnnualReceipt(opts: {
  group: AnnualGroup;
  year: number;
  arNumber: string;
  recipientLabel: string;
  supersede?: AnnualReceipt | null;
  notes?: string | null;
}): Promise<number> {
  const { group, year, arNumber, recipientLabel } = opts;
  const ids = group.receipts.map((r) => r.id);
  const hash = annualPayloadHash(group);
  const settings = await getSettings();
  const snap = JSON.stringify(buildIssuerSnapshot(settings));
  // Serialize the insert + supersede so they aren't interleaved with any other
  // write. If the supersede UPDATE fails, the new AR exists alongside the old
  // one — both would show as "current" and the parent could get two T778s.
  return serializeWrite(async () => {
    const d = await db();
    const res = await d.execute(
      `INSERT INTO annual_receipts
        (ar_number, person_id, student_name, father_name, mother_name,
         calendar_year, recipient_label, total_amount, receipt_count,
         receipt_ids_json, payload_hash, notes, issuer_snapshot_json)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        arNumber, group.person_id, group.student_name,
        group.father_name, group.mother_name,
        year, recipientLabel, roundMoney(group.total), group.count,
        JSON.stringify(ids), hash, opts.notes ?? null, snap,
      ]
    );
    const newId = res.lastInsertId as number;
    if (opts.supersede) {
      await d.execute(
        `UPDATE annual_receipts SET superseded_by=? WHERE id=?`,
        [newId, opts.supersede.id]
      );
    }
    return newId;
  });
}

export async function markAnnualReceiptEmailed(id: number, recipients: string[]) {
  await execRetry(
    `UPDATE annual_receipts SET emailed_at=datetime('now'), emailed_to=? WHERE id=?`,
    [recipients.join(", "), id]
  );
}

export async function listAnnualReceiptsForPersonYear(personId: string, year: number): Promise<AnnualReceipt[]> {
  return await (await db()).select<AnnualReceipt[]>(
    `SELECT * FROM annual_receipts WHERE person_id=? AND calendar_year=? ORDER BY issued_at DESC`,
    [personId, year]
  );
}

