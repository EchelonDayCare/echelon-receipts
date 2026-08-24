//! Tauri command surface for the Website CMS module.
//!
//! # Feature-flag gating
//! Every command below except `website_feature_enabled` first checks
//! [`crate::website::FeatureFlag`] and refuses to run if the flag is
//! off. So even if the frontend accidentally imports a screen while
//! the flag is disabled, the Rust side won't write to
//! `site_revisions` or spawn a preview server.
//!
//! # Working-copy discipline
//! Every command that touches the working copy resolves paths via
//! [`crate::website::git_ops::WorkingCopy::from_app_data`] using the
//! Tauri `AppHandle`'s `app_data_dir()`. This is the same directory
//! `path_guard::app_data_dir` is scoped to, so a rogue command
//! argument can't redirect writes elsewhere.

use std::path::{Path, PathBuf};

use futures::stream::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::db_gate::DbGate;
use crate::website::{
    git_ops, media, pat, preview_server, publish, renderer, revisions, schema, FeatureFlag,
    WebsiteState,
};

pub fn require_enabled() -> Result<(), String> {
    if !FeatureFlag::detect().enabled() {
        return Err(
            "Website CMS is disabled. Unset ECHELON_WEBSITE_CMS or set it to a non-zero value."
                .to_string(),
        );
    }
    Ok(())
}

fn working_copy_from_app(app: &AppHandle) -> Result<git_ops::WorkingCopy, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(&base).map_err(|e| format!("mkdir app data: {e}"))?;
    Ok(git_ops::WorkingCopy::from_app_data(&base))
}

// ─────────────────────────────────────────────────────────────────────
// Feature flag
// ─────────────────────────────────────────────────────────────────────

/// Returns whether the CMS is enabled. Never fails — the frontend
/// gates every entry point on this. Called during app-boot to decide
/// whether to render the sidebar entry and Home tile.
#[tauri::command]
pub fn website_feature_enabled() -> bool {
    FeatureFlag::detect().enabled()
}

// ─────────────────────────────────────────────────────────────────────
// Working copy lifecycle
// ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct WorkingCopyStatus {
    pub root: String,
    pub cloned: bool,
    pub head_sha: Option<String>,
    /// True iff `content/` and `templates/` both exist.
    pub content_present: bool,
    pub templates_present: bool,
}

/// Report the working-copy state.
#[tauri::command]
pub fn website_working_copy_status(app: AppHandle) -> Result<WorkingCopyStatus, String> {
    require_enabled()?;
    let wc = working_copy_from_app(&app)?;
    let cloned = wc.exists();
    let head_sha = if cloned {
        wc.open().ok().and_then(|r| git_ops::head_sha(&r).ok())
    } else {
        None
    };
    let content_present = wc.repo_dir.join("content").is_dir();
    let templates_present = wc.repo_dir.join("templates").is_dir();
    Ok(WorkingCopyStatus {
        root: wc.root.to_string_lossy().to_string(),
        cloned,
        head_sha,
        content_present,
        templates_present,
    })
}

/// Ensure the working copy exists **and is in sync with origin/main**.
///
/// * If missing: clone from the site repo.
/// * If present: fetch + fast-forward `main` so the local working copy
///   picks up any template / content changes pushed since the last
///   time this machine ran the app. This prevents the "old template
///   vs new content schema" mismatch that ships as a strict-undefined
///   render error the first time a new machine tries to preview.
///
/// If the local `main` has diverged (rare — only if the user hand-
/// edited the repo), we swallow the ff error and return normally: the
/// user can still edit + publish, they just won't have the latest
/// upstream. The next explicit `website_working_copy_pull` surfaces
/// the divergence properly so it isn't silent forever.
#[tauri::command]
pub async fn website_working_copy_init(
    app: AppHandle,
    db: State<'_, DbGate>,
) -> Result<WorkingCopyStatus, String> {
    require_enabled()?;
    let wc = working_copy_from_app(&app)?;
    let wc_clone = git_ops::WorkingCopy::from_app_data(
        &app.path().app_data_dir().map_err(|e| e.to_string())?,
    );
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let already = wc_clone.exists();
        let repo = wc_clone.ensure_cloned()?;
        if already {
            // Best-effort sync: swallow non-fast-forward so the user
            // isn't blocked from opening the CMS just because they
            // have a stray local edit. Real conflicts surface via the
            // dedicated pull command.
            let _ = git_ops::fetch_and_ff_main(&repo);
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("join: {e}"))??;
    // Hydrate the local SQLite gallery index from content/gallery.json
    // so a fresh clone on a new machine sees the existing photos
    // instead of an empty gallery (the first caption edit / delete
    // there would otherwise silently rewrite gallery.json and wipe
    // every published photo). Log failures so they surface in the
    // dev console instead of silently leaving the Gallery blank.
    if let Err(e) = super::media::hydrate_gallery_from_json(db.inner(), &wc.repo_dir).await {
        eprintln!("[website] hydrate_gallery_from_json failed: {e}");
    }
    let head_sha = wc.open().ok().and_then(|r| git_ops::head_sha(&r).ok());
    Ok(WorkingCopyStatus {
        root: wc.root.to_string_lossy().to_string(),
        cloned: true,
        head_sha,
        content_present: wc.repo_dir.join("content").is_dir(),
        templates_present: wc.repo_dir.join("templates").is_dir(),
    })
}

/// Fetch + fast-forward `main`. Returns the new HEAD sha.
#[tauri::command]
pub async fn website_working_copy_pull(app: AppHandle) -> Result<String, String> {
    require_enabled()?;
    let wc = working_copy_from_app(&app)?;
    tokio::task::spawn_blocking(move || {
        let repo = wc.open()?;
        git_ops::fetch_and_ff_main(&repo)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

// ─────────────────────────────────────────────────────────────────────
// Content read / draft save
// ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ContentFile {
    pub file: String,
    pub content_json: String,
    pub source: &'static str,
    pub active_draft_rev: Option<i64>,
}

/// Load `content/<file>.json` — preferring the current draft in
/// `site_revisions` over the working-copy version. If neither exists,
/// returns Err.
#[tauri::command]
pub async fn website_load_content(
    app: AppHandle,
    db: State<'_, DbGate>,
    file: String,
) -> Result<ContentFile, String> {
    require_enabled()?;
    if !schema::is_editable(&file) {
        return Err(format!("File '{file}' is not editable in PR 2 (media / gallery lands in PR 3)."));
    }
    let wc = working_copy_from_app(&app)?;

    // Prefer the DB draft if one exists.
    let draft = revisions::load_draft(db.inner(), &file)
        .await
        .map_err(|e| e.to_string())?;
    let pointer = revisions::list_pointers(db.inner())
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|p| p.file == file);
    if let Some(content_json) = draft {
        return Ok(ContentFile {
            file,
            content_json,
            source: "draft",
            active_draft_rev: pointer.and_then(|p| p.active_draft_rev),
        });
    }

    // Fall back to working copy.
    let path: PathBuf = wc.repo_dir.join("content").join(format!("{file}.json"));
    if !path.exists() {
        return Err(format!("{}: not found in working copy", path.display()));
    }
    let content_json =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    Ok(ContentFile {
        file,
        content_json,
        source: "working_copy",
        active_draft_rev: None,
    })
}

#[derive(Debug, Clone, Deserialize)]
pub struct SaveDraftRequest {
    pub file: String,
    pub content_json: String,
    pub author: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SaveDraftResponse {
    pub revision_id: i64,
    pub file: String,
}

/// Validate + save a draft. Returns the new revision id so the UI
/// can jump into the History screen if the user wants.
#[tauri::command]
pub async fn website_save_draft(
    db: State<'_, DbGate>,
    req: SaveDraftRequest,
) -> Result<SaveDraftResponse, String> {
    require_enabled()?;
    if !schema::is_editable(&req.file) {
        return Err(format!("File '{}' is not editable in PR 2.", req.file));
    }
    // Reject invalid JSON before it hits the DB.
    schema::validate(&req.file, &req.content_json)?;
    let rev_id = revisions::save_draft(
        db.inner(),
        &req.file,
        &req.content_json,
        req.author.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(SaveDraftResponse {
        revision_id: rev_id,
        file: req.file,
    })
}

// ─────────────────────────────────────────────────────────────────────
// History
// ─────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn website_list_revisions(
    db: State<'_, DbGate>,
    file: String,
    limit: Option<i64>,
) -> Result<Vec<revisions::RevisionRow>, String> {
    require_enabled()?;
    let limit = limit.unwrap_or(100).clamp(1, 500);
    revisions::list_revisions(db.inner(), &file, limit)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn website_load_revision(
    db: State<'_, DbGate>,
    rev_id: i64,
) -> Result<String, String> {
    require_enabled()?;
    revisions::load_revision(db.inner(), rev_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn website_restore_revision(
    db: State<'_, DbGate>,
    rev_id: i64,
    author: Option<String>,
) -> Result<i64, String> {
    require_enabled()?;
    revisions::restore_revision(db.inner(), rev_id, author.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn website_list_pointers(
    db: State<'_, DbGate>,
) -> Result<Vec<revisions::PointerRow>, String> {
    require_enabled()?;
    revisions::list_pointers(db.inner())
        .await
        .map_err(|e| e.to_string())
}

// ─────────────────────────────────────────────────────────────────────
// Preview
// ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct PreviewInfo {
    pub url: String,
    pub port: u16,
    pub render_dir: String,
    pub pages: Vec<String>,
}

/// Re-render the site from the current drafts + working copy and
/// (re)start the preview server. The frontend loads `info.url` in an
/// `<iframe>` on the Preview screen.
#[tauri::command]
pub async fn website_start_preview(
    app: AppHandle,
    db: State<'_, DbGate>,
    state: State<'_, WebsiteState>,
) -> Result<PreviewInfo, String> {
    require_enabled()?;
    let wc = working_copy_from_app(&app)?;
    if !wc.exists() {
        return Err(
            "Working copy not initialized. Click 'Set up working copy' first.".into(),
        );
    }
    // Collect the current draft for every editable file. If a file
    // has no draft, fall back silently to the working-copy version.
    let mut overrides = std::collections::BTreeMap::new();
    for file in schema::EDITABLE_FILES {
        if let Some(json_str) = revisions::load_draft(db.inner(), file)
            .await
            .map_err(|e| e.to_string())?
        {
            let v: serde_json::Value = serde_json::from_str(&json_str).map_err(|e| {
                format!("draft for {file} is not valid JSON: {e}")
            })?;
            overrides.insert(file.to_string(), v);
        }
    }
    let render_dir = wc.render_dir.clone();
    std::fs::create_dir_all(&render_dir)
        .map_err(|e| format!("mkdir render_dir: {e}"))?;
    let repo_dir = wc.repo_dir.clone();
    let (pages, render_dir) = tokio::task::spawn_blocking(move || {
        let inputs = renderer::RenderInputs::load(&repo_dir, overrides)?;
        // Copy assets FIRST (CSS/img/JS/data), THEN render. Otherwise the
        // asset copy overwrites files the renderer generates from CMS
        // content (notably `assets/data/jobs.json`, which is derived from
        // `content/careers.json`).
        let _ = copy_assets_best_effort(&inputs.repo_root, &render_dir);
        let written = renderer::render_all(&inputs, &render_dir)?;
        Ok::<_, String>((written, render_dir))
    })
    .await
    .map_err(|e| format!("join: {e}"))??;

    // (Re)start the server. Drop the old handle first so the port
    // binder doesn't collide.
    let mut guard = state.preview.lock().await;
    guard.take(); // drops any prior server
    let handle = preview_server::PreviewHandle::start(render_dir.clone())?;
    let info = PreviewInfo {
        url: handle.url.clone(),
        port: handle.port,
        render_dir: handle.root.to_string_lossy().to_string(),
        pages: pages.into_iter().map(|(k, _)| k).collect(),
    };
    *guard = Some(handle);
    Ok(info)
}

fn copy_assets_best_effort(
    repo_dir: &std::path::Path,
    render_dir: &std::path::Path,
) -> std::io::Result<()> {
    let src = repo_dir.join("assets");
    if !src.is_dir() {
        return Ok(());
    }
    let dst = render_dir.join("assets");
    copy_tree(&src, &dst)
}

fn copy_tree(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    if !src.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_tree(&from, &to)?;
        } else if ty.is_file() {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Stop the preview server. Idempotent.
#[tauri::command]
pub async fn website_stop_preview(state: State<'_, WebsiteState>) -> Result<(), String> {
    require_enabled()?;
    let mut guard = state.preview.lock().await;
    guard.take();
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────
// Publish
// ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct PublishRequest {
    pub commit_message: String,
    pub author_display: Option<String>,
    /// If true, we skip the actual push to GitHub. Used for local
    /// dry-runs the user's expected to do a few times before enabling
    /// real publishing in a follow-up PR.
    #[serde(default)]
    pub dry_run: bool,
}

/// Run the publish pipeline synchronously (from the caller's point of
/// view — the actual work happens on a Tokio task).
#[tauri::command]
pub async fn website_publish(
    app: AppHandle,
    db: State<'_, DbGate>,
    state: State<'_, WebsiteState>,
    req: PublishRequest,
) -> Result<publish::PipelineOutcome, String> {
    require_enabled()?;
    let wc = working_copy_from_app(&app)?;
    if !wc.exists() {
        return Err("Working copy not initialized.".into());
    }

    // Only one publish at a time.
    let _lock = state.publish_in_flight.lock().await;

    // Collect drafts.
    let mut drafts: Vec<(String, String)> = Vec::new();
    for file in schema::EDITABLE_FILES {
        if let Some(json_str) = revisions::load_draft(db.inner(), file)
            .await
            .map_err(|e| e.to_string())?
        {
            drafts.push((file.to_string(), json_str));
        }
    }

    let pat_opt = if req.dry_run { None } else { pat::load_pat()? };

    let inputs = publish::PipelineInputs {
        db: db.inner(),
        repo_dir: &wc.repo_dir,
        render_dir: &wc.render_dir,
        drafts: drafts.clone(),
        commit_message: req.commit_message,
        author_display: req.author_display,
        pat: pat_opt,
        dry_run: req.dry_run,
        verified_url: "https://echelondaycare.com/".to_string(),
    };
    let outcome = publish::run_pipeline(inputs).await;

    if outcome.error.is_none() && !req.dry_run {
        // Mark pushed + verified so the pointer table reflects reality.
        let files: Vec<String> = drafts.iter().map(|(f, _)| f.clone()).collect();
        let _ = revisions::mark_pushed(db.inner(), &files).await;
        let _ = revisions::mark_verified_live(db.inner(), &files).await;
    }
    Ok(outcome)
}

#[tauri::command]
pub async fn website_list_publications(
    db: State<'_, DbGate>,
    limit: Option<i64>,
) -> Result<Vec<publish::PublicationRow>, String> {
    require_enabled()?;
    let limit = limit.unwrap_or(50).clamp(1, 500);
    publish::list_recent(db.inner(), limit)
        .await
        .map_err(|e| e.to_string())
}

// ─────────────────────────────────────────────────────────────────────
// PAT wizard
// ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct PatStatus {
    pub connected: bool,
}

#[tauri::command]
pub fn website_pat_status() -> Result<PatStatus, String> {
    require_enabled()?;
    Ok(PatStatus {
        connected: pat::is_stored()?,
    })
}

#[tauri::command]
pub async fn website_pat_verify_and_store(
    token: String,
) -> Result<pat::PatVerification, String> {
    require_enabled()?;
    let v = pat::verify_pat(&token).await?;
    if v.ok {
        pat::store_pat(&token)?;
    }
    Ok(v)
}

#[tauri::command]
pub fn website_pat_disconnect() -> Result<(), String> {
    require_enabled()?;
    pat::delete_pat()
}

// ─────────────────────────────────────────────────────────────────────
// Media pipeline (v3.20.0 PR 3)
// ─────────────────────────────────────────────────────────────────────
//
// All commands below are `async` because the underlying pipeline is
// CPU-bound and runs on `tokio::task::spawn_blocking` inside
// `media::ingest_photo`. Every command resolves the working-copy
// path from `AppHandle` so a malicious frontend can't redirect
// writes elsewhere.

fn ensure_working_copy(app: &AppHandle) -> Result<git_ops::WorkingCopy, String> {
    let wc = working_copy_from_app(app)?;
    if !wc.exists() {
        return Err(
            "Working copy not initialized. Click 'Set up working copy' first.".into(),
        );
    }
    Ok(wc)
}

fn to_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
pub async fn website_list_media(
    db: State<'_, DbGate>,
    kind: Option<String>,
) -> Result<Vec<media::MediaRecord>, String> {
    require_enabled()?;
    let parsed_kind = match kind {
        Some(k) => Some(media::MediaKind::parse(&k).ok_or_else(|| format!("unknown kind: {k}"))?),
        None => None,
    };
    media::list_media(db.inner(), parsed_kind)
        .await
        .map_err(to_err)
}

#[tauri::command]
pub async fn website_upload_photo(
    app: AppHandle,
    db: State<'_, DbGate>,
    source_path: String,
    caption: Option<String>,
    alt: Option<String>,
) -> Result<media::MediaRecord, String> {
    require_enabled()?;
    let wc = ensure_working_copy(&app)?;
    media::ingest_photo(
        db.inner(),
        &wc.repo_dir,
        Path::new(&source_path),
        media::MediaKind::Photo,
        caption,
        alt,
    )
    .await
    .map_err(to_err)
}

#[tauri::command]
pub async fn website_upload_photos(
    app: AppHandle,
    db: State<'_, DbGate>,
    source_paths: Vec<String>,
) -> Result<Vec<media::MediaRecord>, String> {
    require_enabled()?;
    let wc = ensure_working_copy(&app)?;

    // Ingest photos in parallel: each `ingest_photo` blocks on rayon
    // for the 9-variant encode + a small tokio::spawn_blocking hop.
    // Bulk uploads (e.g. 50 photos) benefit massively from running
    // several ingests concurrently — the per-photo rayon pool already
    // saturates cores within a photo, but different photos still
    // overlap the disk read + DB write + moderate encode phases.
    // Bound the concurrency to avoid RAM spikes on very large uploads.
    let cpus: usize = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    let concurrency = std::cmp::max(2, cpus.saturating_sub(1)).min(8);
    let repo_dir = wc.repo_dir.clone();
    let db_gate = db.inner().clone();
    let results: Vec<Result<media::MediaRecord, String>> =
        futures::stream::iter(source_paths.into_iter().map(|path| {
            let repo_dir = repo_dir.clone();
            let db_gate = db_gate.clone();
            async move {
                media::ingest_photo(
                    &db_gate,
                    &repo_dir,
                    Path::new(&path),
                    media::MediaKind::Photo,
                    None,
                    None,
                )
                .await
                .map_err(to_err)
            }
        }))
        .buffer_unordered(concurrency)
        .collect()
        .await;

    let mut out = Vec::with_capacity(results.len());
    for r in results {
        out.push(r?);
    }
    Ok(out)
}

#[tauri::command]
pub async fn website_reorder_gallery(
    app: AppHandle,
    db: State<'_, DbGate>,
    ordered_media_ids: Vec<i64>,
) -> Result<(), String> {
    require_enabled()?;
    let wc = ensure_working_copy(&app)?;
    media::reorder_gallery(db.inner(), &wc.repo_dir, ordered_media_ids)
        .await
        .map_err(to_err)
}

#[tauri::command]
pub async fn website_edit_media(
    app: AppHandle,
    db: State<'_, DbGate>,
    media_id: i64,
    caption: Option<String>,
    alt: Option<String>,
    focal: Option<(f32, f32)>,
) -> Result<media::MediaRecord, String> {
    require_enabled()?;
    let wc = ensure_working_copy(&app)?;
    media::set_photo_meta(db.inner(), &wc.repo_dir, media_id, caption, alt, focal)
        .await
        .map_err(to_err)
}

#[tauri::command]
pub async fn website_delete_media(
    app: AppHandle,
    db: State<'_, DbGate>,
    media_id: i64,
) -> Result<(), String> {
    require_enabled()?;
    let wc = ensure_working_copy(&app)?;
    media::soft_delete(db.inner(), &wc.repo_dir, media_id)
        .await
        .map_err(to_err)
}

#[tauri::command]
pub async fn website_bulk_delete_media(
    app: AppHandle,
    db: State<'_, DbGate>,
    media_ids: Vec<i64>,
) -> Result<usize, String> {
    require_enabled()?;
    let wc = ensure_working_copy(&app)?;
    media::bulk_soft_delete(db.inner(), &wc.repo_dir, media_ids)
        .await
        .map_err(to_err)
}

#[tauri::command]
pub async fn website_emergency_remove(
    app: AppHandle,
    db: State<'_, DbGate>,
    media_id: i64,
    reason: String,
) -> Result<(), String> {
    require_enabled()?;
    let wc = ensure_working_copy(&app)?;
    // We don't have a signed-in user in the CMS module; use a
    // constant identifier so audit rows stay attributable to the
    // desktop client.
    let requested_by = "cms-desktop@echelondaycare.local".to_string();
    media::emergency_remove(db.inner(), &wc.repo_dir, media_id, reason, requested_by)
        .await
        .map_err(to_err)
}

#[tauri::command]
pub async fn website_replace_logo(
    app: AppHandle,
    db: State<'_, DbGate>,
    source_path: String,
) -> Result<media::MediaRecord, String> {
    require_enabled()?;
    let wc = ensure_working_copy(&app)?;
    media::replace_logo(db.inner(), &wc.repo_dir, Path::new(&source_path))
        .await
        .map_err(to_err)
}

#[tauri::command]
pub async fn website_replace_favicon(
    app: AppHandle,
    db: State<'_, DbGate>,
    source_path: String,
) -> Result<media::MediaRecord, String> {
    require_enabled()?;
    let wc = ensure_working_copy(&app)?;
    media::replace_favicon(db.inner(), &wc.repo_dir, Path::new(&source_path))
        .await
        .map_err(to_err)
}

#[tauri::command]
pub async fn website_replace_og_image(
    app: AppHandle,
    db: State<'_, DbGate>,
    source_path: String,
) -> Result<media::MediaRecord, String> {
    require_enabled()?;
    let wc = ensure_working_copy(&app)?;
    media::replace_og_image(db.inner(), &wc.repo_dir, Path::new(&source_path))
        .await
        .map_err(to_err)
}
