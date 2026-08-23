-- v3.20.0 PR 3: Website CMS — media pipeline (photos, logo, favicons, OG image).
--
-- The desktop app becomes the sole authoring surface for images on
-- echelondaycare.com. Every upload runs through the deterministic
-- `website_media::pipeline` (BLAKE3 filenames + EXIF strip + 3
-- widths × 3 formats) so the DB, the working-copy `assets/img/**`,
-- and the site's `content/gallery.json` all stay consistent.
--
-- Row layout:
--   * `site_media`         — one row per uploaded original. `kind`
--                            partitions the photo library into gallery
--                            photos vs. brand assets (logo / favicon /
--                            og_image). `deleted_at` gives soft-delete
--                            so the working-copy sweep on publish can
--                            garbage-collect files that no longer have
--                            a referring row.
--   * `site_media_variants`— one row per derived variant (width +
--                            format). The pipeline writes these to
--                            `assets/img/gallery/` (photo) or
--                            `assets/img/` (logo/favicon/og).
--   * `site_emergency_removes` — audit log of parent-driven takedown
--                            requests. `processed_at` is filled in by
--                            the publish-time history-rewrite (a
--                            future PR).
--
-- The `base_hash` column stores the 16-char hex prefix of the source
-- photo hash, mirroring the filename shape used by
-- `website_media::hash::filename`. UNIQUE lets us bounce duplicate
-- uploads without re-encoding.

CREATE TABLE IF NOT EXISTS site_media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    base_hash TEXT UNIQUE NOT NULL,
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
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_site_media_kind
    ON site_media(kind, deleted_at);

CREATE TABLE IF NOT EXISTS site_media_variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL REFERENCES site_media(id) ON DELETE CASCADE,
    width INTEGER NOT NULL,
    format TEXT NOT NULL,
    filename TEXT NOT NULL,
    bytes_len INTEGER NOT NULL,
    UNIQUE(media_id, width, format)
);

CREATE INDEX IF NOT EXISTS idx_site_media_variants_media
    ON site_media_variants(media_id);

CREATE TABLE IF NOT EXISTS site_emergency_removes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL REFERENCES site_media(id),
    reason TEXT NOT NULL,
    requested_at TEXT NOT NULL DEFAULT (datetime('now')),
    requested_by TEXT NOT NULL,
    processed_at TEXT,
    error TEXT
);
