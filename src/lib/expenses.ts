import { db, execRetry } from "./db";

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
  last_posted_date: string | null;
  created_at: string;
};

export async function listExpenses(opts: {
  from?: string;
  to?: string;
  category?: string;
  payment_method?: string;
  q?: string;
  limit?: number;
} = {}): Promise<Expense[]> {
  const d = await db();
  const where: string[] = [];
  const params: any[] = [];
  if (opts.from) { where.push("date >= ?"); params.push(opts.from); }
  if (opts.to)   { where.push("date <= ?"); params.push(opts.to); }
  if (opts.category) { where.push("category = ?"); params.push(opts.category); }
  if (opts.payment_method) { where.push("payment_method = ?"); params.push(opts.payment_method); }
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
  if (e.id) {
    await execRetry(
      `UPDATE expenses SET date=?, category=?, subcategory=?, vendor=?, amount=?, payment_method=?, reference=?, notes=?
       WHERE id=?`,
      [e.date, e.category, e.subcategory || null, e.vendor || null, e.amount, e.payment_method, e.reference || null, e.notes || null, e.id]
    );
    return e.id;
  }
  const d = await db();
  await execRetry(
    `INSERT INTO expenses(date, category, subcategory, vendor, amount, payment_method, reference, notes, recurring_id)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    [e.date, e.category, e.subcategory || null, e.vendor || null, e.amount, e.payment_method, e.reference || null, e.notes || null, e.recurring_id || null]
  );
  const r = await d.select<{ id: number }[]>("SELECT last_insert_rowid() AS id");
  return r[0].id;
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
  if (r.id) {
    await execRetry(
      `UPDATE recurring_expenses SET name=?, category=?, subcategory=?, vendor=?, amount=?, payment_method=?,
        frequency=?, day_of_month=?, start_date=?, end_date=?, active=?, notes=? WHERE id=?`,
      [r.name, r.category, r.subcategory || null, r.vendor || null, r.amount, r.payment_method,
       r.frequency || "monthly", r.day_of_month || 1, r.start_date, r.end_date || null,
       r.active ? 1 : 0, r.notes || null, r.id]
    );
    return r.id;
  }
  const d = await db();
  await execRetry(
    `INSERT INTO recurring_expenses(name, category, subcategory, vendor, amount, payment_method, frequency, day_of_month, start_date, end_date, active, notes)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [r.name, r.category, r.subcategory || null, r.vendor || null, r.amount, r.payment_method,
     r.frequency || "monthly", r.day_of_month || 1, r.start_date, r.end_date || null,
     r.active === 0 ? 0 : 1, r.notes || null]
  );
  const x = await d.select<{ id: number }[]>("SELECT last_insert_rowid() AS id");
  return x[0].id;
}

export async function deleteRecurring(id: number): Promise<void> {
  await execRetry("DELETE FROM recurring_expenses WHERE id=?", [id]);
}

// Determine whether a recurring template is "due" for a target period (YYYY-MM)
// Returns the date-string it should be posted on, or null if not due / already posted.
export function nextDueForPeriod(r: RecurringExpense, periodYYYYMM: string): string | null {
  if (!r.active) return null;
  const [yy, mm] = periodYYYYMM.split("-").map(Number);
  const start = new Date(r.start_date + "T00:00:00");
  const periodEnd = new Date(yy, mm, 0); // last day of month
  if (start > periodEnd) return null;
  if (r.end_date) {
    const end = new Date(r.end_date + "T00:00:00");
    if (end < new Date(yy, mm - 1, 1)) return null;
  }
  // Frequency check relative to start month
  const monthsSinceStart = (yy - start.getFullYear()) * 12 + (mm - 1 - start.getMonth());
  if (monthsSinceStart < 0) return null;
  if (r.frequency === "monthly" && monthsSinceStart % 1 !== 0) return null;
  if (r.frequency === "quarterly" && monthsSinceStart % 3 !== 0) return null;
  if (r.frequency === "yearly" && monthsSinceStart % 12 !== 0) return null;
  // Build target date
  const day = Math.min(r.day_of_month, new Date(yy, mm, 0).getDate());
  const target = `${yy}-${String(mm).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (r.last_posted_date && r.last_posted_date >= target) return null;
  return target;
}

export async function postRecurring(rid: number, targetDate: string): Promise<number> {
  const d = await db();
  const rows = await d.select<RecurringExpense[]>("SELECT * FROM recurring_expenses WHERE id=?", [rid]);
  const r = rows[0];
  if (!r) throw new Error("Recurring template not found");
  const id = await saveExpense({
    date: targetDate,
    category: r.category,
    subcategory: r.subcategory,
    vendor: r.vendor,
    amount: r.amount,
    payment_method: r.payment_method,
    reference: null,
    notes: r.notes ? `[${r.name}] ${r.notes}` : `[${r.name}]`,
    recurring_id: r.id,
  });
  await execRetry("UPDATE recurring_expenses SET last_posted_date=? WHERE id=?", [targetDate, rid]);
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

// Revenue for the same period from receipts (for P&L).
export async function revenueSummary(from: string, to: string): Promise<{ total: number; count: number }> {
  const d = await db();
  const rows = await d.select<Array<{ total: number; count: number }>>(
    `SELECT COALESCE(SUM(CASE WHEN is_refund=1 THEN -amount ELSE amount END),0) AS total,
            COUNT(*) AS count
     FROM receipts WHERE date >= ? AND date <= ? AND voided=0`,
    [from, to]
  );
  return rows[0] || { total: 0, count: 0 };
}

export async function revenueByMonth(from: string, to: string): Promise<Array<{ ym: string; total: number }>> {
  const d = await db();
  return d.select<Array<{ ym: string; total: number }>>(
    `SELECT substr(date,1,7) AS ym,
            COALESCE(SUM(CASE WHEN is_refund=1 THEN -amount ELSE amount END),0) AS total
     FROM receipts WHERE date >= ? AND date <= ? AND voided=0
     GROUP BY ym ORDER BY ym`,
    [from, to]
  );
}
