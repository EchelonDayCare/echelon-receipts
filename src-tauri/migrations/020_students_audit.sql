-- v3.24.4 (#10): Students audit log so AGM historical roster counts stay
-- accurate even after students are added, deactivated, or removed.
--
-- Prior behaviour: AGM report queried `students` at read time, so any
-- withdrawal/deletion after the fiscal year closed retroactively lowered
-- that year's reported roster. Auditors called this out.
--
-- Fix: log every INSERT / UPDATE(active) / DELETE to students_audit with
-- a UTC timestamp. AGM reports for closed fiscal years replay the audit
-- log up to the FY-end boundary to reconstruct the roster snapshot.
--
-- Retroactive backfill is impossible for years that already had mutations
-- before this migration ran; those years continue to use live-count
-- fallback and are flagged in the UI. Going forward, closed years are
-- immutable.

CREATE TABLE IF NOT EXISTS students_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  op TEXT NOT NULL CHECK(op IN ('insert','update_active','delete')),
  at_utc TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  year INTEGER,
  active_before INTEGER,
  active_after INTEGER,
  name_snapshot TEXT
);

CREATE INDEX IF NOT EXISTS idx_students_audit_year_at
  ON students_audit(year, at_utc);
CREATE INDEX IF NOT EXISTS idx_students_audit_student
  ON students_audit(student_id);

-- Trigger: INSERT
CREATE TRIGGER IF NOT EXISTS trg_students_audit_insert
AFTER INSERT ON students
BEGIN
  INSERT INTO students_audit(student_id, op, year, active_after, name_snapshot)
  VALUES (NEW.id, 'insert', NEW.year, NEW.active, NEW.name);
END;

-- Trigger: UPDATE of active flag (roster changes)
CREATE TRIGGER IF NOT EXISTS trg_students_audit_active
AFTER UPDATE OF active ON students
WHEN OLD.active IS NOT NEW.active
BEGIN
  INSERT INTO students_audit(student_id, op, year, active_before, active_after, name_snapshot)
  VALUES (NEW.id, 'update_active', NEW.year, OLD.active, NEW.active, NEW.name);
END;

-- Trigger: DELETE
CREATE TRIGGER IF NOT EXISTS trg_students_audit_delete
AFTER DELETE ON students
BEGIN
  INSERT INTO students_audit(student_id, op, year, active_before, name_snapshot)
  VALUES (OLD.id, 'delete', OLD.year, OLD.active, OLD.name);
END;
