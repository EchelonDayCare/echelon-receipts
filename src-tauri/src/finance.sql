CREATE TABLE IF NOT EXISTS finance_config (
  id INTEGER PRIMARY KEY CHECK(id=1), start_date TEXT NOT NULL,
  closed_through TEXT, funding_confirmed INTEGER NOT NULL DEFAULT 0,
  opening_confirmed INTEGER NOT NULL DEFAULT 0,
  reviewed_entry_id INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS finance_accounts (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL
    CHECK(kind IN ('bank','card','clearing','income','expense','asset','liability','equity'))
);
CREATE TABLE IF NOT EXISTS finance_openings (
  account TEXT PRIMARY KEY REFERENCES finance_accounts(code), cents INTEGER NOT NULL,
  evidence TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO finance_accounts VALUES
 ('receipts_pending','Parent payments awaiting bank clearance','clearing'),
 ('payments_pending','Payments awaiting bank clearance','clearing'),
 ('card:Visa Credit Card','Visa Credit Card','card'),
 ('card:Mastercard','Mastercard','card'),
 ('parent_fees','Parent fees received','income'),
 ('opening','Opening balances','equity');
CREATE TABLE IF NOT EXISTS finance_entries (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, description TEXT NOT NULL,
  debit TEXT NOT NULL REFERENCES finance_accounts(code),
  credit TEXT NOT NULL REFERENCES finance_accounts(code),
  cents INTEGER NOT NULL CHECK(typeof(cents)='integer' AND cents>0 AND cents<=9000000000000),
  source TEXT NOT NULL, source_id TEXT NOT NULL,
  reversal_of INTEGER UNIQUE REFERENCES finance_entries(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK(debit<>credit)
);
CREATE INDEX IF NOT EXISTS finance_entry_source ON finance_entries(source,source_id);
CREATE TABLE IF NOT EXISTS finance_statements (
  id INTEGER PRIMARY KEY, account TEXT NOT NULL REFERENCES finance_accounts(code),
  date_from TEXT NOT NULL, date_to TEXT NOT NULL,
  opening_cents INTEGER NOT NULL, closing_cents INTEGER NOT NULL,
  source_hash TEXT NOT NULL, source_name TEXT NOT NULL, source_b64 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'review'
    CHECK(status IN ('review','reconciled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account,source_hash), CHECK(date_from<=date_to)
);
CREATE TABLE IF NOT EXISTS finance_lines (
  id INTEGER PRIMARY KEY, statement_id INTEGER NOT NULL REFERENCES finance_statements(id),
  date TEXT NOT NULL, description TEXT NOT NULL,
  cents INTEGER NOT NULL CHECK(typeof(cents)='integer' AND cents<>0 AND abs(cents)<=9000000000000),
  bank_id TEXT, ordinal INTEGER NOT NULL,
  UNIQUE(statement_id,ordinal)
);
CREATE TABLE IF NOT EXISTS finance_allocations (
  id INTEGER PRIMARY KEY, line_id INTEGER NOT NULL REFERENCES finance_lines(id),
  entry_id INTEGER NOT NULL REFERENCES finance_entries(id),
  cents INTEGER NOT NULL CHECK(typeof(cents)='integer' AND cents>0),
  kind TEXT NOT NULL CHECK(kind IN ('receipt','expense','new','transfer','existing')),
  source_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS finance_audit (
  id INTEGER PRIMARY KEY, action TEXT NOT NULL, detail TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS finance_funding_policies (
  id INTEGER PRIMARY KEY, program TEXT NOT NULL,
  treatment TEXT NOT NULL CHECK(treatment IN ('unresolved','cash_income','liability_until_release','not_applicable')),
  rule TEXT NOT NULL, evidence TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS finance_expense_voids (
  expense_id INTEGER PRIMARY KEY REFERENCES expenses(id),
  original_record TEXT NOT NULL, reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS finance_statement_voids (
  statement_id INTEGER PRIMARY KEY REFERENCES finance_statements(id),
  reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS finance_funding_receipts (
  entry_id INTEGER PRIMARY KEY REFERENCES finance_entries(id),
  policy_id INTEGER NOT NULL REFERENCES finance_funding_policies(id),
  program TEXT NOT NULL, period_from TEXT NOT NULL, period_to TEXT NOT NULL,
  reference TEXT NOT NULL, evidence TEXT NOT NULL, CHECK(period_from<=period_to)
);
CREATE TABLE IF NOT EXISTS finance_funding_releases (
  entry_id INTEGER PRIMARY KEY REFERENCES finance_entries(id),
  receipt_id INTEGER NOT NULL REFERENCES finance_funding_receipts(entry_id),
  evidence TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS finance_funding_refunds (
  entry_id INTEGER PRIMARY KEY REFERENCES finance_entries(id),
  receipt_id INTEGER NOT NULL REFERENCES finance_funding_receipts(entry_id),
  evidence TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS finance_report_exports (
  id INTEGER PRIMARY KEY, date_from TEXT NOT NULL, date_to TEXT NOT NULL,
  payload TEXT NOT NULL, superseded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS finance_outstanding_reviews (
  id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL REFERENCES finance_entries(id),
  through_date TEXT NOT NULL, cents INTEGER NOT NULL CHECK(cents>0),
  evidence TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER IF NOT EXISTS finance_entry_no_update BEFORE UPDATE ON finance_entries
BEGIN SELECT RAISE(ABORT,'Posted accounting entries are immutable; use a reversal.'); END;
CREATE TRIGGER IF NOT EXISTS finance_entry_no_delete BEFORE DELETE ON finance_entries
BEGIN SELECT RAISE(ABORT,'Posted accounting entries cannot be deleted.'); END;
CREATE TRIGGER IF NOT EXISTS finance_entry_period BEFORE INSERT ON finance_entries
WHEN NEW.date< (SELECT start_date FROM finance_config WHERE id=1)
 OR NEW.date <= (SELECT closed_through FROM finance_config WHERE id=1)
BEGIN SELECT RAISE(ABORT,'Accounting date is outside the open period.'); END;
CREATE TRIGGER IF NOT EXISTS finance_invalidate AFTER INSERT ON finance_entries
BEGIN
 UPDATE finance_statements SET status='review' WHERE date_to>=NEW.date;
 UPDATE finance_report_exports SET superseded=1 WHERE date_to>=NEW.date;
END;
CREATE TRIGGER IF NOT EXISTS finance_statement_no_delete BEFORE DELETE ON finance_statements
BEGIN SELECT RAISE(ABORT,'Statement evidence cannot be deleted.'); END;
CREATE TRIGGER IF NOT EXISTS finance_line_no_update BEFORE UPDATE ON finance_lines
BEGIN SELECT RAISE(ABORT,'Imported statement evidence is immutable.'); END;
CREATE TRIGGER IF NOT EXISTS finance_line_no_delete BEFORE DELETE ON finance_lines
BEGIN SELECT RAISE(ABORT,'Imported statement evidence cannot be deleted.'); END;
CREATE VIEW IF NOT EXISTS finance_active_entries AS
SELECT e.* FROM finance_entries e WHERE e.reversal_of IS NULL
 AND NOT EXISTS(SELECT 1 FROM finance_entries r WHERE r.reversal_of=e.id);
CREATE VIEW IF NOT EXISTS finance_movements AS
SELECT id,date,debit AS account,cents AS cents FROM finance_entries
UNION ALL SELECT id,date,credit,-cents FROM finance_entries;
