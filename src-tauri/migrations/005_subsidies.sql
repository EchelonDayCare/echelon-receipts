-- BC subsidy support (CCFRI + ACCB). $10aDay intentionally omitted.

-- Master kill-switch ("pre-CCFRI" rollback word flips this to '0').
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('subsidies_enabled',        '0'),
    ('gross_monthly_fee',        ''),
    ('ccfri_monthly_reduction',  ''),
    ('subsidy_stmt_subject',     'Monthly Fee Breakdown - {{student}} - {{month_label}} {{year}}'),
    ('subsidy_stmt_body',        'Hi,

Please find attached the monthly fee breakdown for {{student}} for {{month_label}} {{year}}.

This shows how the BC government subsidies (CCFRI and any Affordable Child Care Benefit) reduced your gross monthly fee to the amount you actually paid. The amount you paid is what appears on your Annual Tax Receipt for the CRA.

If you have any questions, please reply to this email.

Thank you,
Echelon Daycare Society
{{contact_email}} | {{contact_phone}}');

-- Per-student overrides (rare; most kids use the daycare-wide defaults)
ALTER TABLE students ADD COLUMN gross_override REAL;

-- Per-student per-month ACCB ledger
CREATE TABLE IF NOT EXISTS accb_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    amount REAL NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(student_id, year, month),
    FOREIGN KEY (student_id) REFERENCES students(id)
);
CREATE INDEX IF NOT EXISTS idx_accb_student ON accb_entries(student_id);
CREATE INDEX IF NOT EXISTS idx_accb_period  ON accb_entries(year, month);

-- Receipt breakdown columns. 'amount' continues to mean "parent paid out-of-pocket"
-- so existing receipts + annual receipt totals remain CRA-correct.
ALTER TABLE receipts ADD COLUMN gross_amount REAL;
ALTER TABLE receipts ADD COLUMN ccfri_amount REAL;
ALTER TABLE receipts ADD COLUMN accb_amount  REAL;
