import { db, execRetry, roundMoney } from "./db";

export const EXPENSE_CATEGORIES: Array<{ value: string; label: string; hint?: string }> = [
  { value: "rent_lease",        label: "Rent / Lease" },
  { value: "payroll",           label: "Payroll / Staff Salary" },
  { value: "cra_remittance",    label: "CRA Payroll Remittance", hint: "CPP/EI/Income tax remittance" },
  { value: "wcb",               label: "WorkSafeBC (WCB)", hint: "Direct-deposit deduction" },
  { value: "utilities_phone",   label: "Utilities — Phone" },
  { value: "utilities_internet",label: "Utilities — Internet" },
  { value: "utilities_hydro",   label: "Utilities — Hydro / Electric" },
  { value: "utilities_gas",     label: "Utilities — Gas / Heat" },
  { value: "utilities_water",   label: "Utilities — Water / Sewer" },
  { value: "insurance",         label: "Insurance", hint: "Liability, contents, WCB assessment" },
  { value: "supplies_program",  label: "Program / Craft Supplies" },
  { value: "supplies_office",   label: "Office Supplies" },
  { value: "supplies_cleaning", label: "Cleaning Supplies" },
  { value: "food_groceries",    label: "Food / Groceries", hint: "Costco snacks, kitchen supplies" },
  { value: "compass_transit",   label: "Compass Card / Transit" },
  { value: "professional_fees", label: "Professional Fees", hint: "Accountant, legal, licensing" },
  { value: "training",          label: "Staff Training / Credentials" },
  { value: "maintenance",       label: "Maintenance / Repairs" },
  { value: "bank_fees",         label: "Bank Fees / Interest" },
  { value: "software",          label: "Software / Subscriptions" },
  { value: "advertising",       label: "Advertising / Marketing" },
  { value: "meals_entertainment", label: "Meals & Entertainment" },
  { value: "vehicle",           label: "Vehicle / Mileage" },
  { value: "misc",              label: "Miscellaneous / Ad-hoc" },
];

export const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  EXPENSE_CATEGORIES.map((c) => [c.value, c.label])
);

export const PAYMENT_METHODS: string[] = [
  "Cash",
  "Visa Credit Card",
  "Mastercard",
  "Debit Card",
  "Cheque",
  "Direct Deposit (Bank)",
  "EFT / Interac",
  "Compass Card",
  "PAD / Auto-debit",
  "Other",
];

export const FREQUENCIES: Array<{ value: string; label: string }> = [
  { value: "monthly",   label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "yearly",    label: "Yearly" },
];

export type Expense = {
  id: number;
  date: string;
  category: string;
  subcategory: string | null;
  vendor: string | null;
  amount: number;
  payment_method: string;
  reference: string | null;
  notes: string | null;
  recurring_id: number | null;
  import_batch_id: string | null;
  source_txn_hash: string | null;
  created_at: string;
};

export type RecurringExpense = {
  id: number;
  name: string;
  category: string;
  subcategory: string | null;
  vendor: string | null;
  amount: number;
  payment_method: string;
  frequency: string;
  day_of_month: number;
  start_date: string;
  end_date: string | null;
  active: number;
  notes: string | null;
  last_posted_date: string | null; // retained for legacy display; not used for gating
  created_at: string;
};

export async function listExpenses(opts: {
  from?: string;
  to?: string;
  category?: string;
  payment_method?: string;
  q?: string;
  limit?: number;
  batchId?: string;
} = {}): Promise<Expense[]> {
  const d = await db();
  const where: string[] = [];
  const params: any[] = [];
  if (opts.from) { where.push("date >= ?"); params.push(opts.from); }
  if (opts.to)   { where.push("date <= ?"); params.push(opts.to); }
  if (opts.category) { where.push("category = ?"); params.push(opts.category); }
  if (opts.payment_method) { where.push("payment_method = ?"); params.push(opts.payment_method); }
  if (opts.batchId) { where.push("import_batch_id = ?"); params.push(opts.batchId); }
  if (opts.q) {
    where.push("(vendor LIKE ? OR notes LIKE ? OR subcategory LIKE ? OR reference LIKE ?)");
    const q = `%${opts.q}%`;
    params.push(q, q, q, q);
  }
  const sql = `SELECT * FROM expenses ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY date DESC, id DESC ${opts.limit ? `LIMIT ${opts.limit}` : ""}`;
  return d.select<Expense[]>(sql, params);
}

export async function getExpense(id: number): Promise<Expense | null> {
  const d = await db();
  const rows = await d.select<Expense[]>("SELECT * FROM expenses WHERE id=?", [id]);
  return rows[0] || null;
}

export async function saveExpense(e: Partial<Expense> & { id?: number }): Promise<number> {
  const amt = roundMoney(e.amount ?? 0);
  if (e.id) {
    await execRetry(
      `UPDATE expenses SET date=?, category=?, subcategory=?, vendor=?, amount=?, payment_method=?, reference=?, notes=?
       WHERE id=?`,
      [e.date, e.category, e.subcategory || null, e.vendor || null, amt, e.payment_method, e.reference || null, e.notes || null, e.id]
    );
    return e.id;
  }
  const res = await execRetry(
    `INSERT INTO expenses(date, category, subcategory, vendor, amount, payment_method, reference, notes, recurring_id, import_batch_id, source_txn_hash)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    [
      e.date, e.category, e.subcategory || null, e.vendor || null, amt,
      e.payment_method, e.reference || null, e.notes || null,
      e.recurring_id || null, e.import_batch_id || null, e.source_txn_hash || null,
    ]
  );
  return res.lastInsertId;
}

export async function deleteExpense(id: number): Promise<void> {
  await execRetry("DELETE FROM expenses WHERE id=?", [id]);
}

export async function listRecurring(activeOnly = false): Promise<RecurringExpense[]> {
  const d = await db();
  const sql = `SELECT * FROM recurring_expenses ${activeOnly ? "WHERE active=1" : ""} ORDER BY active DESC, name`;
  return d.select<RecurringExpense[]>(sql);
}

export async function saveRecurring(r: Partial<RecurringExpense> & { id?: number }): Promise<number> {
  const amt = roundMoney(r.amount ?? 0);
  if (r.id) {
    await execRetry(
      `UPDATE recurring_expenses SET name=?, category=?, subcategory=?, vendor=?, amount=?, payment_method=?,
        frequency=?, day_of_month=?, start_date=?, end_date=?, active=?, notes=? WHERE id=?`,
      [r.name, r.category, r.subcategory || null, r.vendor || null, amt, r.payment_method,
       r.frequency || "monthly", r.day_of_month || 1, r.start_date, r.end_date || null,
       r.active ? 1 : 0, r.notes || null, r.id]
    );
    return r.id;
  }
  const res = await execRetry(
    `INSERT INTO recurring_expenses(name, category, subcategory, vendor, amount, payment_method, frequency, day_of_month, start_date, end_date, active, notes)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [r.name, r.category, r.subcategory || null, r.vendor || null, amt, r.payment_method,
     r.frequency || "monthly", r.day_of_month || 1, r.start_date, r.end_date || null,
     r.active === 0 ? 0 : 1, r.notes || null]
  );
  return res.lastInsertId;
}

export async function deleteRecurring(id: number): Promise<void> {
  await execRetry("DELETE FROM recurring_expenses WHERE id=?", [id]);
}

/**
 * Duplicate detection.
 *
 * Two expenses are considered "possible duplicates" when ALL are true:
 *   1. amount difference ≤ $0.50 (handles small FX rounding)
 *   2. date difference ≤ 3 days (handles bank posting lag)
 *   3. vendor matches case-insensitively (word-level), OR — when either
 *      vendor is blank — same category
 *   4. They are not the same row.
 *
 * Common trigger: user scans a credit-card statement, and the same vendor
 * bill is ALSO already posted from a recurring template. The pair is
 * flagged so the operator can delete the copy they don't want.
 *
 * Computed on the fly — no schema change. If perf becomes an issue over
 * huge date ranges we'll move to a SQL self-join.
 */
export type DuplicateGroup = {
  keyExpenseId: number;
  matches: number[]; // other expense ids in the group
};

function normVendor(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}
function daysApart(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const da = Date.UTC(ay, am - 1, ad);
  const db2 = Date.UTC(by, bm - 1, bd);
  return Math.abs(da - db2) / 86_400_000;
}

export function findDuplicateIds(rows: Expense[]): Set<number> {
  const flagged = new Set<number>();
  // O(n^2) — expenses list is typically ≤ a few hundred rows per filter.
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i]; const b = rows[j];
      if (Math.abs(a.amount - b.amount) > 0.5) continue;
      if (daysApart(a.date, b.date) > 3) continue;
      const va = normVendor(a.vendor); const vb = normVendor(b.vendor);
      const vendorMatch = va && vb && va === vb;
      const categoryFallback = (!va || !vb) && a.category === b.category;
      if (!vendorMatch && !categoryFallback) continue;
      flagged.add(a.id); flagged.add(b.id);
    }
  }
  return flagged;
}

/** For a given expense, return every other row in `rows` that pairs with it. */
export function findDuplicatePartners(target: Expense, rows: Expense[]): Expense[] {
  const out: Expense[] = [];
  for (const b of rows) {
    if (b.id === target.id) continue;
    if (Math.abs(target.amount - b.amount) > 0.5) continue;
    if (daysApart(target.date, b.date) > 3) continue;
    const va = normVendor(target.vendor); const vb = normVendor(b.vendor);
    const vendorMatch = va && vb && va === vb;
    const categoryFallback = (!va || !vb) && target.category === b.category;
    if (!vendorMatch && !categoryFallback) continue;
    out.push(b);
  }
  return out;
}

// Compute the target date this template should post on for the given YYYY-MM
// period, ignoring whether it's already posted. Returns null if the period is
// out of range or the frequency doesn't hit this month.
export function targetDateForPeriod(r: RecurringExpense, periodYYYYMM: string): string | null {
  if (!r.active) return null;
  const [yy, mm] = periodYYYYMM.split("-").map(Number);
  if (!yy || !mm) return null;
  const start = new Date(r.start_date + "T00:00:00");
  const periodStart = new Date(yy, mm - 1, 1);
  const periodEnd = new Date(yy, mm, 0); // last day of month
  if (start > periodEnd) return null;
  if (r.end_date) {
    const end = new Date(r.end_date + "T00:00:00");
    if (end < periodStart) return null;
  }
  const monthsSinceStart = (yy - start.getFullYear()) * 12 + (mm - 1 - start.getMonth());
  if (monthsSinceStart < 0) return null;
  if (r.frequency === "quarterly" && monthsSinceStart % 3 !== 0) return null;
  if (r.frequency === "yearly" && monthsSinceStart % 12 !== 0) return null;
  // monthly always matches; no modulus required.
  const day = Math.min(r.day_of_month, new Date(yy, mm, 0).getDate());
  const target = `${yy}-${String(mm).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  // Guard: never post before start_date (protects mid-month starts).
  if (target < r.start_date) return null;
  if (r.end_date && target > r.end_date) return null;
  return target;
}

// True if an expense row already exists for this recurring template and period
// (matched by month, so a manual date-shift within the month still counts).
export async function isPeriodPosted(recurringId: number, periodYYYYMM: string): Promise<boolean> {
  const d = await db();
  const rows = await d.select<Array<{ n: number }>>(
    `SELECT COUNT(*) AS n FROM expenses WHERE recurring_id=? AND substr(date,1,7)=?`,
    [recurringId, periodYYYYMM]
  );
  return (rows[0]?.n ?? 0) > 0;
}

// Async version that considers the actual posted state (per-period, not
// high-water). Prefer this in UIs; keeps backfilling missed months possible.
export async function nextDueForPeriod(r: RecurringExpense, periodYYYYMM: string): Promise<string | null> {
  const target = targetDateForPeriod(r, periodYYYYMM);
  if (!target) return null;
  if (await isPeriodPosted(r.id, periodYYYYMM)) return null;
  return target;
}

// Post a recurring template for a specific date. Idempotent per (recurring_id,
// month) — a partial unique index enforces this at the DB layer, so a crash
// between insert and last_posted_date update can never produce a duplicate.
export async function postRecurring(rid: number, targetDate: string, overrideAmount?: number): Promise<number> {
  const d = await db();
  const rows = await d.select<RecurringExpense[]>("SELECT * FROM recurring_expenses WHERE id=?", [rid]);
  const r = rows[0];
  if (!r) throw new Error("Recurring template not found");
  if (targetDate < r.start_date) throw new Error(`Cannot post before start date ${r.start_date}`);
  if (r.end_date && targetDate > r.end_date) throw new Error(`Cannot post after end date ${r.end_date}`);
  const period = targetDate.slice(0, 7);
  if (await isPeriodPosted(rid, period)) {
    throw new Error(`${r.name} is already posted for ${period}`);
  }
  const amt = roundMoney(overrideAmount ?? r.amount);
  const id = await saveExpense({
    date: targetDate,
    category: r.category,
    subcategory: r.subcategory,
    vendor: r.vendor,
    amount: amt,
    payment_method: r.payment_method,
    reference: null,
    notes: r.notes ? `[${r.name}] ${r.notes}` : `[${r.name}]`,
    recurring_id: r.id,
  });
  // Advisory bookkeeping; not authoritative. isPeriodPosted() drives gating.
  await execRetry(
    "UPDATE recurring_expenses SET last_posted_date=? WHERE id=? AND (last_posted_date IS NULL OR last_posted_date < ?)",
    [targetDate, rid, targetDate]
  );
  return id;
}

// Aggregate by category between two dates.
export async function summaryByCategory(from: string, to: string): Promise<Array<{ category: string; total: number; count: number }>> {
  const d = await db();
  return d.select<Array<{ category: string; total: number; count: number }>>(
    `SELECT category, SUM(amount) AS total, COUNT(*) AS count
     FROM expenses WHERE date >= ? AND date <= ?
     GROUP BY category ORDER BY total DESC`,
    [from, to]
  );
}

// Aggregate by month within a year range.
export async function summaryByMonth(from: string, to: string): Promise<Array<{ ym: string; total: number; count: number }>> {
  const d = await db();
  return d.select<Array<{ ym: string; total: number; count: number }>>(
    `SELECT substr(date,1,7) AS ym, SUM(amount) AS total, COUNT(*) AS count
     FROM expenses WHERE date >= ? AND date <= ?
     GROUP BY ym ORDER BY ym`,
    [from, to]
  );
}

// Revenue basis for P&L. "parent_paid" = only what parents actually paid the
// daycare (default). "operating" = daycare's operating revenue, which for
// non-profit BC daycares typically includes ACCB paid to the daycare on
// behalf of families and the CCFRI amount received from government.
// CCFRI is netted from receipt.amount already (amount = parent_pays after
// CCFRI), so operating revenue = parent_pays + ccfri + accb ~= gross_amount.
export type RevenueBasis = "parent_paid" | "operating";

// Whitelist so `basis` can never be user-controlled SQL, even if a future
// refactor threads it through from a settings row or URL param.
function revenueExpr(basis: RevenueBasis): string {
  return basis === "operating" ? "COALESCE(gross_amount, amount)" : "amount";
}

export async function revenueSummary(from: string, to: string, basis: RevenueBasis = "parent_paid"): Promise<{ total: number; count: number }> {
  const d = await db();
  // parent_paid = what parents actually paid. operating = gross fee (parent + CCFRI + ACCB).
  const expr = revenueExpr(basis);
  const rows = await d.select<Array<{ total: number; count: number }>>(
    `SELECT COALESCE(SUM(CASE WHEN is_refund=1 THEN -(${expr}) ELSE (${expr}) END),0) AS total,
            COUNT(*) AS count
     FROM receipts WHERE date >= ? AND date <= ? AND voided=0`,
    [from, to]
  );
  return rows[0] || { total: 0, count: 0 };
}

export async function revenueByMonth(from: string, to: string, basis: RevenueBasis = "parent_paid"): Promise<Array<{ ym: string; total: number }>> {
  const d = await db();
  const expr = revenueExpr(basis);
  return d.select<Array<{ ym: string; total: number }>>(
    `SELECT substr(date,1,7) AS ym,
            COALESCE(SUM(CASE WHEN is_refund=1 THEN -(${expr}) ELSE (${expr}) END),0) AS total
     FROM receipts WHERE date >= ? AND date <= ? AND voided=0
     GROUP BY ym ORDER BY ym`,
    [from, to]
  );
}

// ---------- Import batches ----------
// Rolling back an import: delete every expense tagged with the same batch id.
export async function deleteImportBatch(batchId: string): Promise<number> {
  const res = await execRetry("DELETE FROM expenses WHERE import_batch_id=?", [batchId]);
  return res.rowsAffected;
}

export async function listImportBatches(limit = 20): Promise<Array<{ batch_id: string; count: number; total: number; first_date: string; last_date: string; imported_at: string }>> {
  const d = await db();
  return d.select(
    `SELECT import_batch_id AS batch_id, COUNT(*) AS count, SUM(amount) AS total,
            MIN(date) AS first_date, MAX(date) AS last_date, MAX(created_at) AS imported_at
     FROM expenses WHERE import_batch_id IS NOT NULL
     GROUP BY import_batch_id
     ORDER BY imported_at DESC
     LIMIT ${Number(limit) | 0}`
  );
}
