-- Métis Child Care Benefit (MCCB) support.
-- MCCB is entered per eligible student/month, alongside ACCB, so the
-- actual funding applied to an issued receipt remains historically accurate.

CREATE TABLE IF NOT EXISTS mccb_entries (
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
CREATE INDEX IF NOT EXISTS idx_mccb_student ON mccb_entries(student_id);
CREATE INDEX IF NOT EXISTS idx_mccb_period ON mccb_entries(year, month);

-- `mccb_amount` is added by the app's defensive schema setup. Keeping the
-- column addition there avoids a duplicate-column recovery failure if an
-- earlier startup already forward-completed the schema.
