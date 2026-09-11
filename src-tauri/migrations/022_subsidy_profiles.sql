-- v3.26.0: Configurable subsidy profiles for different child age groups.
--
-- Existing global gross/CCFRI settings remain the fallback for students
-- without a profile. Assigning a profile is opt-in and does not rewrite
-- historical receipts, whose amounts are already snapshotted.
CREATE TABLE IF NOT EXISTS subsidy_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  gross_monthly_fee REAL NOT NULL DEFAULT 0,
  ccfri_monthly_reduction REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE students ADD COLUMN subsidy_profile_id INTEGER
  REFERENCES subsidy_profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_students_subsidy_profile
  ON students(subsidy_profile_id);
