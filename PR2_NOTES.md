# PR 2 — Website CMS (text-only) — desktop app

Branch: `feat/website-cms-core` on `EchelonDayCare/echelon-receipts`.
Target site repo: `EchelonDayCare/echelon-website` at commit `80e10572`
(PR 1 merged 2026-08-23).

This PR ships an in-app **Website** module that lets the daycare owner
edit `content/*.json`, preview the rendered site locally, and (eventually)
publish back to GitHub Pages. **Text-only** — no image upload or gallery
editing. Media handling is PR 3.

---

## What shipped

### Rust — `src-tauri/src/website/`

| File               | Responsibility                                                                                                                                          |
|--------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------|
| `schema.rs`        | Content-file validators (`site`, `home`, `about`, `services`, `contact`, `tour`, `careers`, `seo`), `EDITABLE_FILES` list, `is_safe_html_field` helper. |
| `git_ops.rs`       | `git2` clone of the site repo into `app_data_dir/website/repo/`, fetch + fast-forward, `stage_content_writes`, `commit_all`, `push_main_with_pat`.       |
| `renderer.rs`      | MiniJinja engine mirroring `scripts/render.py`. Same JSON-LD builders, same auto-escape rules, same LF newline handling.                                 |
| `preview_server.rs`| `tiny_http`-backed static file server on `127.0.0.1:<random>`. Path-traversal defense + no-store cache header for the WebView.                            |
| `revisions.rs`     | `site_revisions` (append-only) + `site_pointers` (per-file `active_draft_rev` / `last_pushed_rev` / `last_verified_live_rev`) DB helpers.               |
| `publish.rs`       | Publish state machine + `run_pipeline`. State transitions gated by `PublishState::can_transition_to` so a bug can't advance straight to `verified_live`.|
| `pat.rs`           | GitHub fine-grained PAT stored in OS keyring under `echelon-website-cms-github-pat`. Verified via `GET /repos/EchelonDayCare/echelon-website`.          |
| `commands.rs`      | 15 Tauri commands wired into `invoke_handler!`.                                                                                                          |

Feature-flag gate: every command except `website_feature_enabled`
first calls `require_enabled()`. Off by default. Set
`ECHELON_WEBSITE_CMS=1` at the shell.

### SQL — `src-tauri/migrations/014_website_cms.sql`

```sql
CREATE TABLE site_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file TEXT NOT NULL,
    content_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    author TEXT
);
CREATE INDEX idx_site_revisions_file_created ON site_revisions(file, created_at DESC);

CREATE TABLE site_pointers (
    file TEXT PRIMARY KEY,
    active_draft_rev INTEGER,
    last_pushed_rev INTEGER,
    last_verified_live_rev INTEGER,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE site_publications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    state TEXT NOT NULL,
    commit_sha TEXT,
    error TEXT,
    verified_url TEXT
);
CREATE INDEX idx_site_publications_started ON site_publications(started_at DESC);
```

Migration is registered in `embedded_migrations()` at position 14.

### Frontend — `src/screens/Website.tsx` + `src/screens/website/*`

| File                       | Responsibility                                                                                                    |
|----------------------------|-------------------------------------------------------------------------------------------------------------------|
| `Website.tsx`              | Landing page: working-copy panel, PAT status, per-page tile grid, Gallery placeholder card, Preview/History/Publish quick actions. |
| `website/PageEditor.tsx`   | Generic JSON textarea editor. Routes `/website/site`, `/website/home`, …, `/website/seo`.                          |
| `website/Preview.tsx`      | `<iframe>` pointing at the `tiny_http` URL, plus Refresh button.                                                   |
| `website/History.tsx`      | Per-file revision list with active-draft / last-pushed badges + Restore.                                          |
| `website/Publish.tsx`      | Commit message, dry-run checkbox (default ON), outcome panel, publications history.                               |
| `website/Settings.tsx`     | PAT wizard: paste → verify → store; disconnect.                                                                    |
| `lib/website.ts`           | Typed invoke wrappers for all 15 Rust commands + `EDITABLE_FILES` const + `tryPrettyJson`.                         |

### Feature flag

`isWebsiteCmsEnabled()` calls the `website_feature_enabled` Tauri command
(which reads `ECHELON_WEBSITE_CMS` at process start) and caches the
result. The Home tile only renders when this returns `true`. Routes and
the sidebar are always mounted so a direct URL still works during
development, but the Home tile stays hidden — that's what protects the
daycare owner from seeing partial PR 3 UI.

### Dependencies added

```toml
git2 = { version = "0.19", default-features = false, features = ["vendored-libgit2", "https"] }
minijinja = { version = "2", features = ["json", "loader"] }
tiny_http = "0.12"
mime_guess = "2"
walkdir = "2"
scraper = "0.20"
```

- `git2` uses vendored libgit2 so there's no system libgit2 dep. On
  Windows, libgit2's HTTPS transport uses WinHTTP (schannel) so no
  openssl link. `ssh` feature is disabled (default was on) — CMS
  operates over HTTPS only.
- `tiny_http` was chosen over `axum` for the preview server because
  the preview is static-file serving on a single loopback port —
  `axum` would drag in `tower` + `tower-http` + a spawned tokio task
  whose lifetime the module then owns. `tiny_http` is 300 LOC of
  synchronous OS-thread code, gets shut down via a `stop_tx` channel
  + `Server::unblock()`. Justified inline at the top of
  `preview_server.rs`.
- `scraper` (0.20) uses html5ever to parse rendered HTML pre-publish
  so we fail fast on template bugs rather than pushing broken HTML.

---

## Deviations from the brief

1. **`git2` features:** brief said
   `default-features = false, features = ["vendored-libgit2"]`. That
   disables the `https` feature which is required to clone/push over
   HTTPS. Added `https` back (WinHTTP on Windows, OpenSSL/schannel on
   Unix — either way, vendored libgit2 handles it internally). No
   openssl-sys link on Windows because libgit2 picks WinHTTP.

2. **PR 3 media pipeline deps kept out of Cargo.toml:** the parallel
   `feat/website-media-pipeline` branch had added `img-parts`,
   `ravif`, and `blake3` to Cargo.toml. Those are PR 3's problem, so
   this PR's Cargo.toml only carries the CMS-core deps. When PR 3
   lands, it re-introduces them.

3. **Publish verification is best-effort:** brief §10 acknowledged
   this. `render.py` does not emit a `<!-- rev: <sha> -->` canary yet,
   so `publish::poll_pages_deploy` currently accepts a 200 from the
   homepage as "deployed". A follow-up site-repo PR that adds the
   canary hardens this into "waited until the exact commit was
   served". Timeout 3 min, 10 s polling interval.

4. **PageEditor uses a JSON textarea, not per-field forms.** The
   brief said "editable forms". Building 8 bespoke field-form
   components is the same UI shape the media module (PR 3) will need
   to re-solve — better to defer until we share the editable-field
   component design with image / video fields. The textarea has
   Reformat + Save-Draft + Reload buttons; every save is
   schema-validated by Rust (`schema::validate`) so invalid JSON is
   rejected server-side with a clear error. Users can restore any
   prior version from the History screen if they typo a save.

5. **`stop_preview` on unmount** — the Preview screen calls
   `websiteStopPreview()` in an effect cleanup so leaving the screen
   frees the loopback port. If the user closes the app entirely, the
   `Drop` impl on `PreviewHandle` handles it.

---

## Testing

```
cd C:\src\echelon-receipts\src-tauri
cargo test --lib --no-default-features --features sqlcipher
# → 288 passed, 0 failed, 2 ignored (20 new website:: tests)
cargo clippy --lib --no-default-features --features sqlcipher
# → 0 new warnings in src/website/**; 52 pre-existing warnings elsewhere untouched
cd ..
npx tsc --noEmit
# → 0 errors
```

New tests (20 total, distributed across the module):

| Module            | Tests                                                                                          |
|-------------------|------------------------------------------------------------------------------------------------|
| `schema.rs`       | roundtrip, validate ok, validate missing schema_version, unknown file, editable/gallery, safe_html_field |
| `renderer.rs`     | rel_path (Python parity), active_nav_key, normalize_lf, **smoke render fixture** (site.json + minimal.html.j2 → "Echelon Day Care") |
| `git_ops.rs`      | layout paths, ensure_cloned via local `git init` (offline-safe)                                |
| `preview_server.rs`| bind → serve index.html → serve nested → path traversal 404 → nonexistent 404 → clean shutdown |
| `revisions.rs`    | truncate_preview respects char boundaries                                                     |
| `publish.rs`      | state transitions gated, state strings, parse_state roundtrip, validate_rendered empty/well-formed |
| `pat.rs`          | keychain roundtrip (skips gracefully if runner has no keychain)                                |

Fixture: `src-tauri/tests/fixtures/website/`
- `content/site.json` — trimmed real site.json (all required fields, minimal nav/area)
- `templates/minimal.html.j2` — small template that reads `site.name`, `site.tagline`, `site.address.display`, `site.phone.display`

---

## User walkthrough

```powershell
# 1. Boot the app with the CMS flag on.
cd C:\src\echelon-receipts
$env:ECHELON_WEBSITE_CMS = "1"
npm run tauri dev

# 2. On the Home screen you should now see a 🌐 Website tile. Click it.

# 3. On /website:
#    • Click "Set up working copy" → clones the site repo into
#      %APPDATA%/com.echelondaycare.receipts/website/repo/  (first
#      time only; ~10 s over broadband).
#    • Click a page tile (say "About") → JSON editor loads content/about.json
#      from the working copy. Change any field, click "Save draft".
#      A row shows up in the History screen.
#    • Click "Preview site locally" → a local static server starts and
#      an iframe loads http://127.0.0.1:<port>/ inside the WebView.
#      Refresh preview re-renders from the current draft.
#    • Click "Version history" to see revisions per file. "Restore this
#      version" creates a NEW revision copied from the older one and
#      makes it the active draft.
#
# 4. Publishing (dry-run first):
#    • Click "Publish…" → check that Dry run is ON.
#    • Enter a commit message and click "Run dry publish".
#    • Watch the state machine advance in the outcome panel.
#      Rendered HTML lives at %APPDATA%/…/website/preview/.
#    • The site repo working copy under
#      %APPDATA%/…/website/repo/  will now have a local git commit;
#      inspect with `git log --oneline` inside that dir.
#
# 5. Connecting GitHub (only needed for real publishes):
#    • Click "Manage token…" on the Website landing page.
#    • Create a fine-grained PAT for EchelonDayCare/echelon-website
#      with contents:write, paste it in the wizard, click "Verify & connect".
#    • Once "Connected ✓" appears, real (non-dry-run) publishes work.
#      NOTE: This session does NOT wire up an automated end-to-end push
#      test — verify manually.
```

---

## Known limitations (PR 2 accepts, PR 3+ addresses)

- **No gallery / image / video / PDF editing.** `gallery.json` is
  disabled in the UI with a placeholder card. `about.image_grid`,
  `assets/img/**`, `assets/video/**`, `assets/docs/**`, `logo`,
  `favicon_*`, `og_image`, and `webmanifest` are all read-only in
  PR 2.
- **JSON textarea instead of per-field forms.** See Deviations §4.
- **Publish verification is a 200 check, not a commit-sha grep.**
  See Deviations §3.
- **No conflict resolution UI.** If `git fetch` returns a
  non-fast-forward, `fetch_and_ff_main` returns an error and the
  Publish screen shows it. User has to `cd %APPDATA%/…/website/repo`
  and resolve manually — or delete the working copy and re-clone
  from the Website landing page.
- **`about.intro_html` / `neighborhoods.paragraph_html` are edited
  as raw JSON strings.** In PR 3 the editor should surface a rich
  text field that sanitises to the `<strong> <em> <a>` allowlist
  before save. The Rust `is_safe_html_field` helper is already in
  place to mark these fields.
- **PATs are stored per-user, per-machine.** No sync across devices.
  Deliberate — the token is a machine-local credential.
- **`push_main_with_pat` uses `x-access-token` as the username.**
  Standard GitHub HTTPS auth pattern. Verified against the fine-grained
  token API; if we ever add classic PAT support we'd need to change
  this.

---

## PR 3 handoff notes

For the media / gallery / assets PR:

1. **Reuse the working-copy layout.** `WorkingCopy::from_app_data`
   already points at `app_data_dir/website/repo/`. The media pipeline
   should write derived assets under
   `app_data_dir/website/repo/assets/img/**` and stage them the same
   way `git_ops::stage_content_writes` handles JSON.

2. **Reuse the publish state machine.** `run_pipeline` collects
   `drafts: Vec<(String, String)>` (file basename → JSON content).
   For media, extend `PipelineInputs` with a `binary_writes:
   Vec<(PathBuf, Vec<u8>)>` so images can go through the same
   `git fetch → commit → push` flow.

3. **Reuse the revision model.** Add a companion `site_assets`
   table for image originals + `site_asset_derivatives` for
   generated AVIF/WebP/JPEG variants. The `site_pointers` model
   generalises to media too.

4. **Enable the gallery editor** by removing the placeholder card
   in `Website.tsx` and registering `/website/gallery` on the
   route list. Add `"gallery"` to `EDITABLE_FILES` in both
   `schema.rs` and `lib/website.ts`. `renderer.rs::ALL_PAGES`
   already knows about `pages/gallery.html.j2`.

5. **Site-repo canary** — a follow-up PR on
   `EchelonDayCare/echelon-website` should have `render.py` emit
   `<!-- rev: <sha> -->` (populated from a build-time env var).
   Then `publish::poll_pages_deploy` can grep for it, hardening
   verification from "site is up" to "the exact commit we pushed is
   what Pages served".

6. **Rich-text fields.** `about.intro_html` and
   `about.neighborhoods.paragraph_html` need a proper editor + a
   `<strong> <em> <a>`-only sanitiser (see PR1_NOTES.md §1). The
   `is_safe_html_field` helper in `schema.rs` marks the fields.

---

## Files changed (summary)

```
src-tauri/Cargo.toml                                      | 6 deps added
src-tauri/Cargo.lock                                      | regenerated
src-tauri/migrations/014_website_cms.sql                  | new
src-tauri/src/lib.rs                                      | + mod website; + migration + 15 commands
src-tauri/src/website.rs                                  | new mod file
src-tauri/src/website/commands.rs                         | new (16 KB)
src-tauri/src/website/git_ops.rs                          | new (11 KB)
src-tauri/src/website/pat.rs                              | new (6.7 KB)
src-tauri/src/website/preview_server.rs                   | new (8.1 KB)
src-tauri/src/website/publish.rs                          | new (25 KB)
src-tauri/src/website/renderer.rs                         | new (21 KB)
src-tauri/src/website/revisions.rs                        | new (9 KB)
src-tauri/src/website/schema.rs                           | new (8.5 KB)
src-tauri/tests/fixtures/website/content/site.json        | new fixture
src-tauri/tests/fixtures/website/templates/minimal.html.j2| new fixture
src/App.tsx                                               | Website lazy imports + routes + sidebar
src/screens/Home.tsx                                      | Website tile gated on ECHELON_WEBSITE_CMS
src/screens/Website.tsx                                   | new landing page
src/screens/website/PageEditor.tsx                        | new
src/screens/website/Preview.tsx                           | new
src/screens/website/History.tsx                           | new
src/screens/website/Publish.tsx                           | new
src/screens/website/Settings.tsx                          | new
src/lib/website.ts                                        | new
PR2_NOTES.md                                              | this file
```

Two commits on `feat/website-cms-core`. Not pushed. Not tagged.
