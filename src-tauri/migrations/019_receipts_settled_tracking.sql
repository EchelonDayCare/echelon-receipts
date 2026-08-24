-- v3.24.4 (#5): Track when a pending receipt was settled so historical
-- Aging A/R reports don't retroactively "un-outstand" balances that were
-- genuinely overdue as of a past reference date.
--
-- Prior behaviour: aging query pulled `WHERE pending_amount > 0`, which
-- meant clearing a pending balance (setting pending_amount = 0) also
-- erased it from historical aging views. Running "aging as of 2024-06-01"
-- today would omit receipts that were pending on that date but have
-- since been paid.
--
-- Fix: mark WHEN pending was cleared (`settled_at`) and, optionally,
-- WHICH later receipt settled it (`settled_by_receipt_id`). Aging query
-- now includes rows that are either still pending OR were settled after
-- the as-of date.
ALTER TABLE receipts ADD COLUMN settled_at TEXT;
ALTER TABLE receipts ADD COLUMN settled_by_receipt_id INTEGER
  REFERENCES receipts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_receipts_settled_at ON receipts(settled_at);
