import Database from "@tauri-apps/plugin-sql";
import type { Student, Receipt, SettingsMap } from "../types";

let _db: Database | null = null;
export async function db(): Promise<Database> {
  if (!_db) _db = await Database.load("sqlite:echelon.db");
  return _db;
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
  if (s.id) {
    await (await db()).execute(
      "UPDATE students SET name=?, father_name=?, mother_name=?, email=?, year=?, active=? WHERE id=?",
      [s.name, s.father_name ?? null, s.mother_name ?? null, s.email ?? null, s.year, s.active ?? 1, s.id]
    );
  } else {
    await (await db()).execute(
      "INSERT INTO students(name,father_name,mother_name,email,year,active) VALUES(?,?,?,?,?,1)",
      [s.name, s.father_name ?? null, s.mother_name ?? null, s.email ?? null, s.year]
    );
  }
}
export async function deleteStudent(id: number) {
  await (await db()).execute("UPDATE students SET active=0 WHERE id=?", [id]);
}

// ---------- Receipts ----------
export async function createReceipt(r: Omit<Receipt, "id" | "created_at" | "voided" | "emailed_at" | "emailed_to">) {
  await (await db()).execute(
    `INSERT INTO receipts(receipt_no,date,student_id,student_name_snapshot,
      father_name_snapshot,mother_name_snapshot,description,amount,pending_amount,comments)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [
      r.receipt_no, r.date, r.student_id, r.student_name_snapshot,
      r.father_name_snapshot, r.mother_name_snapshot,
      r.description, r.amount, r.pending_amount, r.comments,
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
