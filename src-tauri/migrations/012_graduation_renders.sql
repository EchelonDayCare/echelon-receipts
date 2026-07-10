-- Graduation Day render history.
--
-- Every successful render (reel / per-child / slides) writes one row so
-- Ask Echelon can answer "when was the last reel rendered", "how long
-- did the 2026 ceremony take", etc. Failed / cancelled renders don't
-- persist here — they're already surfaced in the live progress log.
--
-- We intentionally store only non-sensitive metadata: kind, year,
-- output path, duration, frame count, timestamp. No child names, no
-- teacher notes, no photo paths.
CREATE TABLE IF NOT EXISTS graduation_renders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('reel', 'per_child', 'slides')),
    year INTEGER NOT NULL,
    student_id INTEGER,           -- non-null only for per_child renders
    output_path TEXT NOT NULL,
    duration_ms INTEGER,          -- wall-clock render time; NULL for slides
    frames_encoded INTEGER,       -- NULL for slides
    slides_written INTEGER,       -- NULL for reel / per_child
    rendered_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_graduation_renders_year
    ON graduation_renders(year);

CREATE INDEX IF NOT EXISTS idx_graduation_renders_rendered_at
    ON graduation_renders(rendered_at DESC);
