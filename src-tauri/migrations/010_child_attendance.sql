-- Daily child attendance log (BC Community Care Licensing requires daily
-- in/out records per child). Mirrors staff_hours shape so the UI / helpers
-- can reuse the same patterns.
CREATE TABLE IF NOT EXISTS child_attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  work_date TEXT NOT NULL,        -- yyyy-mm-dd
  in_time TEXT,                   -- HH:MM (nullable for absent)
  out_time TEXT,                  -- HH:MM
  hours_decimal REAL NOT NULL DEFAULT 0,
  signed_in_by TEXT,              -- free-text parent / authorized pickup name
  signed_out_by TEXT,
  status TEXT NOT NULL DEFAULT 'present',  -- 'present' | 'absent' | 'sick' | 'late' | 'holiday'
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(student_id, work_date)
);

CREATE INDEX IF NOT EXISTS ix_child_attendance_date ON child_attendance(work_date);
CREATE INDEX IF NOT EXISTS ix_child_attendance_student ON child_attendance(student_id);
