//! Gallery Videos backend (v3.23.0).
//!
//! Mirrors [`crate::website::tour`] but writes to
//! `content/gallery-videos.json` and drafts under the `gallery-videos`
//! revision key. Every mutation goes through the same 3-tier transcode
//! ladder, AOAI title/description polish, and draft-first storage as
//! Tour Videos — see the sibling module for full docs.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::db_gate::DbGate;
use crate::website::commands::require_enabled;
use crate::website::git_ops::WorkingCopy;
use crate::website::revisions;
use crate::website::tour::{
    ai_polish_video_meta_ctx, extract_poster, next_id, safe_stem, transcode_video, unique_stem,
    TourVideo,
};

const CONTENT_FILE: &str = "gallery-videos";

fn working_copy_from_app(app: &AppHandle) -> Result<WorkingCopy, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("website");
    Ok(WorkingCopy {
        root: root.clone(),
        repo_dir: root.join("repo"),
        render_dir: root.join("render"),
    })
}

fn content_path(repo_dir: &Path) -> PathBuf {
    repo_dir
        .join("content")
        .join(format!("{CONTENT_FILE}.json"))
}

fn read_disk(repo_dir: &Path) -> Result<Value, String> {
    let path = content_path(repo_dir);
    if !path.exists() {
        // First-run seed: empty playlist.
        return Ok(json!({
            "schema_version": 1,
            "heading": "Videos",
            "intro": "",
            "videos": []
        }));
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_json::from_str::<Value>(&raw).map_err(|e| format!("parse {CONTENT_FILE}.json: {e}"))
}

async fn load_current(gate: &DbGate, repo_dir: &Path) -> Result<Value, String> {
    let draft = revisions::load_draft(gate, CONTENT_FILE)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(json) = draft {
        return serde_json::from_str::<Value>(&json)
            .map_err(|e| format!("parse {CONTENT_FILE} draft: {e}"));
    }
    read_disk(repo_dir)
}

fn ensure_shape(mut v: Value) -> Value {
    let obj = v.as_object_mut().expect("root must be object");
    if !obj.get("videos").map(|x| x.is_array()).unwrap_or(false) {
        obj.insert("videos".into(), Value::Array(vec![]));
    }
    if !obj.get("heading").map(|x| x.is_string()).unwrap_or(false) {
        obj.insert("heading".into(), json!("Videos"));
    }
    obj.insert("schema_version".into(), json!(1));
    v
}

#[derive(Debug, Serialize)]
pub struct AddVideosResponse {
    pub added: Vec<TourVideo>,
    pub revision_id: i64,
}

#[derive(Debug, Deserialize)]
pub struct AddVideosRequest {
    pub paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct DeleteVideoRequest {
    pub id: String,
}

#[derive(Debug, Deserialize)]
pub struct ReorderVideosRequest {
    pub ids: Vec<String>,
}

#[tauri::command]
pub async fn website_gallery_videos_list(
    app: AppHandle,
    db: State<'_, DbGate>,
) -> Result<Vec<TourVideo>, String> {
    require_enabled()?;
    let wc = working_copy_from_app(&app)?;
    let v = ensure_shape(load_current(db.inner(), &wc.repo_dir).await?);
    let arr = v
        .get("videos")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for item in arr {
        match serde_json::from_value::<TourVideo>(item.clone()) {
            Ok(tv) => out.push(tv),
            Err(e) => return Err(format!("videos entry invalid: {e}")),
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn website_gallery_videos_add(
    app: AppHandle,
    db: State<'_, DbGate>,
    request: AddVideosRequest,
) -> Result<AddVideosResponse, String> {
    require_enabled()?;
    if request.paths.is_empty() {
        return Err("Choose one or more video files first.".into());
    }
    let wc = working_copy_from_app(&app)?;
    let ffmpeg = crate::graduation::commands::sidecar_binary_path(&app)?;
    // Namespaced folder so tour + gallery videos don't collide on stems.
    let assets_video = wc.repo_dir.join("assets").join("video").join("gallery");
    std::fs::create_dir_all(&assets_video)
        .map_err(|e| format!("mkdir assets/video/gallery: {e}"))?;

    let mut root = ensure_shape(load_current(db.inner(), &wc.repo_dir).await?);
    let mut current: Vec<TourVideo> = serde_json::from_value(
        root.get("videos").cloned().unwrap_or_else(|| json!([])),
    )
    .map_err(|e| format!("read current videos: {e}"))?;

    let mut added = Vec::<TourVideo>::new();
    for src_path in &request.paths {
        let src = PathBuf::from(src_path);
        if !src.is_file() {
            return Err(format!("Not a file: {}", src.display()));
        }
        let orig_name = src
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("video.mp4")
            .to_string();
        let base = safe_stem(&orig_name);
        let stem = unique_stem(&assets_video, &base);

        let video_rel = format!("assets/video/gallery/{stem}.mp4");
        let poster_rel = format!("assets/video/gallery/{stem}-poster.jpg");
        let video_dst = wc.repo_dir.join(&video_rel);
        let poster_dst = wc.repo_dir.join(&poster_rel);

        std::fs::create_dir_all(video_dst.parent().unwrap()).ok();
        transcode_video(&ffmpeg, &src, &video_dst)
            .map_err(|e| format!("transcode {} → {}: {e}", src.display(), video_dst.display()))?;

        if let Err(e) = extract_poster(&ffmpeg, &video_dst, &poster_dst) {
            let _ = std::fs::write(
                poster_dst.with_extension("txt"),
                format!("ffmpeg poster extraction skipped: {e}"),
            );
        }

        let id = next_id(&current);
        let title_stem = Path::new(&orig_name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Untitled")
            .to_string();
        let (title, description) = match ai_polish_video_meta_ctx(&orig_name, "Gallery").await {
            Some((t, d)) => (t, d),
            None => (title_stem, String::new()),
        };
        let entry = TourVideo {
            id: id.clone(),
            title,
            description,
            src: video_rel,
            poster: if poster_dst.exists() {
                poster_rel
            } else {
                "assets/img/og-image.png".into()
            },
        };
        current.push(entry.clone());
        added.push(entry);
    }

    root.as_object_mut()
        .unwrap()
        .insert("videos".into(), serde_json::to_value(&current).unwrap());
    let pretty = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("serialize {CONTENT_FILE}.json: {e}"))?
        + "\n";
    let rev = revisions::save_draft(db.inner(), CONTENT_FILE, &pretty, None, None)
        .await
        .map_err(|e| e.to_string())?;
    Ok(AddVideosResponse {
        added,
        revision_id: rev,
    })
}

#[tauri::command]
pub async fn website_gallery_videos_delete(
    app: AppHandle,
    db: State<'_, DbGate>,
    request: DeleteVideoRequest,
) -> Result<i64, String> {
    require_enabled()?;
    let wc = working_copy_from_app(&app)?;
    let mut root = ensure_shape(load_current(db.inner(), &wc.repo_dir).await?);
    let mut current: Vec<TourVideo> = serde_json::from_value(
        root.get("videos").cloned().unwrap_or_else(|| json!([])),
    )
    .map_err(|e| format!("read current videos: {e}"))?;

    let before = current.len();
    let removed: Vec<TourVideo> = current
        .iter()
        .filter(|v| v.id == request.id)
        .cloned()
        .collect();
    current.retain(|v| v.id != request.id);
    if current.len() == before {
        return Err(format!("no video with id={}", request.id));
    }
    for r in &removed {
        let still_used = current
            .iter()
            .any(|c| c.src == r.src || c.poster == r.poster);
        if !still_used {
            crate::website::tour::safe_delete_under_repo(&wc.repo_dir, &r.src, "assets/video/");
            crate::website::tour::safe_delete_under_repo(&wc.repo_dir, &r.poster, "assets/video/");
        }
    }

    root.as_object_mut()
        .unwrap()
        .insert("videos".into(), serde_json::to_value(&current).unwrap());
    let pretty = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("serialize {CONTENT_FILE}.json: {e}"))?
        + "\n";
    let rev = revisions::save_draft(db.inner(), CONTENT_FILE, &pretty, None, None)
        .await
        .map_err(|e| e.to_string())?;
    Ok(rev)
}

#[tauri::command]
pub async fn website_gallery_videos_reorder(
    app: AppHandle,
    db: State<'_, DbGate>,
    request: ReorderVideosRequest,
) -> Result<i64, String> {
    require_enabled()?;
    let wc = working_copy_from_app(&app)?;
    let mut root = ensure_shape(load_current(db.inner(), &wc.repo_dir).await?);
    let current: Vec<TourVideo> = serde_json::from_value(
        root.get("videos").cloned().unwrap_or_else(|| json!([])),
    )
    .map_err(|e| format!("read current videos: {e}"))?;
    let by_id: std::collections::HashMap<String, TourVideo> =
        current.iter().map(|v| (v.id.clone(), v.clone())).collect();
    let mut reordered = Vec::<TourVideo>::new();
    for id in &request.ids {
        if let Some(v) = by_id.get(id) {
            reordered.push(v.clone());
        }
    }
    for v in &current {
        if !request.ids.contains(&v.id) {
            reordered.push(v.clone());
        }
    }
    root.as_object_mut()
        .unwrap()
        .insert("videos".into(), serde_json::to_value(&reordered).unwrap());
    let pretty = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("serialize {CONTENT_FILE}.json: {e}"))?
        + "\n";
    let rev = revisions::save_draft(db.inner(), CONTENT_FILE, &pretty, None, None)
        .await
        .map_err(|e| e.to_string())?;
    Ok(rev)
}
