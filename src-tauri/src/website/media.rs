//! Website CMS — media pipeline domain logic.
//!
//! The Tauri command layer (`website::commands`) is thin — it does
//! argument decoding + error mapping and delegates every state
//! change to this module. Everything that touches the DB or the
//! working-copy filesystem lives here so the tests can drive the
//! pipeline directly against an in-memory rusqlite `Connection` and
//! a `tempfile::TempDir` working copy.
//!
//! # Pipeline overview
//! For a gallery photo:
//!   1. Read source bytes (converting HEIC→JPEG in-place if needed).
//!   2. Run [`crate::website_media::process_photo`] — deterministic
//!      EXIF strip + 3 widths × 3 formats.
//!   3. Insert into `site_media` (unique base_hash → dedup on
//!      re-upload), then insert one `site_media_variants` row per
//!      rendered variant.
//!   4. Write the variant bytes to the working copy's
//!      `assets/img/gallery/` (or `assets/img/` for brand assets).
//!   5. Update `content/gallery.json` — either append the new item or,
//!      for edit/reorder/delete, rewrite the items array. `gallery.json`
//!      is never touched by the schema-validated PR-2 editor — this
//!      module owns it end-to-end.
//!
//! For brand assets (logo / favicon / OG image) the small-image
//! resizes go through `image` directly — no need for the AVIF/WebP
//! ladder. Logo replacement ALSO regenerates the 16/32/180 favicon
//! PNGs from the new logo bytes.

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use image::{imageops::FilterType, DynamicImage, GenericImageView, ImageFormat};
use rusqlite::{params, OptionalExtension};
#[cfg(test)]
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;

use crate::db_gate::{DbError, DbGate};
use crate::website_media::{
    self, hash::HASH_PREFIX_LEN, Format, MediaError, PhotoInput, PhotoOutput,
};

/// Basename hash prefix stored on `site_media.base_hash`. Trimmed
/// from the pipeline's 64-char sha256 hex so the DB column shape
/// matches the derived filename shape.
pub const BASE_HASH_LEN: usize = HASH_PREFIX_LEN;

/// Every kind we know about. Kept as a bare enum + serde-tag so
/// invalid values coming off the wire are rejected up front.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    Photo,
    Video,
    Pdf,
    Logo,
    Favicon,
    OgImage,
}

impl MediaKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MediaKind::Photo => "photo",
            MediaKind::Video => "video",
            MediaKind::Pdf => "pdf",
            MediaKind::Logo => "logo",
            MediaKind::Favicon => "favicon",
            MediaKind::OgImage => "og_image",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "photo" => MediaKind::Photo,
            "video" => MediaKind::Video,
            "pdf" => MediaKind::Pdf,
            "logo" => MediaKind::Logo,
            "favicon" => MediaKind::Favicon,
            "og_image" => MediaKind::OgImage,
            _ => return None,
        })
    }
}

/// Sub-directory inside the working copy `assets/img/` for a kind.
fn asset_subdir(kind: MediaKind) -> &'static str {
    match kind {
        MediaKind::Photo => "gallery",
        _ => "",
    }
}

/// One rendered variant row (matches `site_media_variants`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VariantRecord {
    pub id: i64,
    pub width: i64,
    pub format: String,
    pub filename: String,
    pub bytes_len: i64,
}

/// Full media row, joined with its variants. Returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaRecord {
    pub id: i64,
    pub base_hash: String,
    pub source_filename: String,
    pub kind: String,
    pub caption: Option<String>,
    pub alt: Option<String>,
    pub focal_x: Option<f64>,
    pub focal_y: Option<f64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub original_bytes_len: Option<i64>,
    pub exif_stripped: bool,
    pub created_at: String,
    pub deleted_at: Option<String>,
    pub variants: Vec<VariantRecord>,
}

/// Errors raised by this module. `serde::Serialize` so Tauri commands
/// can propagate them as strings.
#[derive(Debug)]
pub enum MediaOpError {
    Db(DbError),
    Io(std::io::Error),
    Pipeline(MediaError),
    Image(image::ImageError),
    Json(serde_json::Error),
    Heic(String),
    NotFound(i64),
    UnsupportedInput(String),
    InvalidWorkingCopy(String),
}

impl std::fmt::Display for MediaOpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Db(e) => write!(f, "db: {e}"),
            Self::Io(e) => write!(f, "io: {e}"),
            Self::Pipeline(e) => write!(f, "pipeline: {e}"),
            Self::Image(e) => write!(f, "image: {e}"),
            Self::Json(e) => write!(f, "json: {e}"),
            Self::Heic(e) => write!(f, "heic: {e}"),
            Self::NotFound(id) => write!(f, "media #{id} not found"),
            Self::UnsupportedInput(m) => write!(f, "unsupported input: {m}"),
            Self::InvalidWorkingCopy(m) => write!(f, "invalid working copy: {m}"),
        }
    }
}
impl std::error::Error for MediaOpError {}

impl From<DbError> for MediaOpError {
    fn from(e: DbError) -> Self {
        Self::Db(e)
    }
}
impl From<std::io::Error> for MediaOpError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}
impl From<MediaError> for MediaOpError {
    fn from(e: MediaError) -> Self {
        Self::Pipeline(e)
    }
}
impl From<image::ImageError> for MediaOpError {
    fn from(e: image::ImageError) -> Self {
        Self::Image(e)
    }
}
impl From<serde_json::Error> for MediaOpError {
    fn from(e: serde_json::Error) -> Self {
        Self::Json(e)
    }
}
impl From<rusqlite::Error> for MediaOpError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Db(DbError::Sqlite(e))
    }
}

pub type MediaResult<T> = Result<T, MediaOpError>;

// ─────────────────────────────────────────────────────────────────────
// Public API — call sites live in website::commands
// ─────────────────────────────────────────────────────────────────────

/// Ingest a photo from `source_path` into the pipeline + DB +
/// working-copy assets + `content/gallery.json` (for `kind=Photo`).
///
/// Returns the freshly-inserted (or dedup'd) [`MediaRecord`].
pub async fn ingest_photo(
    db: &DbGate,
    repo_dir: &Path,
    source_path: &Path,
    kind: MediaKind,
    caption: Option<String>,
    alt: Option<String>,
) -> MediaResult<MediaRecord> {
    let source_filename = source_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("upload")
        .to_string();

    let original_bytes = load_and_normalize_bytes(source_path)?;

    let PhotoOutput { base_hash, variants } = tokio::task::spawn_blocking({
        let bytes = original_bytes.clone();
        let filename = source_filename.clone();
        move || {
            website_media::process_photo(PhotoInput {
                original_bytes: bytes,
                source_filename: filename,
            })
        }
    })
    .await
    .map_err(|e| MediaOpError::Heic(format!("join error: {e}")))??;

    let (orig_w, orig_h) = probe_dimensions(&original_bytes)?;
    let base_hash_short = base_hash
        .chars()
        .take(BASE_HASH_LEN)
        .collect::<String>();

    write_variants_to_working_copy(repo_dir, kind, &variants)?;

    // Serialize DB write + gallery.json update. The heavy image
    // encoding above ran concurrently across N buffered upload
    // workers; only the last two mutation steps need to be atomic
    // against every other in-flight mutation.
    let _mutation_guard = gallery_mutation_lock().lock().await;

    let record = upsert_media_and_variants(
        db,
        &base_hash_short,
        &source_filename,
        kind,
        caption.as_deref(),
        alt.as_deref(),
        None,
        Some(orig_w as i64),
        Some(orig_h as i64),
        Some(original_bytes.len() as i64),
        &variants,
    )
    .await?;

    if kind == MediaKind::Photo {
        upsert_gallery_entry(repo_dir, &record)?;
    }

    Ok(record)
}

/// Rewrite `content/gallery.json` items order to match
/// `ordered_media_ids`. Missing ids are dropped silently; unknown
/// ids (not previously in the file) are ignored.
pub async fn reorder_gallery(
    db: &DbGate,
    repo_dir: &Path,
    ordered_media_ids: Vec<i64>,
) -> MediaResult<()> {
    let _mutation_guard = gallery_mutation_lock().lock().await;
    // We only touch gallery.json — records themselves don't change.
    // But we look up the record for each id so a "reorder to a
    // record that was soft-deleted" attempt gets dropped.
    let mut records: Vec<MediaRecord> = Vec::new();
    let mut kept_ids: Vec<i64> = Vec::new();
    for id in ordered_media_ids {
        if let Some(rec) = try_load_media_record(db, id).await? {
            if rec.deleted_at.is_none() && rec.kind == "photo" {
                kept_ids.push(rec.id);
                records.push(rec);
            }
        }
    }
    // Persist sort_order on the DB so a subsequent list_media reflects
    // the new order without needing to re-parse gallery.json.
    let ids_for_db = kept_ids.clone();
    db.with_conn(move |conn| {
        let tx = conn.unchecked_transaction()?;
        for (i, id) in ids_for_db.iter().enumerate() {
            tx.execute(
                "UPDATE site_media SET sort_order = ?1 WHERE id = ?2",
                params![i as i64, id],
            )?;
        }
        tx.commit()?;
        Ok(())
    })
    .await?;
    rewrite_gallery_items(repo_dir, &records)?;
    Ok(())
}

/// Update caption / alt / focal point on an existing photo and
/// rewrite the corresponding item in `content/gallery.json`.
pub async fn set_photo_meta(
    db: &DbGate,
    repo_dir: &Path,
    media_id: i64,
    caption: Option<String>,
    alt: Option<String>,
    focal: Option<(f32, f32)>,
) -> MediaResult<MediaRecord> {
    let _mutation_guard = gallery_mutation_lock().lock().await;
    let (fx, fy) = match focal {
        Some((x, y)) => (Some(x as f64), Some(y as f64)),
        None => (None, None),
    };
    let caption_owned = caption.clone();
    let alt_owned = alt.clone();
    db.with_conn(move |conn| {
        // Contract: None = leave field unchanged; Some("") = clear
        // the field to NULL; Some(non-empty) = set. The prior code
        // used SQLite COALESCE which conflates "leave unchanged" and
        // "clear" — so a user who deleted the caption in the UI got
        // silently reverted to the previous value on save.
        conn.execute(
            "UPDATE site_media SET \
                caption = CASE \
                    WHEN ?1 IS NULL THEN caption \
                    WHEN ?1 = '' THEN NULL \
                    ELSE ?1 END, \
                alt = CASE \
                    WHEN ?2 IS NULL THEN alt \
                    WHEN ?2 = '' THEN NULL \
                    ELSE ?2 END, \
                focal_x = COALESCE(?3, focal_x), \
                focal_y = COALESCE(?4, focal_y) \
             WHERE id = ?5",
            params![caption_owned, alt_owned, fx, fy, media_id],
        )?;
        Ok(())
    })
    .await?;

    let rec = load_media_record(db, media_id).await?;
    if rec.kind == "photo" {
        // Rewrite gallery.json so the current on-disk photos array
        // reflects the DB row order + fields.
        let items = load_ordered_photo_records(db).await?;
        rewrite_gallery_items(repo_dir, &items)?;
    }
    Ok(rec)
}

/// Soft-delete: set `site_media.deleted_at` and drop the item from
/// `content/gallery.json`. Working-copy files stay on disk until a
/// future publish-time sweep collects them.
pub async fn soft_delete(
    db: &DbGate,
    repo_dir: &Path,
    media_id: i64,
) -> MediaResult<()> {
    let _mutation_guard = gallery_mutation_lock().lock().await;
    db.with_conn(move |conn| {
        conn.execute(
            "UPDATE site_media SET deleted_at = datetime('now') \
             WHERE id = ?1 AND deleted_at IS NULL",
            params![media_id],
        )?;
        Ok(())
    })
    .await?;

    // Rewrite gallery.json without the deleted row.
    let items = load_ordered_photo_records(db).await?;
    rewrite_gallery_items(repo_dir, &items)?;
    Ok(())
}

/// Bulk soft-delete: flag every id in a single transaction and
/// rewrite `content/gallery.json` once. Beats a per-id loop over
/// `soft_delete` on both DB traffic (one tx, one gallery re-read)
/// and gallery.json atomicity — a partial failure never leaves the
/// working copy referring to already-deleted rows.
pub async fn bulk_soft_delete(
    db: &DbGate,
    repo_dir: &Path,
    media_ids: Vec<i64>,
) -> MediaResult<usize> {
    if media_ids.is_empty() {
        return Ok(0);
    }
    let _mutation_guard = gallery_mutation_lock().lock().await;
    let ids = media_ids.clone();
    let affected = db
        .with_conn(move |conn| {
            let tx = conn.unchecked_transaction()?;
            let mut updated: usize = 0;
            {
                let mut stmt = tx.prepare(
                    "UPDATE site_media SET deleted_at = datetime('now') \
                     WHERE id = ?1 AND deleted_at IS NULL",
                )?;
                for id in &ids {
                    updated += stmt.execute(params![id])?;
                }
            }
            tx.commit()?;
            Ok(updated)
        })
        .await?;
    let items = load_ordered_photo_records(db).await?;
    rewrite_gallery_items(repo_dir, &items)?;
    Ok(affected)
}


///
/// The actual git history rewrite is deferred to the publish-time
/// pipeline (a separate PR). Callers should surface a warning to the
/// user that the file will remain in prior commits until then.
pub async fn emergency_remove(
    db: &DbGate,
    repo_dir: &Path,
    media_id: i64,
    reason: String,
    requested_by: String,
) -> MediaResult<()> {
    let _mutation_guard = gallery_mutation_lock().lock().await;
    // Verify the row exists so we don't insert a dangling audit
    // record. Use a load-and-check pattern rather than trusting the
    // FK — the FK is defined but sqlite `PRAGMA foreign_keys` is
    // off in the default open, so we belt-and-brace here.
    let _ = load_media_record(db, media_id).await?;

    let reason_owned = reason.clone();
    let requester_owned = requested_by.clone();
    db.with_conn(move |conn| {
        conn.execute(
            "UPDATE site_media SET deleted_at = datetime('now') \
             WHERE id = ?1 AND deleted_at IS NULL",
            params![media_id],
        )?;
        conn.execute(
            "INSERT INTO site_emergency_removes \
                (media_id, reason, requested_by) \
             VALUES (?1, ?2, ?3)",
            params![media_id, reason_owned, requester_owned],
        )?;
        Ok(())
    })
    .await?;

    let items = load_ordered_photo_records(db).await?;
    rewrite_gallery_items(repo_dir, &items)?;
    Ok(())
}

/// Replace the site logo. Runs the full photo pipeline (kind=Logo)
/// AND regenerates 16 / 32 / 180 favicon PNGs from the same source.
pub async fn replace_logo(
    db: &DbGate,
    repo_dir: &Path,
    source_path: &Path,
) -> MediaResult<MediaRecord> {
    let logo = ingest_photo(db, repo_dir, source_path, MediaKind::Logo, None, None).await?;

    // Also regenerate favicons from the same bytes so the caller
    // doesn't have to make a second Tauri call. Failure here is
    // logged but doesn't fail the whole logo replace — the favicons
    // can be re-run manually.
    if let Err(e) = regenerate_favicons_from_source(db, repo_dir, source_path).await {
        eprintln!("[website::media] favicon regen failed: {e}");
    }
    Ok(logo)
}

/// Replace ONLY the favicons (16 / 32 / 180 px PNGs). Uses the same
/// `image` resize path as `replace_logo` but without the AVIF/WebP
/// ladder.
pub async fn replace_favicon(
    db: &DbGate,
    repo_dir: &Path,
    source_path: &Path,
) -> MediaResult<MediaRecord> {
    regenerate_favicons_from_source(db, repo_dir, source_path).await
}

/// Replace one of the three About-page hero photo slots
/// (`assets/img/photo1.jpg` / `photo2.jpg` / `photo3.jpg`).
///
/// Crop-to-fill 1400×900 (~1.55:1, matches the CSS 280×180 slot ratio),
/// re-encode as JPEG q88, overwrite the file in place. Filenames are
/// fixed so `content/about.json.image_grid[*].src` never needs updating
/// — the site template already references `photo1/2/3.jpg`.
///
/// `slot` must be 1, 2, or 3; any other value returns an error.
/// Returns the relative repo path that was written, e.g. `"assets/img/photo1.jpg"`.
pub async fn replace_about_photo(
    repo_dir: &Path,
    slot: u8,
    source_path: &Path,
) -> MediaResult<String> {
    if !(1..=3).contains(&slot) {
        return Err(MediaOpError::InvalidWorkingCopy(format!(
            "about-photo slot must be 1, 2, or 3 (got {slot})"
        )));
    }

    let bytes = load_and_normalize_bytes(source_path)?;
    let img = image::load_from_memory(&bytes)?;
    let cropped = crop_to_fill(&img, 1400, 900);

    let mut jpeg_bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_bytes, 88)
        .encode_image(&cropped)?;

    // Non-photo asset root: assets/img/ (asset_subdir returns "" for
    // anything not MediaKind::Photo).
    let out_dir = ensure_asset_dir(repo_dir, MediaKind::Logo)?;
    let rel = format!("assets/img/photo{slot}.jpg");
    let out_path = out_dir.join(format!("photo{slot}.jpg"));
    std::fs::write(&out_path, &jpeg_bytes)?;
    Ok(rel)
}

/// Replace or add a photo shown in the home page's "Gallery preview"
/// section. Crops to 1200×800 (fits the site's card aspect), encodes
/// JPEG q88, and writes to `assets/img/{slug}.jpg` in the working
/// copy. The `slug` must be lowercase alphanumerics + underscores +
/// hyphens (typically the item's `id` like `home_g1`).
///
/// Returns the repo-relative path (`assets/img/…`) that the caller
/// stores back into `home.json → gallery_preview.items[].src`.
pub async fn replace_home_gallery_photo(
    repo_dir: &Path,
    slug: &str,
    source_path: &Path,
) -> MediaResult<String> {
    let clean: String = slug
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    if clean.is_empty() || clean.len() > 64 {
        return Err(MediaOpError::InvalidWorkingCopy(format!(
            "home-gallery slug must be 1–64 alphanumerics/_/- (got {slug:?})"
        )));
    }

    let bytes = load_and_normalize_bytes(source_path)?;
    let img = image::load_from_memory(&bytes)?;
    let cropped = crop_to_fill(&img, 1200, 800);

    let mut jpeg_bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_bytes, 88)
        .encode_image(&cropped)?;

    let out_dir = ensure_asset_dir(repo_dir, MediaKind::Logo)?;
    let filename = format!("{clean}.jpg");
    let rel = format!("assets/img/{filename}");
    let out_path = out_dir.join(&filename);
    std::fs::write(&out_path, &jpeg_bytes)?;
    Ok(rel)
}

/// Replace the home page hero banner. Crops to 2400×1000 (12:5,
/// matches the `.hero` 400px-tall × 100%-wide background-cover box),
/// JPEG q88, written to `assets/img/hero-bg.jpg`.
pub async fn replace_home_hero_banner(
    repo_dir: &Path,
    source_path: &Path,
) -> MediaResult<String> {
    let bytes = load_and_normalize_bytes(source_path)?;
    let img = image::load_from_memory(&bytes)?;
    let cropped = crop_to_fill(&img, 2400, 1000);

    let mut jpeg_bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_bytes, 88)
        .encode_image(&cropped)?;

    let out_dir = ensure_asset_dir(repo_dir, MediaKind::Logo)?;
    let rel = "assets/img/hero-bg.jpg".to_string();
    let out_path = out_dir.join("hero-bg.jpg");
    std::fs::write(&out_path, &jpeg_bytes)?;
    Ok(rel)
}

/// Replace the OG image. 1200×630 crop-to-fill using the `image`
/// crate, written to `assets/img/og-image.png`. DB row `kind=og_image`.
pub async fn replace_og_image(
    db: &DbGate,
    repo_dir: &Path,
    source_path: &Path,
) -> MediaResult<MediaRecord> {
    let bytes = load_and_normalize_bytes(source_path)?;
    let img = image::load_from_memory(&bytes)?;

    let cropped = crop_to_fill(&img, 1200, 630);
    let png_bytes = encode_png(&cropped)?;

    let out_dir = ensure_asset_dir(repo_dir, MediaKind::OgImage)?;
    let out_path = out_dir.join("og-image.png");
    std::fs::write(&out_path, &png_bytes)?;

    let base_hash = short_hash(&bytes);
    let source_filename = source_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("og.png")
        .to_string();

    let variant = website_media::Variant {
        width: 1200,
        format: Format::Jpg, // stored as jpg so DB shape matches; the on-disk file is a PNG.
        filename: "og-image.png".to_string(),
        bytes: png_bytes.clone(),
    };
    let variants = vec![variant];

    upsert_media_and_variants(
        db,
        &base_hash,
        &source_filename,
        MediaKind::OgImage,
        None,
        None,
        Some("og-image.png"),
        Some(cropped.width() as i64),
        Some(cropped.height() as i64),
        Some(bytes.len() as i64),
        &variants,
    )
    .await
}

// ─────────────────────────────────────────────────────────────────────
// Media record listing — thin wrappers for the frontend
// ─────────────────────────────────────────────────────────────────────

/// Return every non-deleted media record, optionally filtered by kind.
/// Sorted by insertion order (id ASC) for gallery, so the frontend's
/// initial render matches the on-disk `content/gallery.json` order.
/// Hydrate SQLite `site_media` (+ variants) from `content/gallery.json`.
/// Called on working-copy init so a fresh clone on a new machine
/// still sees the existing gallery. Idempotent — uses INSERT OR
/// IGNORE keyed on `(base_hash, kind)` so re-running is a no-op.
///
/// Only handles kind='photo' — brand assets (logo/favicon/og) live
/// outside gallery.json and are re-derived when the owner
/// (re-)uploads them.
pub async fn hydrate_gallery_from_json(db: &DbGate, repo_dir: &Path) -> MediaResult<usize> {
    let root = match read_gallery_root(repo_dir) {
        Ok(r) => r,
        Err(_) => return Ok(0),
    };
    let items = parse_items(&root);
    if items.is_empty() {
        return Ok(0);
    }
    let items_for_db = items.clone();
    let inserted: usize = db
        .with_conn(move |conn| {
            let tx = conn.unchecked_transaction()?;
            let mut count = 0usize;
            for (i, it) in items_for_db.iter().enumerate() {
                let existing: Option<i64> = tx
                    .query_row(
                        "SELECT id FROM site_media WHERE base_hash = ?1 AND kind = 'photo'",
                        params![it.base_hash],
                        |r| r.get::<_, i64>(0),
                    )
                    .optional()?;
                let media_id = if let Some(id) = existing {
                    tx.execute(
                        "UPDATE site_media SET sort_order = ?1 WHERE id = ?2",
                        params![i as i64, id],
                    )?;
                    id
                } else {
                    tx.execute(
                        "INSERT INTO site_media \
                            (base_hash, source_filename, kind, caption, alt, \
                             focal_x, focal_y, width, height, exif_stripped, \
                             created_at, sort_order) \
                         VALUES (?1, ?2, 'photo', ?3, ?4, ?5, ?6, ?7, ?8, 1, datetime('now'), ?9)",
                        params![
                            it.base_hash,
                            it.source_filename,
                            it.caption,
                            it.alt,
                            it.focal_x,
                            it.focal_y,
                            it.width,
                            it.height,
                            i as i64,
                        ],
                    )?;
                    count += 1;
                    tx.last_insert_rowid()
                };
                // Refresh variants — cheap and lets a re-hydrate pick
                // up new variant rows if the JSON schema evolved.
                tx.execute(
                    "DELETE FROM site_media_variants WHERE media_id = ?1",
                    params![media_id],
                )?;
                for v in &it.variants {
                    tx.execute(
                        "INSERT INTO site_media_variants \
                            (media_id, width, format, filename, bytes_len) \
                         VALUES (?1, ?2, ?3, ?4, 0)",
                        params![media_id, v.width, v.format, v.filename],
                    )?;
                }
            }
            tx.commit()?;
            Ok(count)
        })
        .await?;
    Ok(inserted)
}

pub async fn list_media(
    db: &DbGate,
    kind: Option<MediaKind>,
) -> MediaResult<Vec<MediaRecord>> {
    let kind_str = kind.map(|k| k.as_str().to_string());
    let records = db
        .with_conn(move |conn| {
            // Load the base rows and their variants in a single conn
            // handoff so we avoid one round-trip per record (the old
            // per-id `load_media_record` loop was quadratic in wall
            // time once a centre uploaded a few hundred photos).
            let base_sql = if kind_str.is_some() {
                "SELECT id, base_hash, source_filename, kind, caption, alt, \
                        focal_x, focal_y, width, height, original_bytes_len, \
                        exif_stripped, created_at, deleted_at \
                 FROM site_media \
                 WHERE deleted_at IS NULL AND kind = ?1 \
                 ORDER BY sort_order ASC, id ASC"
            } else {
                "SELECT id, base_hash, source_filename, kind, caption, alt, \
                        focal_x, focal_y, width, height, original_bytes_len, \
                        exif_stripped, created_at, deleted_at \
                 FROM site_media \
                 WHERE deleted_at IS NULL \
                 ORDER BY sort_order ASC, id ASC"
            };
            let mut stmt = conn.prepare(base_sql)?;
            let mut records: Vec<MediaRecord> = Vec::new();
            let mut ids: Vec<i64> = Vec::new();
            let map_row = |r: &rusqlite::Row| {
                Ok(MediaRecord {
                    id: r.get(0)?,
                    base_hash: r.get(1)?,
                    source_filename: r.get(2)?,
                    kind: r.get(3)?,
                    caption: r.get(4)?,
                    alt: r.get(5)?,
                    focal_x: r.get(6)?,
                    focal_y: r.get(7)?,
                    width: r.get(8)?,
                    height: r.get(9)?,
                    original_bytes_len: r.get(10)?,
                    exif_stripped: r.get::<_, i64>(11)? != 0,
                    created_at: r.get(12)?,
                    deleted_at: r.get(13)?,
                    variants: Vec::new(),
                })
            };
            if let Some(k) = kind_str.as_deref() {
                let rows = stmt.query_map(params![k], map_row)?;
                for r in rows {
                    let rec = r?;
                    ids.push(rec.id);
                    records.push(rec);
                }
            } else {
                let rows = stmt.query_map([], map_row)?;
                for r in rows {
                    let rec = r?;
                    ids.push(rec.id);
                    records.push(rec);
                }
            }
            if records.is_empty() {
                return Ok(records);
            }
            // Batch-fetch all variants for these ids and group by
            // media_id. SQLite's default max host params is 999 —
            // chunk to stay well under that even on the largest
            // gallery.
            use std::collections::HashMap;
            let mut variants_by_media: HashMap<i64, Vec<VariantRecord>> =
                HashMap::with_capacity(records.len());
            const CHUNK: usize = 500;
            for chunk in ids.chunks(CHUNK) {
                let placeholders = std::iter::repeat("?")
                    .take(chunk.len())
                    .collect::<Vec<_>>()
                    .join(",");
                let sql = format!(
                    "SELECT media_id, id, width, format, filename, bytes_len \
                     FROM site_media_variants \
                     WHERE media_id IN ({placeholders}) \
                     ORDER BY media_id ASC, width ASC, format ASC",
                );
                let mut vstmt = conn.prepare(&sql)?;
                let params_iter =
                    rusqlite::params_from_iter(chunk.iter().copied());
                let rows = vstmt.query_map(params_iter, |r| {
                    let media_id: i64 = r.get(0)?;
                    let v = VariantRecord {
                        id: r.get(1)?,
                        width: r.get(2)?,
                        format: r.get(3)?,
                        filename: r.get(4)?,
                        bytes_len: r.get(5)?,
                    };
                    Ok((media_id, v))
                })?;
                for row in rows {
                    let (media_id, v) = row?;
                    variants_by_media.entry(media_id).or_default().push(v);
                }
            }
            for rec in &mut records {
                if let Some(vs) = variants_by_media.remove(&rec.id) {
                    rec.variants = vs;
                }
            }
            Ok(records)
        })
        .await?;
    Ok(records)
}

// ─────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────

fn load_and_normalize_bytes(source_path: &Path) -> MediaResult<Vec<u8>> {
    let ext = source_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    if matches!(ext.as_str(), "heic" | "heif") {
        return decode_heic_to_jpeg_bytes(source_path);
    }
    let bytes = std::fs::read(source_path)?;
    Ok(bytes)
}

fn decode_heic_to_jpeg_bytes(source_path: &Path) -> MediaResult<Vec<u8>> {
    use libheif_rs::{ColorSpace, HeifContext, LibHeif, RgbChroma};
    let lib = LibHeif::new();
    let path_str = source_path
        .to_str()
        .ok_or_else(|| MediaOpError::Heic("non-UTF-8 HEIC path".into()))?;
    let ctx = HeifContext::read_from_file(path_str)
        .map_err(|e| MediaOpError::Heic(format!("read: {e}")))?;
    let handle = ctx
        .primary_image_handle()
        .map_err(|e| MediaOpError::Heic(format!("primary handle: {e}")))?;
    let img = lib
        .decode(&handle, ColorSpace::Rgb(RgbChroma::Rgb), None)
        .map_err(|e| MediaOpError::Heic(format!("decode: {e}")))?;
    let planes = img.planes();
    let plane = planes
        .interleaved
        .ok_or_else(|| MediaOpError::Heic("no interleaved plane".into()))?;
    let width = plane.width as u32;
    let height = plane.height as u32;
    let stride = plane.stride;
    let src = plane.data;
    let row_bytes = (width as usize) * 3;
    let mut tight = Vec::with_capacity(row_bytes * height as usize);
    for y in 0..height as usize {
        let start = y * stride;
        tight.extend_from_slice(&src[start..start + row_bytes]);
    }
    let rgb = image::RgbImage::from_raw(width, height, tight)
        .ok_or_else(|| MediaOpError::Heic("RgbImage dimensions mismatch".into()))?;
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90)
        .encode_image(&image::DynamicImage::ImageRgb8(rgb))?;
    Ok(out)
}

fn probe_dimensions(bytes: &[u8]) -> MediaResult<(u32, u32)> {
    let img = image::load_from_memory(bytes)?;
    Ok(img.dimensions())
}

fn short_hash(bytes: &[u8]) -> String {
    website_media::hash::source_hash_hex(bytes)
        .chars()
        .take(BASE_HASH_LEN)
        .collect()
}

fn ensure_asset_dir(repo_dir: &Path, kind: MediaKind) -> MediaResult<PathBuf> {
    if !repo_dir.is_dir() {
        return Err(MediaOpError::InvalidWorkingCopy(format!(
            "working copy repo dir does not exist: {}",
            repo_dir.display()
        )));
    }
    let mut p = repo_dir.join("assets").join("img");
    let sub = asset_subdir(kind);
    if !sub.is_empty() {
        p = p.join(sub);
    }
    std::fs::create_dir_all(&p)?;
    Ok(p)
}

fn write_variants_to_working_copy(
    repo_dir: &Path,
    kind: MediaKind,
    variants: &[website_media::Variant],
) -> MediaResult<()> {
    let dir = ensure_asset_dir(repo_dir, kind)?;
    for v in variants {
        let path = dir.join(&v.filename);
        std::fs::write(&path, &v.bytes)?;
    }
    Ok(())
}

/// Insert (or update-on-conflict) a `site_media` row + a
/// `site_media_variants` row per rendered variant. Returns the
/// resulting joined [`MediaRecord`].
#[allow(clippy::too_many_arguments)]
async fn upsert_media_and_variants(
    db: &DbGate,
    base_hash: &str,
    source_filename: &str,
    kind: MediaKind,
    caption: Option<&str>,
    alt: Option<&str>,
    single_variant_override_filename: Option<&str>,
    width: Option<i64>,
    height: Option<i64>,
    original_bytes_len: Option<i64>,
    variants: &[website_media::Variant],
) -> MediaResult<MediaRecord> {
    let base_hash_owned = base_hash.to_string();
    let source_owned = source_filename.to_string();
    let kind_owned = kind.as_str().to_string();
    let caption_owned = caption.map(|s| s.to_string());
    let alt_owned = alt.map(|s| s.to_string());
    let single_override = single_variant_override_filename.map(|s| s.to_string());
    // We pull the variant tuples out of `variants` into an owned
    // structure so the closure can be `'static + Send`.
    let variant_rows: Vec<(i64, String, String, i64)> = variants
        .iter()
        .map(|v| {
            let filename = match &single_override {
                Some(name) if variants.len() == 1 => name.clone(),
                _ => v.filename.clone(),
            };
            (
                v.width as i64,
                v.format.ext().to_string(),
                filename,
                v.bytes.len() as i64,
            )
        })
        .collect();

    let media_id: i64 = db
        .with_conn(move |conn| {
            // Wrap insert + variant DELETE + variant INSERT sequence
            // in a single savepoint so a mid-sequence failure (disk
            // full, unique-conflict on a stale variant row, etc.)
            // rolls the whole thing back — otherwise we'd leave the
            // media row with zero variants and gallery.json pointing
            // at nonexistent filenames.
            let tx = conn.unchecked_transaction()?;
            // Dedup key is (base_hash, kind) not base_hash alone —
            // the same bytes uploaded as a logo AND a gallery photo
            // are legitimately distinct media rows. Previously the
            // second upload would clobber the first's kind/variants.
            let existing: Option<i64> = tx
                .query_row(
                    "SELECT id FROM site_media WHERE base_hash = ?1 AND kind = ?2",
                    params![base_hash_owned, kind_owned],
                    |r| r.get::<_, i64>(0),
                )
                .optional()?;
            let id = if let Some(id) = existing {
                tx.execute(
                    "UPDATE site_media SET \
                        source_filename = ?1, \
                        kind = ?2, \
                        caption = COALESCE(?3, caption), \
                        alt = COALESCE(?4, alt), \
                        width = COALESCE(?5, width), \
                        height = COALESCE(?6, height), \
                        original_bytes_len = COALESCE(?7, original_bytes_len), \
                        deleted_at = NULL \
                     WHERE id = ?8",
                    params![
                        source_owned,
                        kind_owned,
                        caption_owned,
                        alt_owned,
                        width,
                        height,
                        original_bytes_len,
                        id,
                    ],
                )?;
                id
            } else {
                tx.execute(
                    "INSERT INTO site_media \
                        (base_hash, source_filename, kind, caption, alt, \
                         width, height, original_bytes_len, exif_stripped, created_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, datetime('now'))",
                    params![
                        base_hash_owned,
                        source_owned,
                        kind_owned,
                        caption_owned,
                        alt_owned,
                        width,
                        height,
                        original_bytes_len,
                    ],
                )?;
                tx.last_insert_rowid()
            };

            // Replace all variant rows for this media id so a
            // re-ingest with a recipe bump doesn't leave stale rows.
            tx.execute(
                "DELETE FROM site_media_variants WHERE media_id = ?1",
                params![id],
            )?;
            for (w, fmt, fname, blen) in &variant_rows {
                tx.execute(
                    "INSERT INTO site_media_variants \
                        (media_id, width, format, filename, bytes_len) \
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![id, w, fmt, fname, blen],
                )?;
            }
            tx.commit()?;
            Ok(id)
        })
        .await?;

    load_media_record(db, media_id).await
}

/// Load one row + its variants. Errors with [`MediaOpError::NotFound`]
/// if the id doesn't exist.
async fn load_media_record(db: &DbGate, media_id: i64) -> MediaResult<MediaRecord> {
    try_load_media_record(db, media_id)
        .await?
        .ok_or(MediaOpError::NotFound(media_id))
}

async fn try_load_media_record(
    db: &DbGate,
    media_id: i64,
) -> MediaResult<Option<MediaRecord>> {
    let rec = db
        .with_conn(move |conn| {
            let row: Option<MediaRecord> = conn
                .query_row(
                    "SELECT id, base_hash, source_filename, kind, caption, alt, \
                            focal_x, focal_y, width, height, original_bytes_len, \
                            exif_stripped, created_at, deleted_at \
                     FROM site_media WHERE id = ?1",
                    params![media_id],
                    |r| {
                        Ok(MediaRecord {
                            id: r.get(0)?,
                            base_hash: r.get(1)?,
                            source_filename: r.get(2)?,
                            kind: r.get(3)?,
                            caption: r.get(4)?,
                            alt: r.get(5)?,
                            focal_x: r.get(6)?,
                            focal_y: r.get(7)?,
                            width: r.get(8)?,
                            height: r.get(9)?,
                            original_bytes_len: r.get(10)?,
                            exif_stripped: r.get::<_, i64>(11)? != 0,
                            created_at: r.get(12)?,
                            deleted_at: r.get(13)?,
                            variants: Vec::new(),
                        })
                    },
                )
                .optional()?;
            let Some(mut rec) = row else { return Ok(None) };
            let mut stmt = conn.prepare(
                "SELECT id, width, format, filename, bytes_len \
                 FROM site_media_variants WHERE media_id = ?1 \
                 ORDER BY width ASC, format ASC",
            )?;
            let rows = stmt.query_map(params![media_id], |r| {
                Ok(VariantRecord {
                    id: r.get(0)?,
                    width: r.get(1)?,
                    format: r.get(2)?,
                    filename: r.get(3)?,
                    bytes_len: r.get(4)?,
                })
            })?;
            for v in rows {
                rec.variants.push(v?);
            }
            Ok(Some(rec))
        })
        .await?;
    Ok(rec)
}

/// Return every non-deleted photo row in insertion order.
async fn load_ordered_photo_records(db: &DbGate) -> MediaResult<Vec<MediaRecord>> {
    list_media(db, Some(MediaKind::Photo)).await
}

// ─────────────────────────────────────────────────────────────────────
// gallery.json helpers
// ─────────────────────────────────────────────────────────────────────

/// Shape of one item written into `content/gallery.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct GalleryItem {
    media_id: i64,
    base_hash: String,
    source_filename: String,
    caption: Option<String>,
    alt: Option<String>,
    focal_x: Option<f64>,
    focal_y: Option<f64>,
    width: Option<i64>,
    height: Option<i64>,
    variants: Vec<GalleryVariant>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GalleryVariant {
    width: i64,
    format: String,
    filename: String,
}

fn gallery_json_path(repo_dir: &Path) -> PathBuf {
    repo_dir.join("content").join("gallery.json")
}

/// Global mutex serialising every read-modify-write of gallery.json.
/// Concurrent uploads (`website_upload_photos` runs `ingest_photo`
/// under `buffer_unordered`) previously produced a lost-update race
/// where two workers each read the same items array, appended their
/// own row, and clobbered the other. Held only around the JSON RMW,
/// not around image encoding or DB writes.
fn gallery_json_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Async mutex that serialises the *entire* DB-write + DB-snapshot +
/// gallery.json-rewrite sequence for every mutation entrypoint
/// (set_photo_meta, soft_delete, bulk_soft_delete, reorder_gallery,
/// emergency_remove). Held across `.await`, so it must be a tokio
/// mutex — std::sync::Mutex would deadlock the runtime.
///
/// The prior design serialised only the JSON write (see
/// `gallery_json_lock` above), which left an interleaving race:
///   T1: UPDATE caption=…
///   T1: load_ordered (snapshot after T1)
///   T2: UPDATE alt=… (same row)
///   T2: load_ordered (snapshot after both T1+T2)
///   T2: rewrite gallery.json ✓ (has both changes)
///   T1: rewrite gallery.json ✗ (missing T2's alt update)
/// Holding this async mutex from DB mutate through JSON write makes
/// each mutation atomic against every other mutation.
fn gallery_mutation_lock() -> &'static AsyncMutex<()> {
    static LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| AsyncMutex::new(()))
}

/// Read gallery.json as a free-form JSON object so we can preserve
/// site-owned top-level fields (page_heading, search_placeholder,
/// caption_pool, total_images, photo_path_pattern, ...) that PR 1
/// added and templates depend on. Only the `items` key is under
/// this module's control.
fn read_gallery_root(repo_dir: &Path) -> MediaResult<serde_json::Map<String, serde_json::Value>> {
    let p = gallery_json_path(repo_dir);
    if !p.exists() {
        let mut root = serde_json::Map::new();
        root.insert("schema_version".into(), serde_json::json!(1));
        root.insert("items".into(), serde_json::json!([]));
        return Ok(root);
    }
    let raw = std::fs::read_to_string(&p)?;
    // Refuse to silently coerce corrupt/partial JSON to `{}` — doing
    // so lets the next write wipe every site-owned top-level field
    // (page_heading, caption_pool, ...) and every existing photo row.
    // The caller surfaces this to the UI so the owner can restore
    // from git before we clobber their gallery.
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| MediaOpError::InvalidWorkingCopy(format!("{}: corrupt JSON — {e}", p.display())))?;
    let mut root = match value {
        serde_json::Value::Object(m) => m,
        _ => {
            return Err(MediaOpError::InvalidWorkingCopy(format!(
                "{}: expected top-level JSON object",
                p.display()
            )))
        }
    };
    if !root.contains_key("schema_version") {
        root.insert("schema_version".into(), serde_json::json!(1));
    }
    if !root.contains_key("items") {
        root.insert("items".into(), serde_json::json!([]));
    }
    Ok(root)
}

fn write_gallery_root(
    repo_dir: &Path,
    root: &serde_json::Map<String, serde_json::Value>,
) -> MediaResult<()> {
    let p = gallery_json_path(repo_dir);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut s = serde_json::to_string_pretty(&serde_json::Value::Object(root.clone()))?;
    if !s.ends_with('\n') {
        s.push('\n');
    }
    // Atomic write: stage bytes into a sibling tempfile, fsync, then
    // rename over the target so a mid-write crash or power loss can
    // never leave a truncated / half-written gallery.json — the file
    // is the whole gallery ordering + captions + focal points, and a
    // partial write means silent data loss on the next read.
    let tmp_name = format!(
        ".gallery.json.tmp.{}",
        std::process::id()
    );
    let tmp = p
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(&tmp_name);
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(s.as_bytes())?;
        f.sync_all()?;
    }
    // std::fs::rename is atomic on POSIX and (for same-volume, non-open
    // targets) on NTFS. If the destination is held open by another
    // reader on Windows the rename can fail EACCES — retry once.
    if let Err(e) = std::fs::rename(&tmp, &p) {
        if cfg!(windows) {
            std::thread::sleep(std::time::Duration::from_millis(50));
            std::fs::rename(&tmp, &p)?;
        } else {
            return Err(e.into());
        }
    }
    Ok(())
}

/// Convert a media record into a gallery.json item shape.
fn record_to_item(rec: &MediaRecord) -> GalleryItem {
    GalleryItem {
        media_id: rec.id,
        base_hash: rec.base_hash.clone(),
        source_filename: rec.source_filename.clone(),
        caption: rec.caption.clone(),
        alt: rec.alt.clone(),
        focal_x: rec.focal_x,
        focal_y: rec.focal_y,
        width: rec.width,
        height: rec.height,
        variants: rec
            .variants
            .iter()
            .map(|v| GalleryVariant {
                width: v.width,
                format: v.format.clone(),
                filename: v.filename.clone(),
            })
            .collect(),
    }
}

fn parse_items(root: &serde_json::Map<String, serde_json::Value>) -> Vec<GalleryItem> {
    root.get("items")
        .and_then(|v| serde_json::from_value::<Vec<GalleryItem>>(v.clone()).ok())
        .unwrap_or_default()
}

fn set_items(
    root: &mut serde_json::Map<String, serde_json::Value>,
    items: Vec<GalleryItem>,
) -> MediaResult<()> {
    root.insert("items".into(), serde_json::to_value(items)?);
    Ok(())
}

/// Append or update an item for `rec`, preserving the existing order
/// of all other items AND all site-owned top-level fields.
fn upsert_gallery_entry(repo_dir: &Path, rec: &MediaRecord) -> MediaResult<()> {
    let _guard = gallery_json_lock().lock().unwrap_or_else(|p| p.into_inner());
    let mut root = read_gallery_root(repo_dir)?;
    let mut items = parse_items(&root);
    let item = record_to_item(rec);
    if let Some(pos) = items.iter().position(|it| it.media_id == rec.id) {
        items[pos] = item;
    } else {
        items.push(item);
    }
    set_items(&mut root, items)?;
    write_gallery_root(repo_dir, &root)?;
    Ok(())
}

/// Replace the gallery.json items array with the passed-in records
/// (in order). Used by reorder / soft_delete / set_photo_meta.
/// Preserves site-owned top-level fields.
fn rewrite_gallery_items(repo_dir: &Path, records: &[MediaRecord]) -> MediaResult<()> {
    let _guard = gallery_json_lock().lock().unwrap_or_else(|p| p.into_inner());
    let mut root = read_gallery_root(repo_dir)?;
    let items: Vec<GalleryItem> = records.iter().map(record_to_item).collect();
    set_items(&mut root, items)?;
    write_gallery_root(repo_dir, &root)?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────
// Brand-asset resize helpers (favicon / OG image)
// ─────────────────────────────────────────────────────────────────────

fn encode_png(img: &DynamicImage) -> MediaResult<Vec<u8>> {
    let mut buf = Vec::new();
    img.write_to(&mut Cursor::new(&mut buf), ImageFormat::Png)?;
    Ok(buf)
}

/// Crop-to-fill: resize + center-crop so the output is exactly
/// `target_w × target_h` while preserving the source aspect ratio.
fn crop_to_fill(img: &DynamicImage, target_w: u32, target_h: u32) -> DynamicImage {
    let (sw, sh) = img.dimensions();
    if sw == 0 || sh == 0 {
        return img.resize_exact(target_w, target_h, FilterType::Lanczos3);
    }
    let src_ratio = sw as f64 / sh as f64;
    let dst_ratio = target_w as f64 / target_h as f64;
    let (rw, rh) = if src_ratio > dst_ratio {
        // Source is wider — scale to target height first.
        let rh = target_h;
        let rw = ((target_h as f64) * src_ratio).round() as u32;
        (rw, rh)
    } else {
        let rw = target_w;
        let rh = ((target_w as f64) / src_ratio).round() as u32;
        (rw, rh)
    };
    let resized = img.resize_exact(rw.max(1), rh.max(1), FilterType::Lanczos3);
    let (rw, rh) = resized.dimensions();
    let x = rw.saturating_sub(target_w) / 2;
    let y = rh.saturating_sub(target_h) / 2;
    resized.crop_imm(x, y, target_w.min(rw), target_h.min(rh))
}

/// Widths (== heights) for the favicon set.
const FAVICON_SIZES: &[u32] = &[16, 32, 180];

async fn regenerate_favicons_from_source(
    db: &DbGate,
    repo_dir: &Path,
    source_path: &Path,
) -> MediaResult<MediaRecord> {
    let bytes = load_and_normalize_bytes(source_path)?;
    let img = image::load_from_memory(&bytes)?;

    let out_dir = ensure_asset_dir(repo_dir, MediaKind::Favicon)?;
    let mut variants: Vec<website_media::Variant> = Vec::new();
    for &sz in FAVICON_SIZES {
        let square = crop_to_fill(&img, sz, sz);
        let png = encode_png(&square)?;
        let filename = format!("favicon-{sz}.png");
        std::fs::write(out_dir.join(&filename), &png)?;
        // Reuse the pipeline Variant type for downstream storage.
        variants.push(website_media::Variant {
            width: sz,
            format: Format::Jpg, // stored under "jpg" ext string; on-disk file is PNG.
            filename,
            bytes: png,
        });
    }

    let source_filename = source_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("favicon.png")
        .to_string();
    let base_hash = short_hash(&bytes);

    upsert_media_and_variants(
        db,
        &base_hash,
        &source_filename,
        MediaKind::Favicon,
        None,
        None,
        None,
        Some(img.width() as i64),
        Some(img.height() as i64),
        Some(bytes.len() as i64),
        &variants,
    )
    .await
}

// ─────────────────────────────────────────────────────────────────────
// Test-only in-memory helpers
// ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
pub(crate) fn apply_test_migrations(conn: &Connection) {
    let sql14 = include_str!("../../migrations/014_website_cms.sql");
    let sql15 = include_str!("../../migrations/015_website_media.sql");
    let sql16 = include_str!("../../migrations/016_site_media_kind_unique.sql");
    conn.execute_batch(sql14).unwrap();
    conn.execute_batch(sql15).unwrap();
    conn.execute_batch(sql16).unwrap();
}

#[cfg(test)]
pub(crate) async fn fresh_test_gate() -> (DbGate, tempfile::TempDir) {
    // Open on an ephemeral temp file so DbGate's mutex is real.
    let tmp = tempfile::tempdir().unwrap();
    let db_path = tmp.path().join("test.db");
    let gate = DbGate::new();
    gate.open_plaintext(&db_path).await.unwrap();
    gate.with_conn(|conn| {
        apply_test_migrations(conn);
        Ok(())
    })
    .await
    .unwrap();
    (gate, tmp)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::codecs::jpeg::JpegEncoder;
    use image::{ImageEncoder, RgbImage};

    /// Test-only projection of the items-only slice of gallery.json.
    /// Real gallery.json also carries page_heading/search_placeholder/
    /// caption_pool/... which we deliberately preserve but ignore here.
    #[derive(Debug, Clone, Deserialize)]
    struct GalleryJson {
        #[serde(default)]
        items: Vec<GalleryItem>,
    }

    fn make_solid_jpeg(w: u32, h: u32, colour: [u8; 3]) -> Vec<u8> {
        let mut img = RgbImage::new(w, h);
        for px in img.pixels_mut() {
            *px = image::Rgb(colour);
        }
        let mut buf = Vec::new();
        JpegEncoder::new_with_quality(&mut buf, 90)
            .write_image(img.as_raw(), w, h, image::ExtendedColorType::Rgb8)
            .unwrap();
        buf
    }

    fn make_working_copy() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let content = tmp.path().join("content");
        std::fs::create_dir_all(&content).unwrap();
        std::fs::create_dir_all(tmp.path().join("assets").join("img").join("gallery")).unwrap();
        // Seed a gallery.json so we exercise the merge path too.
        std::fs::write(
            content.join("gallery.json"),
            b"{\"schema_version\":1,\"items\":[]}\n",
        )
        .unwrap();
        tmp
    }

    fn write_temp_jpeg(bytes: &[u8]) -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("photo.jpg");
        std::fs::write(&path, bytes).unwrap();
        (tmp, path)
    }

    #[tokio::test]
    async fn ingest_photo_writes_variants_and_records() {
        let (db, _dbtmp) = fresh_test_gate().await;
        let wc = make_working_copy();
        let jpeg = make_solid_jpeg(1200, 800, [80, 160, 40]);
        let (_srctmp, src) = write_temp_jpeg(&jpeg);

        let rec = ingest_photo(
            &db,
            wc.path(),
            &src,
            MediaKind::Photo,
            Some("caption".into()),
            Some("alt".into()),
        )
        .await
        .expect("ingest ok");

        assert_eq!(rec.kind, "photo");
        assert_eq!(rec.caption.as_deref(), Some("caption"));
        assert_eq!(rec.alt.as_deref(), Some("alt"));
        assert_eq!(rec.base_hash.len(), BASE_HASH_LEN);

        // Variant count matches the pipeline output.
        assert_eq!(
            rec.variants.len(),
            9,
            "expected 3 widths × 3 formats variants"
        );

        // Every variant filename now lives under assets/img/gallery/.
        let gallery_dir = wc.path().join("assets").join("img").join("gallery");
        for v in &rec.variants {
            let p = gallery_dir.join(&v.filename);
            assert!(p.exists(), "variant file missing: {}", p.display());
            let disk_len = std::fs::metadata(&p).unwrap().len() as i64;
            assert_eq!(disk_len, v.bytes_len, "size mismatch for {}", v.filename);
        }

        // Gallery JSON has one item pointing at this record.
        let gj: GalleryJson = serde_json::from_str(
            &std::fs::read_to_string(gallery_json_path(wc.path())).unwrap(),
        )
        .unwrap();
        assert_eq!(gj.items.len(), 1);
        assert_eq!(gj.items[0].media_id, rec.id);
        assert_eq!(gj.items[0].variants.len(), 9);
    }

    #[tokio::test]
    async fn reorder_gallery_rewrites_json_in_expected_order() {
        let (db, _dbtmp) = fresh_test_gate().await;
        let wc = make_working_copy();

        let mut ids = Vec::new();
        for i in 0..3u8 {
            let jpeg = make_solid_jpeg(400, 300, [i * 40, i * 60, i * 80]);
            let (_srctmp, src) = write_temp_jpeg(&jpeg);
            let src2 = src.with_file_name(format!("photo{}.jpg", i));
            std::fs::rename(&src, &src2).unwrap();
            let rec = ingest_photo(
                &db,
                wc.path(),
                &src2,
                MediaKind::Photo,
                Some(format!("cap-{i}")),
                None,
            )
            .await
            .expect("ingest ok");
            ids.push(rec.id);
        }

        // Reverse the order.
        let reversed = ids.iter().rev().copied().collect::<Vec<_>>();
        reorder_gallery(&db, wc.path(), reversed.clone())
            .await
            .expect("reorder ok");

        let gj: GalleryJson = serde_json::from_str(
            &std::fs::read_to_string(gallery_json_path(wc.path())).unwrap(),
        )
        .unwrap();
        let got: Vec<i64> = gj.items.iter().map(|it| it.media_id).collect();
        assert_eq!(got, reversed);
    }

    #[tokio::test]
    async fn set_photo_meta_updates_db_and_json() {
        let (db, _dbtmp) = fresh_test_gate().await;
        let wc = make_working_copy();
        let jpeg = make_solid_jpeg(400, 300, [12, 34, 56]);
        let (_srctmp, src) = write_temp_jpeg(&jpeg);
        let rec = ingest_photo(&db, wc.path(), &src, MediaKind::Photo, None, None)
            .await
            .unwrap();

        let updated = set_photo_meta(
            &db,
            wc.path(),
            rec.id,
            Some("new caption".into()),
            Some("new alt".into()),
            Some((0.25, 0.75)),
        )
        .await
        .unwrap();
        assert_eq!(updated.caption.as_deref(), Some("new caption"));
        assert_eq!(updated.alt.as_deref(), Some("new alt"));
        assert_eq!(updated.focal_x, Some(0.25));
        assert_eq!(updated.focal_y, Some(0.75));

        // JSON reflects the update.
        let gj: GalleryJson = serde_json::from_str(
            &std::fs::read_to_string(gallery_json_path(wc.path())).unwrap(),
        )
        .unwrap();
        assert_eq!(gj.items[0].caption.as_deref(), Some("new caption"));
        assert_eq!(gj.items[0].focal_x, Some(0.25));
    }

    #[tokio::test]
    async fn soft_delete_removes_from_json_and_flags_row() {
        let (db, _dbtmp) = fresh_test_gate().await;
        let wc = make_working_copy();
        let jpeg = make_solid_jpeg(400, 300, [1, 2, 3]);
        let (_srctmp, src) = write_temp_jpeg(&jpeg);
        let rec = ingest_photo(&db, wc.path(), &src, MediaKind::Photo, None, None)
            .await
            .unwrap();

        soft_delete(&db, wc.path(), rec.id).await.unwrap();

        // Row is marked deleted.
        let reloaded = try_load_media_record(&db, rec.id).await.unwrap().unwrap();
        assert!(reloaded.deleted_at.is_some());

        // Gallery.json no longer references it.
        let gj: GalleryJson = serde_json::from_str(
            &std::fs::read_to_string(gallery_json_path(wc.path())).unwrap(),
        )
        .unwrap();
        assert!(gj.items.iter().all(|it| it.media_id != rec.id));
    }

    #[tokio::test]
    async fn emergency_remove_flags_row_and_writes_audit() {
        let (db, _dbtmp) = fresh_test_gate().await;
        let wc = make_working_copy();
        let jpeg = make_solid_jpeg(400, 300, [7, 8, 9]);
        let (_srctmp, src) = write_temp_jpeg(&jpeg);
        let rec = ingest_photo(&db, wc.path(), &src, MediaKind::Photo, None, None)
            .await
            .unwrap();

        emergency_remove(
            &db,
            wc.path(),
            rec.id,
            "parent revoked consent".into(),
            "admin@echelondaycare.example".into(),
        )
        .await
        .unwrap();

        // Row marked deleted.
        let reloaded = try_load_media_record(&db, rec.id).await.unwrap().unwrap();
        assert!(reloaded.deleted_at.is_some());

        // Audit row written.
        let (count, reason): (i64, String) = db
            .with_conn(move |conn| {
                let r = conn.query_row(
                    "SELECT COUNT(*), MIN(reason) FROM site_emergency_removes \
                     WHERE media_id = ?1",
                    params![rec.id],
                    |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
                )?;
                Ok(r)
            })
            .await
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(reason, "parent revoked consent");
    }

    #[test]
    fn crop_to_fill_center_crops_landscape_to_og_ratio() {
        // 1600x900 → 1200x630 is a mild aspect change but should
        // still crop-not-letterbox.
        let mut img = RgbImage::new(1600, 900);
        for px in img.pixels_mut() {
            *px = image::Rgb([50, 50, 50]);
        }
        let dyn_img = DynamicImage::ImageRgb8(img);
        let out = crop_to_fill(&dyn_img, 1200, 630);
        assert_eq!(out.dimensions(), (1200, 630));
    }

    #[tokio::test]
    async fn migration_015_applies_cleanly() {
        // Fresh temp DB → run only 014 + 015 → SELECT sqlite_master
        // to confirm every table + index we expect is present.
        let (db, _tmp) = fresh_test_gate().await;
        let tables: Vec<String> = db
            .with_conn(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT name FROM sqlite_master \
                     WHERE type='table' AND name LIKE 'site_%' \
                     ORDER BY name",
                )?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
                let mut out = Vec::new();
                for r in rows {
                    out.push(r?);
                }
                Ok(out)
            })
            .await
            .unwrap();
        assert!(tables.iter().any(|n| n == "site_media"));
        assert!(tables.iter().any(|n| n == "site_media_variants"));
        assert!(tables.iter().any(|n| n == "site_emergency_removes"));
        // From migration 014.
        assert!(tables.iter().any(|n| n == "site_revisions"));
        assert!(tables.iter().any(|n| n == "site_pointers"));
        assert!(tables.iter().any(|n| n == "site_publications"));
    }

    #[tokio::test]
    async fn upsert_gallery_entry_is_idempotent() {
        let (db, _dbtmp) = fresh_test_gate().await;
        let wc = make_working_copy();
        let jpeg = make_solid_jpeg(400, 300, [1, 2, 3]);
        let (_srctmp, src) = write_temp_jpeg(&jpeg);
        let rec1 = ingest_photo(&db, wc.path(), &src, MediaKind::Photo, None, None)
            .await
            .unwrap();
        // Re-ingest the same source. Should NOT create a new row —
        // base_hash is unique.
        let rec2 = ingest_photo(&db, wc.path(), &src, MediaKind::Photo, None, None)
            .await
            .unwrap();
        assert_eq!(rec1.id, rec2.id, "same base_hash must dedup");

        // And gallery.json still has exactly one item.
        let gj: GalleryJson = serde_json::from_str(
            &std::fs::read_to_string(gallery_json_path(wc.path())).unwrap(),
        )
        .unwrap();
        assert_eq!(gj.items.len(), 1);
    }
}
