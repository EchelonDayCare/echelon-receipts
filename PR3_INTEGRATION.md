# PR 3 Integration Guide — `website_media` module

This branch (`feat/website-media-pipeline`) is the **groundwork** half of
the Website CMS PR 3. It ships a fully-isolated
`src-tauri/src/website_media/` module — deterministic photo pipeline,
hashing, EXIF stripping, and PR-3.5-shaped stubs for video and PDF — so
that when the parallel PR 2 (`feat/website-cms-core`) lands on `main`,
PR 3 assembly is a matter of minutes, not hours.

## What's in this branch

```
src-tauri/src/website_media/
  ├── mod.rs               ← re-exports the public API
  ├── error.rs             ← MediaError (thiserror)
  ├── hash.rs              ← Format, RECIPE_VERSION, filename(), source_hash_hex()
  ├── exif.rs              ← surgical EXIF/XMP/IPTC/ICC strip (img-parts)
  ├── reencode.rs          ← decode, resize_to_max_dim, encode_{jpg,webp,avif}
  ├── pipeline.rs          ← process_photo → 9 deterministic variants
  ├── video.rs             ← STUB (wired PR 3.5, ffmpeg sidecar)
  ├── pdf.rs               ← STUB thumbnail (magic + size validation only)
  └── emergency_remove.rs  ← EmergencyRemoveMark data shape
src-tauri/tests/
  ├── website_media.rs     ← integration-test host (see "How tests run")
  └── fixtures/website_media/README.md
```

New Cargo dependencies (appended to `[dependencies]`, no existing lines
changed):

```toml
img-parts = "0.3"
ravif     = "0.11"
blake3    = "1"
```

## How tests run TODAY (before PR 2 lands)

Because the Absolute Rule for this branch was **do not touch
`src-tauri/src/lib.rs`** — the parallel PR 2 owns that file's module
list and command wiring — the `website_media` module cannot yet be
discovered by `cargo test --lib`.

Instead, `src-tauri/tests/website_media.rs` uses a `#[path]` include to
pull the module into an integration-test crate. Run it with:

```powershell
$env:VCPKG_ROOT = "$env:USERPROFILE\vcpkg"   # for the pre-existing libheif dep
cd src-tauri
cargo build --lib   --no-default-features --features sqlcipher
cargo test  --test website_media --no-default-features --features sqlcipher
cargo clippy --test website_media --no-default-features --features sqlcipher
```

Expected: 26 passing tests, lib builds clean, clippy adds **no** new
warnings on top of the 52 pre-existing lib warnings that come from a
newer clippy version — those are unrelated to this PR.

## Wiring into PR 2 / PR 3 assembly

Once PR 2 (`feat/website-cms-core`) merges to `main`, this branch will
be **rebased on top of `main`** so both sets of changes land as one PR.
That rebase adds exactly the following:

### Step 1 — Add one line to `src-tauri/src/lib.rs`

Anywhere in the module-declaration block near the top of `lib.rs`
(alongside `mod website;` that PR 2 will have added), insert:

```rust
mod website_media;
```

That's the entire wiring change. No other edits to `lib.rs` are needed.

### Step 2 — Delete the interim integration-test host

Once the module is a real submodule of the library crate, the
`#[path]`-based integration test in
`src-tauri/tests/website_media.rs` is redundant — the `#[cfg(test)]
mod tests` blocks inside each `website_media/*.rs` file will be
picked up by `cargo test --lib website_media` automatically. Delete
that file:

```powershell
git rm src-tauri/tests/website_media.rs
```

The `src-tauri/tests/fixtures/website_media/` directory (with its
README) can stay for future fixture blobs; the unit tests currently
generate their inputs in-process.

### Step 3 — Call `process_photo` from a Tauri command

The `website` module PR 2 adds will need a photo-upload command.
Below is a copy-pasteable snippet that plugs
`website_media::process_photo` into a Tauri command living inside
`src-tauri/src/website/commands.rs` (or wherever PR 2 puts its
command module):

```rust
use crate::website_media::{
    self, MediaError, PhotoInput, PhotoOutput, Variant,
};
use serde::Serialize;

/// Result payload returned to the frontend after a photo upload.
#[derive(Serialize)]
pub struct WebsiteUploadResult {
    pub base_hash: String,
    pub variants: Vec<WebsiteUploadVariant>,
}

#[derive(Serialize)]
pub struct WebsiteUploadVariant {
    pub width: u32,
    pub format: &'static str,   // "avif" | "webp" | "jpg"
    pub filename: String,
    pub byte_len: usize,
}

#[tauri::command]
pub async fn website_upload_photo(
    original_bytes: Vec<u8>,
    source_filename: String,
    state: tauri::State<'_, super::WebsiteState>,
) -> Result<WebsiteUploadResult, String> {
    // Pipeline is CPU-bound; run it on a blocking pool so we don't
    // stall the async runtime.
    let output: PhotoOutput = tokio::task::spawn_blocking(move || {
        website_media::process_photo(PhotoInput {
            original_bytes,
            source_filename,
        })
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
    .map_err(map_media_err)?;

    // Persist each variant into the website git working copy — this
    // is where PR 2's WebsiteState / git session gets used.
    for v in &output.variants {
        state.working_copy_write_media(&v.filename, &v.bytes)
             .map_err(|e| e.to_string())?;
    }

    Ok(WebsiteUploadResult {
        base_hash: output.base_hash,
        variants: output
            .variants
            .into_iter()
            .map(|Variant { width, format, filename, bytes }| WebsiteUploadVariant {
                width,
                format: format.ext(),
                filename,
                byte_len: bytes.len(),
            })
            .collect(),
    })
}

fn map_media_err(e: MediaError) -> String {
    match e {
        MediaError::InputTooLarge { size, max } =>
            format!("photo too large: {size} bytes (max {max})"),
        MediaError::UnsupportedFormat =>
            "unsupported photo format (need JPEG / PNG / WebP / AVIF)".into(),
        MediaError::DecodeFailed(m) => format!("cannot decode photo: {m}"),
        MediaError::EncodeFailed(m) => format!("cannot encode photo: {m}"),
        other => other.to_string(),
    }
}
```

Then register the command in `lib.rs`'s `invoke_handler` alongside the
other `website::commands::*` entries.

### Step 4 — Emergency remove (child-photo takedown)

`EmergencyRemoveMark` is the request record that the frontend produces
when a parent revokes consent. The actual git-history rewrite (using
libgit2 via the `git2` crate PR 2 adds) belongs in the `website`
module. Sketch:

```rust
use crate::website_media::EmergencyRemoveMark;
use chrono::Utc;

#[tauri::command]
pub async fn website_emergency_remove(
    file_id: String,
    reason: String,
    requested_by: String,
    state: tauri::State<'_, super::WebsiteState>,
) -> Result<(), String> {
    let mark = EmergencyRemoveMark::new(file_id, reason, Utc::now(), requested_by);

    // 1) Log the request into the audit trail (JSON append-only).
    state.audit_log_append(&mark.to_json().map_err(|e| e.to_string())?)
         .map_err(|e| e.to_string())?;

    // 2) Rewrite git history via git-filter-repo-in-libgit2 (PR 2 helper).
    state.git_history_expunge(&mark.file_id)
         .map_err(|e| e.to_string())?;

    Ok(())
}
```

### Step 5 — Video / PDF stubs

`website_media::process_video` and `website_media::probe_video` return
`MediaError::StubNotImplemented("...")` today. PR 3.5 will replace
those bodies with an ffmpeg-sidecar shellout that produces `(mp4,
webm, poster.jpg)`; the type signatures are frozen so the frontend
and the `website` command layer can wire against them now.

`accept_pdf` validates the header + size cap. PR 3.5 adds page-1
thumbnail rendering via a proper PDF rasteriser (poppler / pdfium
binding).

## Recipe versioning

`website_media::hash::RECIPE_VERSION` is currently `1`. Bump it in the
same commit as any change to `reencode.rs` that alters output bytes
(e.g. swapping to libwebp for lossy WebP). Bumping the recipe version
regenerates every derived filename, giving a clean cache-bust at the
CDN edge without any manual invalidation.

## What's intentionally left out

- **Lossy WebP** — `image` 0.25 only ships lossless VP8L. Adding the
  `webp` crate (libwebp bindings) is queued for PR 3.5; recipe version
  bumps to `2` at that time.
- **AVIF colour-space tuning** — using ravif defaults (BT.601, YCbCr).
  Fine for photo content; if we ever ship banner artwork, revisit.
- **HEIC input** — the app already links `libheif-rs` for the
  graduation reels pipeline. Adding HEIC to `detect_hint()` +
  `decode()` is a one-line change once we decide the CMS should
  accept iPhone photos directly.
- **Fixtures on disk** — every unit test synthesises its input
  in-process (solid-colour RGB via `image::codecs::jpeg`), keeping
  the tree free of committed binary blobs. Add real fixtures under
  `src-tauri/tests/fixtures/website_media/` when we need
  regression photos from actual devices.
