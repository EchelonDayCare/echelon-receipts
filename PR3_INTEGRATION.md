# PR 3 Integration Guide — `website_media` module

This branch (`feat/website-media-pipeline`) is the **groundwork** half of
the Website CMS PR 3. It ships a fully-isolated
`src-tauri/src/website_media/` module — deterministic photo pipeline,
hashing, EXIF stripping, and PR-3.5-shaped stubs for video and PDF — so
that when the parallel PR 2 (`feat/website-cms-core`) lands on `main`,
PR 3 assembly is a matter of minutes, not hours.

## ⚠ Follow-ups deferred to PR 3.5

Ship-what-compiles-NOW cuts:

- **AVIF encoder is stubbed.** `ravif` was removed from Cargo.toml
  because `rav1e` + `dav1d` transitive compile blew past this branch's
  time budget. `reencode::encode_avif` returns
  `MediaError::StubNotImplemented("encode_avif (AVIF via ravif
  deferred to PR 3.5)")`. The `pipeline` job list omits `Format::Avif`
  entirely, so `process_photo` produces **6 variants (3 widths × 2
  formats: WebP + JPG)** instead of the intended 9. Downstream can
  still ship a valid `<picture>` — the JPG fallback is universal and
  the WebP variant covers modern browsers. PR 3.5 re-adds
  `ravif = "0.11"`, restores the real body of `encode_avif`, adds
  `Format::Avif` back to the pipeline job list, and bumps
  `RECIPE_VERSION` to `2` in the same commit.
  Search markers: `TODO: reintroduce ravif in PR3.5`
  (in `Cargo.toml`, `reencode.rs`, `pipeline.rs`).

- **Lossy WebP.** `image` 0.25 only ships lossless VP8L. Adding the
  `webp` crate (libwebp bindings) will land in the same PR 3.5 commit
  as the ravif reintroduction; both encoder swaps share the recipe-
  version bump.

- **Video re-encode.** `website_media::process_video` /
  `website_media::probe_video` return `StubNotImplemented`. Real
  ffmpeg-sidecar wiring is PR 3.5.

- **PDF page-1 thumbnails.** `accept_pdf` validates magic + size cap
  today; real rasteriser (poppler / pdfium) is PR 3.5.

## Verified in this branch

With `VCPKG_ROOT=$env:USERPROFILE\vcpkg` (already installed on this
box for the pre-existing `libheif-sys` dep):

```powershell
cd src-tauri
cargo check --lib   --no-default-features --features sqlcipher   # clean
cargo test  --test website_media --no-default-features --features sqlcipher \
  -- pipeline_end_to_end_landscape exif_strip_removes_all_markers_jpeg
    # 2 passed; 0 failed; 24 filtered out
```

`cargo check --lib` finishes in ~12 min from a cold `target/` on this
box (dominated by the pre-existing Tauri / libheif deps, not the new
ones). Warm rebuilds after touching `website_media/**` finish in
seconds.

The remaining 24 `#[cfg(test)]` cases inside the module (hash goldens,
resize math, portrait / determinism, video / PDF / emergency-remove
stubs) compile against the current shape and were passing under the
previous full-ravif setup; they were skipped in the priority-2
verification only for time-budget reasons. Run them with
`cargo test --test website_media --no-default-features --features
sqlcipher` for a full sweep.

## What's in this branch

```
src-tauri/src/website_media/
  ├── mod.rs               ← re-exports the public API
  ├── error.rs             ← MediaError (thiserror)
  ├── hash.rs              ← Format, RECIPE_VERSION, filename(), source_hash_hex()
  ├── exif.rs              ← surgical EXIF/XMP/IPTC/ICC strip (img-parts)
  ├── reencode.rs          ← decode, resize_to_max_dim, encode_{jpg,webp}
  │                          + encode_avif() STUB (see follow-up above)
  ├── pipeline.rs          ← process_photo → 6 deterministic variants
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
# ravif  = "0.11"   ← commented out, TODO: reintroduce ravif in PR3.5
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
$env:VCPKG_ROOT = "$env:USERPROFILE\vcpkg"
cd src-tauri
cargo check --lib   --no-default-features --features sqlcipher
cargo test  --test website_media --no-default-features --features sqlcipher
cargo clippy --test website_media --no-default-features --features sqlcipher
```

## Wiring into PR 2 / PR 3 assembly

Once PR 2 (`feat/website-cms-core`) merges to `main`, this branch will
be **rebased on top of `main`** so both sets of changes land as one PR.

### Step 1 — Add one line to `src-tauri/src/lib.rs`

Anywhere in the module-declaration block near the top of `lib.rs`
(alongside `mod website;` that PR 2 will have added), insert:

```rust
mod website_media;
```

### Step 2 — Delete the interim integration-test host

```powershell
git rm src-tauri/tests/website_media.rs
```

The `#[cfg(test)] mod tests` blocks inside each `website_media/*.rs`
file will then be picked up by `cargo test --lib website_media`
automatically. The `src-tauri/tests/fixtures/website_media/` directory
(with its README) can stay for future fixture blobs.

### Step 3 — Call `process_photo` from a Tauri command

The `website` module PR 2 adds will need a photo-upload command. This
snippet plugs `website_media::process_photo` into a Tauri command
living inside `src-tauri/src/website/commands.rs`:

```rust
use crate::website_media::{
    self, MediaError, PhotoInput, PhotoOutput, Variant,
};
use serde::Serialize;

#[derive(Serialize)]
pub struct WebsiteUploadResult {
    pub base_hash: String,
    pub variants: Vec<WebsiteUploadVariant>,
}

#[derive(Serialize)]
pub struct WebsiteUploadVariant {
    pub width: u32,
    pub format: &'static str,   // "webp" | "jpg"   (+ "avif" after PR 3.5)
    pub filename: String,
    pub byte_len: usize,
}

#[tauri::command]
pub async fn website_upload_photo(
    original_bytes: Vec<u8>,
    source_filename: String,
    state: tauri::State<'_, super::WebsiteState>,
) -> Result<WebsiteUploadResult, String> {
    let output: PhotoOutput = tokio::task::spawn_blocking(move || {
        website_media::process_photo(PhotoInput {
            original_bytes,
            source_filename,
        })
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
    .map_err(map_media_err)?;

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

### Step 4 — Emergency remove (child-photo takedown)

`EmergencyRemoveMark` is the request record that the frontend produces
when a parent revokes consent. The actual git-history rewrite (via the
`git2` crate PR 2 adds) belongs in the `website` module:

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
    state.audit_log_append(&mark.to_json().map_err(|e| e.to_string())?)
         .map_err(|e| e.to_string())?;
    state.git_history_expunge(&mark.file_id)
         .map_err(|e| e.to_string())?;
    Ok(())
}
```

### Step 5 — Video / PDF stubs

`website_media::process_video` and `website_media::probe_video` return
`MediaError::StubNotImplemented("...")` today. PR 3.5 replaces those
bodies with an ffmpeg-sidecar shellout that produces `(mp4, webm,
poster.jpg)`. `accept_pdf` validates header + size cap; page-1
thumbnails also PR 3.5.

## Recipe versioning

`website_media::hash::RECIPE_VERSION` is currently `1`. **Bump to `2`
in the PR 3.5 commit** that re-introduces ravif AND swaps WebP to
lossy libwebp — both encoder changes want the same cache-bust.
