-- Person identity so the same human links across roster years
ALTER TABLE students ADD COLUMN person_id TEXT;
CREATE INDEX IF NOT EXISTS idx_students_person ON students(person_id);

-- Refund / negative-amount support
ALTER TABLE receipts ADD COLUMN is_refund INTEGER DEFAULT 0;

-- Daycare business info (for CRA annual receipts)
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('business_number',    ''),
    ('director_name',      ''),
    ('director_title',     'Managing Director'),
    ('next_ar_no',         '1'),
    ('annual_email_subject', 'Annual Child Care Receipt {{year}} - {{student}}'),
    ('annual_email_body',  'Hi,

Please find attached the Annual Child Care Receipt for {{student}} covering {{year}} (January through December).

Total paid in {{year}}: ${{total}} across {{count}} payments.

You may use this receipt when claiming the Child Care Expenses Deduction (CRA Form T778, Line 21400) on your personal tax return.

If you notice any discrepancy, please reply to this email and we will reissue.

Thank you for trusting us with your child this year.

Echelon Daycare Society
{{contact_email}} | {{contact_phone}}');

-- Annual receipt audit log
CREATE TABLE IF NOT EXISTS annual_receipts (
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
);
CREATE INDEX IF NOT EXISTS idx_annual_person_year ON annual_receipts(person_id, calendar_year);
