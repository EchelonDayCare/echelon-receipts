-- Staff credentials & drill log (BC compliance helpers)
CREATE TABLE IF NOT EXISTS staff_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  issued_date TEXT,
  expiry_date TEXT,
  file_path TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ix_staff_credentials_staff ON staff_credentials(staff_id);
CREATE INDEX IF NOT EXISTS ix_staff_credentials_expiry ON staff_credentials(expiry_date);

CREATE TABLE IF NOT EXISTS staff_drills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drill_date TEXT NOT NULL,
  drill_type TEXT NOT NULL,
  duration_min INTEGER,
  children_present INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ix_staff_drills_date ON staff_drills(drill_date);

INSERT OR IGNORE INTO settings(key,value) VALUES
  ('staff_cred_alert_days','60');
