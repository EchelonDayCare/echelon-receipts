import Database from "@tauri-apps/plugin-sql";
import type { Student, Receipt, SettingsMap, AnnualReceipt } from "../types";

let _db: Database | null = null;
let _schemaChecked = false;
export async function db(): Promise<Database> {
  if (!_db) _db = await Database.load("sqlite:echelon.db");
  if (!_schemaChecked) {
    _schemaChecked = true;
    try { await ensureSchema(_db); } catch (e) { console.error("[ensureSchema] failed:", e); }
  }
  return _db;
}

// ---------- Schema safety net ----------
// Tauri-plugin-sql migration tracker has been observed to silently skip pending
// migrations on pre-existing DBs. This idempotently patches anything missing so
// the app self-heals on startup. Add new expectations as schema evolves.
async function ensureSchema(d: Database): Promise<void> {
  const tableExists = async (name: string): Promise<boolean> => {
    const r = await d.select<{ n: number }[]>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?", [name]
    );
    return (r[0]?.n ?? 0) > 0;
  };
  const colExists = async (table: string, col: string): Promise<boolean> => {
    if (!(await tableExists(table))) return false;
    const rows = await d.select<{ name: string }[]>(`PRAGMA table_info(${table})`);
    return rows.some((r) => r.name === col);
  };
  const addCol = async (table: string, col: string, decl: string) => {
    if (!(await colExists(table, col))) {
      console.warn(`[ensureSchema] adding ${table}.${col}`);
      await d.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
    }
  };
  const setting = async (key: string, value: string) => {
    await d.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", [key, value]);
  };

  // Migration 002 — pdf_folder
  await setting("pdf_folder", "");

  // Migration 003 — email audit + settings
  await addCol("receipts", "emailed_at", "TEXT");
  await addCol("receipts", "emailed_to", "TEXT");
  for (const [k, v] of [
    ["sender_email", ""], ["sender_name", "Echelon Daycare Society"],
    ["smtp_host", "smtp-mail.outlook.com"], ["smtp_port", "587"],
    ["smtp_user", ""], ["bcc_self", "1"],
    ["email_subject", "Receipt #{{receipt_no}} - {{student}} - {{description}}"],
    ["email_body", "Hi,\n\nPlease find attached the receipt for {{student}} ({{description}}).\n\nAmount: ${{amount}}{{pending_line}}\n\nThank you,\nEchelon Daycare Society\n{{contact_email}} | {{contact_phone}}"],
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
export async function getSettings(): Promise<SettingsMap> {
  const rows = await (await db()).select<{ key: string; value: string }[]>(
    "SELECT key, value FROM settings"
  );
  const m: SettingsMap = {};
  rows.forEach((r) => (m[r.key] = r.value ?? ""));
  return m;
}
export async function setSetting(key: string, value: string) {
  await (await db()).execute(
    "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [key, value]
  );
}
export async function nextReceiptNo(): Promise<number> {
  const s = await getSettings();
  return parseInt(s.next_receipt_no || "1001", 10);
}
export async function bumpReceiptNo(used: number) {
  await setSetting("next_receipt_no", String(used + 1));
}
export async function nextAnnualReceiptNumber(year: number): Promise<string> {
  const s = await getSettings();
  const n = parseInt(s.next_ar_no || "1", 10);
  await setSetting("next_ar_no", String(n + 1));
  return `AR-${year}-${String(n).padStart(4, "0")}`;
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
export async function upsertStudent(s: Partial<Student> & { name: string; year: number }) {
  const pid = s.person_id || personIdFor(s.name, s.father_name, s.mother_name);
  if (s.id) {
    await (await db()).execute(
      "UPDATE students SET name=?, father_name=?, mother_name=?, email=?, year=?, active=?, person_id=? WHERE id=?",
      [s.name, s.father_name ?? null, s.mother_name ?? null, s.email ?? null, s.year, s.active ?? 1, pid, s.id]
    );
  } else {
    await (await db()).execute(
      "INSERT INTO students(name,father_name,mother_name,email,year,active,person_id) VALUES(?,?,?,?,?,1,?)",
      [s.name, s.father_name ?? null, s.mother_name ?? null, s.email ?? null, s.year, pid]
    );
  }
}
export async function deleteStudent(id: number) {
  await (await db()).execute("UPDATE students SET active=0 WHERE id=?", [id]);
}
// One-time backfill: any student without a person_id gets one computed from current names.
export async function backfillPersonIds(): Promise<number> {
  const rows = await (await db()).select<Student[]>(
    "SELECT * FROM students WHERE person_id IS NULL OR person_id=''"
  );
  for (const r of rows) {
    const pid = personIdFor(r.name, r.father_name, r.mother_name);
    await (await db()).execute("UPDATE students SET person_id=? WHERE id=?", [pid, r.id]);
  }
  return rows.length;
}

// ---------- Receipts ----------
export async function createReceipt(r: Omit<Receipt, "id" | "created_at" | "voided" | "emailed_at" | "emailed_to">) {
  await (await db()).execute(
    `INSERT INTO receipts(receipt_no,date,student_id,student_name_snapshot,
      father_name_snapshot,mother_name_snapshot,description,amount,pending_amount,comments,is_refund)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    [
      r.receipt_no, r.date, r.student_id, r.student_name_snapshot,
      r.father_name_snapshot, r.mother_name_snapshot,
      r.description, r.amount, r.pending_amount, r.comments,
      r.is_refund ? 1 : 0,
    ]
  );
  await bumpReceiptNo(r.receipt_no);
}
export async function listReceipts(opts: {
  search?: string; year?: number; month?: number; studentId?: number;
} = {}): Promise<Receipt[]> {
  let sql = "SELECT * FROM receipts WHERE 1=1";
  const args: any[] = [];
  if (opts.year) {
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
export async function voidReceipt(id: number) {
  await (await db()).execute("UPDATE receipts SET voided=1 WHERE id=?", [id]);
}
export async function markEmailed(id: number, recipients: string[]) {
  await (await db()).execute(
    "UPDATE receipts SET emailed_at=datetime('now'), emailed_to=? WHERE id=?",
    [recipients.join(", "), id]
  );
}

// ---------- Reports ----------
export interface MonthlyTotal { ym: string; count: number; total: number; }
export async function monthlyTotals(year?: number): Promise<MonthlyTotal[]> {
  let sql = `SELECT substr(date,1,7) AS ym, COUNT(*) AS count, SUM(amount) AS total
             FROM receipts WHERE voided=0`;
  const args: any[] = [];
  if (year) { sql += " AND substr(date,1,4)=?"; args.push(String(year)); }
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
  const yPrefix = `${year}-`;
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
  void yPrefix;

  // Attach the most recent NON-superseded annual receipt for this person+year
  for (const g of groups.values()) {
    const rows = await (await db()).select<AnnualReceipt[]>(
      `SELECT * FROM annual_receipts
       WHERE person_id=? AND calendar_year=? AND superseded_by IS NULL
       ORDER BY issued_at DESC LIMIT 1`,
      [g.person_id, year]
    );
    g.last_issued = rows[0] ?? null;
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
  const res = await (await db()).execute(
    `INSERT INTO annual_receipts
      (ar_number, person_id, student_name, father_name, mother_name,
       calendar_year, recipient_label, total_amount, receipt_count,
       receipt_ids_json, payload_hash, notes)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      arNumber, group.person_id, group.student_name,
      group.father_name, group.mother_name,
      year, recipientLabel, group.total, group.count,
      JSON.stringify(ids), hash, opts.notes ?? null,
    ]
  );
  const newId = res.lastInsertId as number;
  if (opts.supersede) {
    await (await db()).execute(
      `UPDATE annual_receipts SET superseded_by=? WHERE id=?`,
      [newId, opts.supersede.id]
    );
  }
  return newId;
}

export async function markAnnualReceiptEmailed(id: number, recipients: string[]) {
  await (await db()).execute(
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

