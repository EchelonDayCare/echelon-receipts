-- v3.24.1 — stale-draft detection.
--
-- Adds `base_content_hash` to `site_revisions` so PageEditor can
-- surface a banner when the working-copy version of a file has
-- moved (via git pull or a publish from another machine) since
-- the current draft was made.
--
-- Nullable — pre-existing drafts stay unhashed and are treated as
-- "unknown base", which the UI renders as a neutral state rather
-- than a false-positive staleness warning.

ALTER TABLE site_revisions ADD COLUMN base_content_hash TEXT;
