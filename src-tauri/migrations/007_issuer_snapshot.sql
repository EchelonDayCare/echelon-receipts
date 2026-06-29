-- Migration 007: snapshot of issuer (daycare) details on each receipt
-- so historical PDFs render with the values that were current at issue time,
-- not whatever Settings happen to say today.
ALTER TABLE receipts ADD COLUMN issuer_snapshot_json TEXT;
ALTER TABLE annual_receipts ADD COLUMN issuer_snapshot_json TEXT;
