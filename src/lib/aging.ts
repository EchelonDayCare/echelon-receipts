// Aging A/R report. Buckets each unpaid receipt by how old it is relative
// to a reference date (default: today), grouped by student/family.
//
// "Pending" comes from the receipt.pending_amount column the user already
// captures when issuing receipts; voided receipts are excluded.
import { db } from "./db";

export interface AgingBucket {
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
  const a = new Date(fromIso + "T00:00:00").getTime();
  const b = new Date(toIso + "T00:00:00").getTime();
  return Math.floor((b - a) / (1000 * 60 * 60 * 24));
}

export async function computeAging(asOfIso?: string): Promise<AgingReport> {
  const d = await db();
  const asOf = asOfIso || new Date().toISOString().slice(0, 10);

  // Pull every receipt with a positive pending balance, joined with student
  // identity so we can group by family.
  const rows = await d.select<any[]>(
    `SELECT r.id, r.date, r.pending_amount, r.amount, r.student_id,
            s.name AS student_name, s.father_name, s.mother_name, s.email
       FROM receipts r
       JOIN students s ON s.id = r.student_id
      WHERE r.voided = 0 AND r.pending_amount > 0
      ORDER BY r.date ASC`
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
        bucket: { current: 0, d31_60: 0, d61_90: 0, d90plus: 0, total: 0 },
      };
      byStudent.set(r.student_id, row);
    }
    if (r.date < row.oldest_unpaid_date) row.oldest_unpaid_date = r.date;
    row.receipt_count += 1;
    const age = daysBetween(r.date, asOf);
    const amt = Math.round((r.pending_amount as number) * 100) / 100;
    if (age <= 30) row.bucket.current += amt;
    else if (age <= 60) row.bucket.d31_60 += amt;
    else if (age <= 90) row.bucket.d61_90 += amt;
    else row.bucket.d90plus += amt;
    row.bucket.total += amt;
  }

  const list = Array.from(byStudent.values())
    .map((r) => ({
      ...r,
      bucket: {
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
      current: acc.current + r.bucket.current,
      d31_60: acc.d31_60 + r.bucket.d31_60,
      d61_90: acc.d61_90 + r.bucket.d61_90,
      d90plus: acc.d90plus + r.bucket.d90plus,
      total: acc.total + r.bucket.total,
    }),
    { current: 0, d31_60: 0, d61_90: 0, d90plus: 0, total: 0 }
  );
  // Re-round totals so summed REAL drift never appears on the report.
  for (const k of Object.keys(totals) as (keyof AgingBucket)[]) {
    totals[k] = Math.round(totals[k] * 100) / 100;
  }
  return { as_of: asOf, rows: list, totals };
}

export function agingToCsv(rep: AgingReport): string {
  const head = "Student,Father,Mother,Email,Oldest unpaid,Receipt count,Current (0-30),31-60,61-90,90+,Total";
  const lines = rep.rows.map((r) => {
    const cells = [
      r.student_name, r.father_name || "", r.mother_name || "", r.email || "",
      r.oldest_unpaid_date, String(r.receipt_count),
      r.bucket.current.toFixed(2), r.bucket.d31_60.toFixed(2),
      r.bucket.d61_90.toFixed(2), r.bucket.d90plus.toFixed(2),
      r.bucket.total.toFixed(2),
    ];
    return cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",");
  });
  const tot = rep.totals;
  const totLine = `"TOTAL","","","","","",${tot.current.toFixed(2)},${tot.d31_60.toFixed(2)},${tot.d61_90.toFixed(2)},${tot.d90plus.toFixed(2)},${tot.total.toFixed(2)}`;
  return [head, ...lines, totLine].join("\n");
}
