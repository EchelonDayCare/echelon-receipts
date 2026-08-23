-- v3.20.0 PR 2: Website CMS — text-only editable content module.
--
-- The desktop app becomes the authoring surface for
-- `EchelonDayCare/echelon-website` (content/*.json). Every editor
-- save creates an immutable revision row so the user can restore any
-- prior version; `site_pointers` records which revision is the
-- current draft, which was last pushed to Pages, and which was last
-- observed live. `site_publications` is the audit log of publish
-- attempts — one row per publish run, with the state-machine
-- terminal state and commit sha (if a commit was produced).
--
-- Design notes:
--   * `file` in site_revisions / site_pointers is the bare content
--     basename WITHOUT the `.json` extension ("site", "home",
--     "about"). Kept short so pointer joins stay cheap and the FK
--     column matches the file id the JS layer uses.
--   * Revisions are per-file, not per-publish. A publish snapshots
--     the current draft revision of every file at kickoff.
--   * No media / gallery rows — PR 3 adds a companion `site_assets`
--     table.

CREATE TABLE IF NOT EXISTS site_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file TEXT NOT NULL,
    content_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    author TEXT
);

CREATE INDEX IF NOT EXISTS idx_site_revisions_file_created
    ON site_revisions(file, created_at DESC);

CREATE TABLE IF NOT EXISTS site_pointers (
    file TEXT PRIMARY KEY,
    active_draft_rev INTEGER,
    last_pushed_rev INTEGER,
    last_verified_live_rev INTEGER,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS site_publications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    state TEXT NOT NULL,
    commit_sha TEXT,
    error TEXT,
    verified_url TEXT
);

CREATE INDEX IF NOT EXISTS idx_site_publications_started
    ON site_publications(started_at DESC);
