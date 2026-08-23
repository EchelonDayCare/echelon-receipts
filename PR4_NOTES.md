# PR 4 — Website CMS: Gallery editor + media pipeline wiring

**Branch:** `feat/website-gallery-editor` (off `feat/website-media-pipeline`
after that branch's `origin/main` merge)
**App version:** `3.20.0`
**Feature flag:** `ECHELON_WEBSITE_CMS=1`

## What shipped

### Backend (Rust)

- **`src-tauri/src/lib.rs`** — wired the media module (`pub mod website_media;`),
  registered migration 015, and registered 10 new Tauri commands in `invoke_handler`.
- **`src-tauri/migrations/015_website_media.sql`** — new tables:
  `site_media`, `site_media_variants`, `site_emergency_removes`. Indexed
  on `(kind, deleted_at)` for the "list photos, ignoring deleted" query
  the gallery grid runs on every mount.
- **`src-tauri/src/website/media.rs`** — domain logic (515 lines + tests).
  Public API:
  - `ingest_photo(db, repo_dir, source_path, kind, caption, alt)` — runs
    the full `website_media::process_photo` pipeline, writes variants to
    `assets/img/gallery/` (photos) or `assets/img/` (brand), inserts DB
    rows, updates `content/gallery.json`. Dedup-safe via
    `site_media.base_hash` UNIQUE.
  - `reorder_gallery(db, repo_dir, ordered_media_ids)` — rewrites
    `content/gallery.json` items in the passed order.
  - `set_photo_meta(db, repo_dir, media_id, caption, alt, focal)` —
    updates row + rewrites `content/gallery.json`.
  - `soft_delete(db, repo_dir, media_id)` — sets `deleted_at`, removes
    from `content/gallery.json`. Working-copy files stay until a
    publish-time sweep.
  - `emergency_remove(db, repo_dir, media_id, reason, requested_by)` —
    soft-delete + audit row in `site_emergency_removes`. Publish-time
    history rewrite is a PR 5 concern; this command records the intent.
  - `replace_logo(db, repo_dir, source_path)` — full photo pipeline
    for `kind=Logo`, then regenerates 16/32/180 favicon PNGs from the
    same source via `image` crate.
  - `replace_favicon(db, repo_dir, source_path)` — just the favicon
    regen (no logo change).
  - `replace_og_image(db, repo_dir, source_path)` — 1200×630
    crop-to-fill using `image` crate, written to
    `assets/img/og-image.png`.
- **`src-tauri/src/website_media/mod.rs`** — removed the
  "isolated groundwork" language; kept `#![allow(dead_code, unused_imports)]`
  so re-exports for PR 3.5 (video/pdf) stay in place without warnings.
- **Integration-test host deleted:** `src-tauri/tests/website_media.rs`
  removed; every `#[cfg(test)] mod tests` block is now picked up by
  `cargo test --lib`.

### Tauri commands (10 new)

```
website_list_media(kind: Option<String>) -> Vec<MediaRecord>
website_upload_photo(source_path, caption?, alt?) -> MediaRecord
website_upload_photos(source_paths: Vec<String>) -> Vec<MediaRecord>
website_reorder_gallery(ordered_media_ids: Vec<i64>) -> ()
website_edit_media(media_id, caption?, alt?, focal?: (f32,f32)) -> MediaRecord
website_delete_media(media_id: i64) -> ()
website_emergency_remove(media_id: i64, reason: String) -> ()
website_replace_logo(source_path: String) -> MediaRecord
website_replace_favicon(source_path: String) -> MediaRecord
website_replace_og_image(source_path: String) -> MediaRecord
```

Every command begins with `require_enabled()` — a no-op with `ECHELON_WEBSITE_CMS=1`,
returns `Err` otherwise.

### Frontend (React)

- **`src/lib/website.ts`** — TS wrappers for all 10 new commands,
  plus `MediaRecord` / `MediaVariant` / `MediaKind` types.
- **`src/screens/website/Gallery.tsx`** — new screen at `/website/gallery`.
  Drag-drop upload zone, thumbnail grid (`convertFileSrc` on the working
  copy's `assets/img/gallery/*.jpg`), HTML5-native drag-reorder,
  click-to-edit modal (caption / alt / focal-point picker), delete
  confirm modal, red **Emergency remove** modal with reason + explicit
  acknowledgement checkbox.
- **`src/screens/website/Assets.tsx`** — new screen at `/website/assets`.
  Logo preview + replace, OG image preview + replace. Favicon panel is
  read-only — the replace-logo flow regenerates them automatically.
- **`src/App.tsx`** — added lazy imports + routes for `/website/gallery`
  and `/website/assets`, and a "Media" sidebar section.
- **`src/screens/Website.tsx`** — replaced the "Coming in PR 3"
  placeholder tile with real "Gallery" and "Site assets" tiles.

### Version + docs

- Bumped `package.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`,
  `src-tauri/tauri.conf.json` to **3.20.0**.
- Added a v3.20.0 entry to `CHANGELOG.md` covering both PR 2 (content)
  and PR 3 (media) since they land together.

## Tests

All in-crate tests pass:

```
cargo test --lib --no-default-features --features sqlcipher
test result: ok. 321 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out.
```

Broken down:
- 288 tests from the pre-PR-3 baseline (unchanged).
- 26 tests from `website_media::` (unchanged, but now discovered via
  `cargo test --lib` rather than the integration-test host).
- **8 new tests** in `website::media::tests`:
  - `ingest_photo_writes_variants_and_records` — writes 9 variants
    to disk, matches DB rows, and appends to `content/gallery.json`.
  - `reorder_gallery_rewrites_json_in_expected_order` — 3 uploads,
    then reverse-order request, verifies JSON items reflect the
    reversed order.
  - `set_photo_meta_updates_db_and_json` — caption / alt / focal
    round-trip through DB + JSON.
  - `soft_delete_removes_from_json_and_flags_row` — `deleted_at`
    set, item stripped from JSON.
  - `emergency_remove_flags_row_and_writes_audit` — `deleted_at`
    + `site_emergency_removes` row inserted with the correct reason.
  - `crop_to_fill_center_crops_landscape_to_og_ratio` — sanity check
    on the 1200×630 crop-to-fill math for the OG image path.
  - `migration_015_applies_cleanly` — asserts every expected `site_*`
    table exists on a fresh DB after 014+015 apply.
  - `upsert_gallery_entry_is_idempotent` — re-uploading the same
    source bytes hits the `base_hash` UNIQUE dedup path and gallery.json
    stays at one item.

The one integration test host (`tests/website_media.rs`, previously a
no-op `#[test]`) was deleted per the task; that's the -1 vs. a naive
288 + 26 + 8 = 322 count.

Frontend:

```
npx tsc --noEmit
(exit 0, no output)
```

## Deviations from the task

- **`base_hash` is 16 hex chars of SHA-256, not BLAKE3.** The pipeline's
  filename hash is BLAKE3, but `PhotoOutput::base_hash` is a SHA-256 of
  the original bytes (canonical identity for dedup — matches the
  `source_hash_hex` helper in `website_media/hash.rs`). We store the
  first 16 chars of that SHA-256 hex, which matches the "16-char hex
  prefix" shape the SQL comment describes. Semantically it plays the
  same role BLAKE3 would; the choice is anchored to what
  `website_media` already exposes.
- **`pool: &DbPool` in the task spec is `&DbGate` in the code.** The
  repo doesn't have a `DbPool` — every DB call goes through the
  single-connection `db_gate::DbGate` (see `src/db_gate.rs`, PR-2
  narrative in `PR2_NOTES.md`). Signature preserved semantically.
- **AVIF is still built into the pipeline** (via `ravif`) — commit
  `7031a65` on this branch was titled "kill ravif, ship WebP + JPG
  only" but the actual `reencode.rs` still has all three formats
  wired. Left alone; PR 4 shouldn't strip functionality PR 3 kept.
  The pipeline produces 9 variants (3 widths × 3 formats) as the
  code today defines it.
- **Video / PDF** stubs stay stubbed — nothing wired in this PR. The
  `MediaKind` enum knows them, but no command uses them.
- **Emergency-remove history rewrite** is not implemented — the
  command flags the row and writes an audit entry, but the actual
  `git filter-repo`-equivalent inside libgit2 is a PR 5 concern.
  The Emergency-remove modal explicitly warns the user of this.

## Walkthrough

```powershell
cd C:\src\echelon-receipts
$env:ECHELON_WEBSITE_CMS = "1"
npm run tauri dev
```

1. **Home** → click the 🌐 **Website** tile.
2. If the working copy isn't cloned, click **Set up working copy**
   (`git clone https://github.com/EchelonDayCare/echelon-website.git`
   under `%APPDATA%/Echelon Daycare/website/repo/`).
3. Click **Gallery**.
4. Drop 3 photos into the drop-zone at the top of the screen — or
   click **Browse for photos…** to pick from a dialog. HEIC, JPG,
   PNG, WebP all accepted. They appear as thumbnails.
5. Drag the ☰ handle on a thumbnail to reorder. Drop it in a new
   slot — `content/gallery.json` is rewritten atomically.
6. Click a thumbnail to open the edit modal. Type a caption, add
   alt text, click on the image to set the focal-point (0..1
   coordinates). Click **Save changes**.
7. Click the red **Emergency remove…** button to see the takedown
   modal — reason required, acknowledgement checkbox required,
   and the modal warns "This flags the photo for history-rewrite
   on next publish."
8. Click **Delete** on a thumbnail to see the plain-delete confirm.
9. Back at Home → 🌐 **Website** → **Site assets**. Replace the logo
   and OG image. Favicons are regenerated automatically from the new
   logo.
10. Return to `/website/preview` → click **Refresh preview** → the
    rendered site inside the iframe shows the new gallery order and
    the new logo.

## PR 5 handoff

The next PR needs to:

1. **Publish-time file sweep.** On a real publish, walk the
   working-copy `assets/img/gallery/` and remove any file that no
   longer has a corresponding row in `site_media_variants`
   (respecting `deleted_at IS NULL`). Also verify every gallery.json
   variant filename exists on disk — belt-and-brace.
2. **Emergency-remove git history rewrite.** For every row in
   `site_emergency_removes` where `processed_at IS NULL`, use
   libgit2 to walk history and rewrite every commit tree so the
   file bytes are gone. On success, `UPDATE site_emergency_removes
   SET processed_at = datetime('now') WHERE id = ?`. On failure,
   write the message into the `error` column. This is a
   force-push operation; the PAT wizard's existing token is
   sufficient.
3. **Site-repo template surface for `gallery.json`.** The site-repo
   `templates/home.html.j2` and `templates/gallery.html.j2` need
   Jinja fragments that iterate `items` and pick the right
   `<picture>` `<source>` for each variant. That's a change on the
   *site* repo, not this app. The desktop-side JSON shape is:
   ```json
   {
     "schema_version": 1,
     "items": [
       {
         "media_id": 42,
         "base_hash": "a3f2b1e4c8d90a5f",
         "source_filename": "playground.jpg",
         "caption": "…", "alt": "…",
         "focal_x": 0.5, "focal_y": 0.4,
         "width": 3000, "height": 2000,
         "variants": [
           { "width": 400, "format": "jpg", "filename": "…-w400.jpg" },
           { "width": 400, "format": "webp", "filename": "…-w400.webp" },
           { "width": 400, "format": "avif", "filename": "…-w400.avif" },
           …
         ]
       }
     ]
   }
   ```
4. **Video + PDF wire-up (PR 3.5 / PR 5).** `MediaKind::Video` and
   `MediaKind::Pdf` are ready in the enum; the pipeline stubs
   return `StubNotImplemented`. Wire the ffmpeg sidecar for video
   and a real PDF rasteriser (poppler or pdfium) for thumbnails.
5. **Live preview refresh.** Currently the preview iframe holds
   whatever `website_start_preview` last rendered. After a gallery
   change the user has to click "Refresh preview". A small polish
   would be to auto-trigger `websiteStartPreview()` from the
   Gallery screen on Save.

## Build / test commands

```powershell
# Backend build
$env:VCPKG_ROOT = "C:\Users\alosing\vcpkg"
$env:VCPKGRS_TRIPLET = "x64-windows-static-md"
cd C:\src\echelon-receipts\src-tauri
cargo check --lib --no-default-features --features sqlcipher

# Backend tests
cargo test --lib --no-default-features --features sqlcipher

# Frontend type-check
cd C:\src\echelon-receipts
npx tsc --noEmit
```

## Rules honored

- **No push, no tag, no release.** All commits are local.
- **No history rewrite.** The pre-existing merge commit
  (`c48956a`, "Merge branch 'origin/main' into feat/website-media-pipeline")
  was closed cleanly with a fresh commit; the new work sits on
  `feat/website-gallery-editor` cleanly branched off it.
- **No touching migrations 001-014.** Only migration 015 is new.
- **No graduation / receipts / staff changes.** Every modified file
  is in `src-tauri/{migrations,src/website,src/website_media,src/lib.rs,Cargo.toml,Cargo.lock,tauri.conf.json}`
  or `src/{lib/website.ts,screens/Website.tsx,screens/website/*,App.tsx}`
  or `package.json` / `CHANGELOG.md` / this notes file.
