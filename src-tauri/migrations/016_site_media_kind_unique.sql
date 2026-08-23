-- Migration 016: change site_media UNIQUE(base_hash) -> UNIQUE(base_hash, kind)
--
-- The gallery-photo, logo, favicon and OG-image pipelines all write
-- to the same `site_media` table with different `kind` values.
-- Uploading identical bytes as two different kinds (e.g. reusing a
-- logo file as a gallery photo) previously collided on
-- UNIQUE(base_hash) - the first row's kind + variants were
-- clobbered by the in-place UPSERT. Composite uniqueness lets each
-- kind own its own row. Also adds sort_order for drag-order persistence.
--
-- IMPORTANT: with foreign keys enabled (default in this app), a plain
-- DROP TABLE site_media would either cascade-wipe every
-- site_media_variants row or refuse the drop because
-- site_emergency_removes has a non-cascading FK. To preserve them we
-- shuttle both dependent tables through TEMP backups and rebuild them
-- against the renamed site_media table.

CREATE TABLE IF NOT EXISTS site_media_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    base_hash TEXT NOT NULL,
    source_filename TEXT NOT NULL,
    kind TEXT NOT NULL,
    caption TEXT,
    alt TEXT,
    focal_x REAL,
    focal_y REAL,
    width INTEGER,
    height INTEGER,
    original_bytes_len INTEGER,
    exif_stripped INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE(base_hash, kind)
);

INSERT INTO site_media_new (id, base_hash, source_filename, kind, caption, alt,
                             focal_x, focal_y, width, height, original_bytes_len,
                             exif_stripped, created_at, deleted_at)
    SELECT id, base_hash, source_filename, kind, caption, alt,
           focal_x, focal_y, width, height, original_bytes_len,
           exif_stripped, created_at, deleted_at
      FROM site_media;

CREATE TEMP TABLE _site_media_variants_backup AS
    SELECT id, media_id, width, format, filename, bytes_len
      FROM site_media_variants;

CREATE TEMP TABLE _site_emergency_removes_backup AS
    SELECT id, media_id, reason, requested_at, requested_by, processed_at, error
      FROM site_emergency_removes;

DROP TABLE site_media_variants;
DROP TABLE site_emergency_removes;
DROP TABLE site_media;
ALTER TABLE site_media_new RENAME TO site_media;

CREATE TABLE site_media_variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL REFERENCES site_media(id) ON DELETE CASCADE,
    width INTEGER NOT NULL,
    format TEXT NOT NULL,
    filename TEXT NOT NULL,
    bytes_len INTEGER NOT NULL,
    UNIQUE(media_id, width, format)
);

INSERT INTO site_media_variants (id, media_id, width, format, filename, bytes_len)
    SELECT id, media_id, width, format, filename, bytes_len
      FROM _site_media_variants_backup;

DROP TABLE _site_media_variants_backup;

CREATE TABLE site_emergency_removes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL REFERENCES site_media(id),
    reason TEXT NOT NULL,
    requested_at TEXT NOT NULL DEFAULT (datetime('now')),
    requested_by TEXT NOT NULL,
    processed_at TEXT,
    error TEXT
);

INSERT INTO site_emergency_removes (id, media_id, reason, requested_at, requested_by, processed_at, error)
    SELECT id, media_id, reason, requested_at, requested_by, processed_at, error
      FROM _site_emergency_removes_backup;

DROP TABLE _site_emergency_removes_backup;

CREATE INDEX IF NOT EXISTS idx_site_media_kind
    ON site_media(kind, deleted_at);

CREATE INDEX IF NOT EXISTS idx_site_media_sort
    ON site_media(kind, sort_order, id);

CREATE INDEX IF NOT EXISTS idx_site_media_variants_media
    ON site_media_variants(media_id);
