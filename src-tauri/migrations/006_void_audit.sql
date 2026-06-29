-- Migration 006: Void audit columns
-- Adds reason + timestamp when a receipt is voided.
ALTER TABLE receipts ADD COLUMN void_reason TEXT;
ALTER TABLE receipts ADD COLUMN voided_at TEXT;
