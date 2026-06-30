-- Staff Hours feature (optional, behind a feature flag)
CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT,
  hourly_rate REAL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);

CREATE INDEX IF NOT EXISTS ix_staff_active ON staff(active);

CREATE TABLE IF NOT EXISTS staff_hours (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  work_date TEXT NOT NULL,        -- yyyy-mm-dd
  in_time TEXT,                   -- HH:MM (nullable for absent/holiday)
  out_time TEXT,                  -- HH:MM
  hours_decimal REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',  -- 'manual' | 'ocr'
  sheet_image_path TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(staff_id, work_date)
);

CREATE INDEX IF NOT EXISTS ix_staff_hours_date ON staff_hours(work_date);
CREATE INDEX IF NOT EXISTS ix_staff_hours_staff ON staff_hours(staff_id);

INSERT OR IGNORE INTO settings(key,value) VALUES
  ('feature_staff_hours_enabled',''),
  ('gemini_api_key_set',''),
  ('staff_default_hourly_rate','');
