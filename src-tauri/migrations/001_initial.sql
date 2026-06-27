CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    father_name TEXT,
    mother_name TEXT,
    email TEXT,
    year INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_students_year ON students(year);
CREATE INDEX IF NOT EXISTS idx_students_name ON students(name);

CREATE TABLE IF NOT EXISTS receipts (
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
);

CREATE INDEX IF NOT EXISTS idx_receipts_date ON receipts(date);
CREATE INDEX IF NOT EXISTS idx_receipts_student ON receipts(student_id);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

INSERT OR IGNORE INTO settings (key, value) VALUES
    ('daycare_name', 'Echelon Daycare Society'),
    ('daycare_address', '101 - 575 W 8th Ave, Vancouver, BC, V5Z 1M9'),
    ('contact_email', 'echelondaycare@hotmail.com'),
    ('contact_phone', '604-874-4010'),
    ('default_fee', '485'),
    ('next_receipt_no', '1001'),
    ('logo_data_url', ''),
    ('signature_data_url', '');
