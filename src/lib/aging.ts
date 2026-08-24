// Aging A/R report. Buckets each unpaid receipt by how old it is relative
// to a reference date (default: today), grouped by student/family.
//
// "Pending" comes from the receipt.pending_amount column the user already
// captures when issuing receipts; voided receipts are excluded.
import { db } from "./db";
import { todayLocalIso } from "./localDate";

export interface AgingBucket {
  future: number;    // dated after as_of — likely a data-entry error
  current: number;   // 0-30 days old
  d31_60: number;
  d61_90: number;
  d90plus: number;
  total: number;
}

export interface AgingRow {
  student_id: number;
  student_name: string;
  father_name: string | null;
  mother_name: string | null;
  email: string | null;
  oldest_unpaid_date: string;  // yyyy-mm-dd
  receipt_count: number;
  bucket: AgingBucket;
}

export interface AgingReport {
  as_of: string;
  rows: AgingRow[];
  totals: AgingBucket;
}

function daysBetween(fromIso: string, toIso: string): number {
  // DST-safe: anchor both dates at UTC midnight so a 31-day span crossing
  // the spring-forward transition doesn't lose an hour and floor to 30
  // (which used to bump balances from "31-60 days" back into "Current").
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const [ty, tm, td] = toIso.split("-").map(Number);
  const a = Date.UTC(fy, (fm || 1) - 1, fd || 1);
  const b = Date.UTC(ty, (tm || 1) - 1, td || 1);
  return Math.round((b - a) / 86_400_000);
}

export async function computeAging(asOfIso?: string): Promise<AgingReport> {
  const d = await db();
  const asOf = asOfIso || todayLocalIso();

  // v3.24.4 (#5): include receipts that were settled AFTER the as-of
  // date — historically they were still outstanding on that date.
  // (settled_at is NULL for currently-pending; those always show.)
  const rows = await d.select<any[]>(
    `SELECT r.id, r.date, r.pending_amount, r.amount, r.student_id,
            s.name AS student_name, s.father_name, s.mother_name, s.email
       FROM receipts r
       JOIN students s ON s.id = r.student_id
      WHERE r.voided = 0 AND r.pending_amount > 0
        AND (r.settled_at IS NULL OR r.settled_at > ?)
      ORDER BY r.date ASC`,
    [asOf]
  );

  // Group by student so a family's outstanding rolls up to one row.
  const byStudent = new Map<number, AgingRow>();
  for (const r of rows) {
    let row = byStudent.get(r.student_id);
    if (!row) {
      row = {
        student_id: r.student_id,
        student_name: r.student_name,
        father_name: r.father_name,
        mother_name: r.mother_name,
        email: r.email,
        oldest_unpaid_date: r.date,
        receipt_count: 0,
        bucket: { future: 0, current: 0, d31_60: 0, d61_90: 0, d90plus: 0, total: 0 },
      };
      byStudent.set(r.student_id, row);
    }
    if (r.date < row.oldest_unpaid_date) row.oldest_unpaid_date = r.date;
    row.receipt_count += 1;
    const age = daysBetween(r.date, asOf);
    const amt = Math.round((r.pending_amount as number) * 100) / 100;
    if (age < 0) row.bucket.future += amt;
    else if (age <= 30) row.bucket.current += amt;
    else if (age <= 60) row.bucket.d31_60 += amt;
    else if (age <= 90) row.bucket.d61_90 += amt;
    else row.bucket.d90plus += amt;
    row.bucket.total += amt;
  }

  const list = Array.from(byStudent.values())
    .map((r) => ({
      ...r,
      bucket: {
        future: Math.round(r.bucket.future * 100) / 100,
        current: Math.round(r.bucket.current * 100) / 100,
        d31_60: Math.round(r.bucket.d31_60 * 100) / 100,
        d61_90: Math.round(r.bucket.d61_90 * 100) / 100,
        d90plus: Math.round(r.bucket.d90plus * 100) / 100,
        total: Math.round(r.bucket.total * 100) / 100,
      },
    }))
    // Worst offenders first.
    .sort((a, b) => b.bucket.d90plus - a.bucket.d90plus || b.bucket.total - a.bucket.total);

  const totals = list.reduce<AgingBucket>(
    (acc, r) => ({
      future: acc.future + r.bucket.future,
      current: acc.current + r.bucket.current,
      d31_60: acc.d31_60 + r.bucket.d31_60,
      d61_90: acc.d61_90 + r.bucket.d61_90,
      d90plus: acc.d90plus + r.bucket.d90plus,
      total: acc.total + r.bucket.total,
    }),
    { future: 0, current: 0, d31_60: 0, d61_90: 0, d90plus: 0, total: 0 }
  );
  // Re-round totals so summed REAL drift never appears on the report.
  for (const k of Object.keys(totals) as (keyof AgingBucket)[]) {
    totals[k] = Math.round(totals[k] * 100) / 100;
  }
  return { as_of: asOf, rows: list, totals };
}

export function agingToCsv(rep: AgingReport): string {
  const head = "Student,Father,Mother,Email,Oldest unpaid,Receipt count,Future (data error),Current (0-30),31-60,61-90,90+,Total";
  const lines = rep.rows.map((r) => {
    const cells = [
      r.student_name, r.father_name || "", r.mother_name || "", r.email || "",
      r.oldest_unpaid_date, String(r.receipt_count),
      r.bucket.future.toFixed(2),
      r.bucket.current.toFixed(2), r.bucket.d31_60.toFixed(2),
      r.bucket.d61_90.toFixed(2), r.bucket.d90plus.toFixed(2),
      r.bucket.total.toFixed(2),
    ];
    return cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",");
  });
  const tot = rep.totals;
  const totLine = `"TOTAL","","","","","",${tot.future.toFixed(2)},${tot.current.toFixed(2)},${tot.d31_60.toFixed(2)},${tot.d61_90.toFixed(2)},${tot.d90plus.toFixed(2)},${tot.total.toFixed(2)}`;
  return [head, ...lines, totLine].join("\n");
}

/**
 * v3.24.4 (#5): Mark a receipt's pending balance as settled. Sets
 * pending_amount to 0 and stamps settled_at + optionally settled_by_receipt_id
 * so historical aging reports remain accurate.
 *
 * Called when the family pays off an outstanding balance — either as part
 * of a subsequent receipt (pass `settledByReceiptId`) or as a manual
 * write-off ("Mark settled" button).
 */
export async function settleReceipt(
  receiptId: number,
  settledByReceiptId: number | null = null,
  settledAtIso?: string,
): Promise<void> {
  const { execRetry } = await import("./db");
  const stamp = settledAtIso || todayLocalIso();
  await execRetry(
    `UPDATE receipts
        SET pending_amount = 0,
            settled_at = ?,
            settled_by_receipt_id = ?
      WHERE id = ? AND voided = 0 AND pending_amount > 0`,
    [stamp, settledByReceiptId, receiptId],
  );
}

/**
 * Settle every currently-pending receipt for a student in one call.
 * Used by the Aging screen's "Mark family settled" affordance.
 */
export async function settleAllForStudent(
  studentId: number,
  settledByReceiptId: number | null = null,
  settledAtIso?: string,
): Promise<number> {
  const { execRetry } = await import("./db");
  const stamp = settledAtIso || todayLocalIso();
  const d = await db();
  const before = await d.select<Array<{ n: number }>>(
    `SELECT COUNT(*) AS n FROM receipts
       WHERE student_id = ? AND voided = 0 AND pending_amount > 0`,
    [studentId],
  );
  await execRetry(
    `UPDATE receipts
        SET pending_amount = 0,
            settled_at = ?,
            settled_by_receipt_id = ?
      WHERE student_id = ? AND voided = 0 AND pending_amount > 0`,
    [stamp, settledByReceiptId, studentId],
  );
  return before?.[0]?.n ?? 0;
}
