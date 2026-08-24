//! Tour videos backend (v3.22.0).
//!
//! - `website_tour_list_videos` — read videos array from `content/tour.json`.
//! - `website_tour_add_videos` — copy user files into `<repo>/assets/video/`,
//!    extract first-frame poster via ffmpeg sidecar, append to tour.json.
//! - `website_tour_delete_video` — remove entry + files, rewrite tour.json.
//! - `website_tour_reorder_videos` — rewrite ordering.
//!
//! Draft-safe: every mutation is committed as a `site_revisions` draft
//! for `tour` via `revisions::save_draft`, matching Careers/Home. The
//! actual media files are copied into the working-copy repo assets/;
//! publish handles committing them via `stage_rendered_html_and_assets`
//! which already recurses `assets/**`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::db_gate::DbGate;
use crate::website::commands::require_enabled;
use crate::website::git_ops::WorkingCopy;
use crate::website::revisions;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TourVideo {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub src: String,
    pub poster: String,
}

#[derive(Debug, Serialize)]
pub struct AddVideosResponse {
    pub added: Vec<TourVideo>,
    pub revision_id: i64,
}

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

fn tour_json_path(repo_dir: &Path) -> PathBuf {
    repo_dir.join("content").join("tour.json")
}

fn read_tour_content(repo_dir: &Path) -> Result<Value, String> {
    let path = tour_json_path(repo_dir);
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_json::from_str::<Value>(&raw).map_err(|e| format!("parse tour.json: {e}"))
}

/// Prefer the DB draft (matches `website_load_content`); fall back to
/// the on-disk working copy when no draft exists yet.
async fn load_current_tour(gate: &DbGate, repo_dir: &Path) -> Result<Value, String> {
    let draft = revisions::load_draft(gate, "tour")
        .await
        .map_err(|e| e.to_string())?;
    if let Some(json) = draft {
        return serde_json::from_str::<Value>(&json)
            .map_err(|e| format!("parse tour draft: {e}"));
    }
    read_tour_content(repo_dir)
}

/// Given a tour.json Value, always return a v2-shaped object with `videos: []`.
/// v1 (single video_src/video_poster) migrates on read.
fn ensure_v2(mut v: Value) -> Value {
    // Defensive: if tour.json ever ships a non-object root (malformed
    // hand-edit, mistaken array push), yield an empty v2 object rather
    // than panicking the whole command chain — a bad JSON should
    // surface as an editor validation error, not a Tauri crash.
    let Some(obj) = v.as_object_mut() else {
        return serde_json::json!({ "schema_version": 2, "videos": [] });
    };
    let has_videos = obj
        .get("videos")
        .map(|x| x.is_array())
        .unwrap_or(false);
    if !has_videos {
        let mut videos = Vec::<Value>::new();
        if let (Some(src), Some(poster)) = (
            obj.get("video_src").and_then(|x| x.as_str()).map(String::from),
            obj.get("video_poster").and_then(|x| x.as_str()).map(String::from),
        ) {
            let heading = obj
                .get("heading")
                .and_then(|x| x.as_str())
                .unwrap_or("Virtual Tour")
                .to_string();
            videos.push(json!({
                "id": "V001",
                "title": heading,
                "description": "",
                "src": src,
                "poster": poster,
            }));
        }
        obj.insert("videos".into(), Value::Array(videos));
    }
    obj.insert("schema_version".into(), json!(2));
    v
}

#[tauri::command]
pub async fn website_tour_list_videos(
    app: AppHandle,
    db: State<'_, DbGate>,
) -> Result<Vec<TourVideo>, String> {
    require_enabled()?;
    let wc = working_copy_from_app(&app)?;
    let v = ensure_v2(load_current_tour(db.inner(), &wc.repo_dir).await?);
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

#[derive(Debug, Deserialize)]
pub struct AddVideosRequest {
    pub paths: Vec<String>,
}

/// Sanitise a user-supplied filename into an assets/video/-safe stem.
pub(crate) fn safe_stem(name: &str) -> String {
    let stem = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video")
        .to_lowercase();
    let mut out = String::with_capacity(stem.len());
    let mut last_dash = false;
    for ch in stem.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() { "video".into() } else { out }
}

pub(crate) fn unique_stem(assets_video: &Path, base: &str) -> String {
    let mut candidate = base.to_string();
    let mut n = 2;
    while assets_video.join(format!("{candidate}.mp4")).exists()
        || assets_video.join(format!("{candidate}-poster.jpg")).exists()
    {
        candidate = format!("{base}-{n}");
        n += 1;
        if n > 999 { break; }
    }
    candidate
}

pub(crate) fn next_id(existing: &[TourVideo]) -> String {
    let mut n = 1i64;
    let taken: std::collections::HashSet<String> =
        existing.iter().map(|v| v.id.clone()).collect();
    loop {
        let id = format!("V{n:03}");
        if !taken.contains(&id) {
            return id;
        }
        n += 1;
    }
}

/// Transcode a source video into `dst` as H.264 720p + AAC 128k using the
/// bundled ffmpeg's `libopenh264` encoder (the sidecar isn't built with
/// libx264). Keeps files well under GitHub's 100 MB push limit while
/// preserving playback quality. Two-tier bitrate ladder if the first pass
/// still yields > 90 MB.
pub(crate) const GITHUB_MAX_MB: u64 = 90;

/// Best-effort delete of a repo-relative path, guarded against path
/// traversal and absolute paths in the source JSON. The relative path
/// must (a) not be empty, (b) not contain any `..` component, (c) not
/// be absolute, (d) start with `expected_prefix` (repo-relative), and
/// (e) resolve to a target inside `repo_dir` after canonicalization.
/// Silently no-ops otherwise — the caller has no useful UI recovery.
pub(crate) fn safe_delete_under_repo(repo_dir: &Path, rel: &str, expected_prefix: &str) {
    if rel.is_empty() {
        return;
    }
    if !rel.replace('\\', "/").starts_with(expected_prefix) {
        return;
    }
    let candidate = PathBuf::from(rel);
    if candidate.is_absolute() {
        return;
    }
    if candidate
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return;
    }
    let full = repo_dir.join(&candidate);
    // Only canonicalize the parent (target may not exist for reasons
    // other than being outside the repo) and require it under repo_dir.
    let Some(parent) = full.parent() else { return };
    let (Ok(rd_canon), Ok(par_canon)) = (repo_dir.canonicalize(), parent.canonicalize()) else {
        return;
    };
    if !par_canon.starts_with(&rd_canon) {
        return;
    }
    let _ = std::fs::remove_file(&full);
}

pub(crate) fn transcode_video(ffmpeg: &Path, src: &Path, dst: &Path) -> Result<(), String> {
    // Pick the encoder available on this OS. macOS ships with
    // h264_videotoolbox; Windows with h264_mf; Linux/other rely on
    // the bundled libopenh264. Using libopenh264 unconditionally
    // failed on macOS with "Unknown encoder 'libopenh264'".
    let encoder = crate::graduation::engine::HwEncoder::for_current_os().ffmpeg_codec_name();
    // (video_bitrate, max_height)
    let attempts: &[(&str, &str)] = &[
        ("1500k", "720"),
        ("1000k", "720"),
        ("700k", "540"),
    ];
    for (vbit, height) in attempts {
        let vf = format!(
            "scale='min(1280,iw)':'min({height},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2"
        );
        let out = std::process::Command::new(ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel", "error",
                "-y",
                "-i",
            ])
            .arg(src)
            .args([
                "-vf", vf.as_str(),
                "-c:v", encoder,
                "-b:v", vbit,
                "-pix_fmt", "yuv420p",
                "-movflags", "+faststart",
                "-c:a", "aac",
                "-b:a", "128k",
                "-ac", "2",
            ])
            .arg(dst)
            .output()
            .map_err(|e| format!("spawn ffmpeg (transcode): {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "ffmpeg transcode failed: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        if let Ok(meta) = std::fs::metadata(dst) {
            if meta.len() <= GITHUB_MAX_MB * 1024 * 1024 {
                return Ok(());
            }
        }
    }
    // All bitrate attempts still produced a file larger than GitHub's
    // push cap. Fail loudly so the owner can trim the video before
    // publish — otherwise `git push` would reject the whole commit and
    // the failure would only surface at publish time.
    let size_mb = std::fs::metadata(dst).map(|m| m.len() / 1024 / 1024).unwrap_or(0);
    Err(format!(
        "transcoded video is still {size_mb} MB (max {GITHUB_MAX_MB} MB) after 3 bitrate reductions — trim the source video or reduce its resolution"
    ))
}

pub(crate) fn extract_poster(
    ffmpeg: &Path,
    video_path: &Path,
    poster_path: &Path,
) -> Result<(), String> {
    // Grab a frame ~1 second in (avoids black lead-in), scaled to a
    // reasonable poster size, high quality JPEG.
    let out = std::process::Command::new(ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel", "error",
            "-y",
            "-ss", "00:00:01.000",
            "-i",
        ])
        .arg(video_path)
        .args([
            "-frames:v", "1",
            "-vf", "scale='min(1280,iw)':-2",
            "-q:v", "3",
        ])
        .arg(poster_path)
        .output()
        .map_err(|e| format!("spawn ffmpeg: {e}"))?;
    if !out.status.success() {
        // Retry from time 0 (video shorter than 1s or seek failed).
        let out2 = std::process::Command::new(ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel", "error",
                "-y",
                "-i",
            ])
            .arg(video_path)
            .args([
                "-frames:v", "1",
                "-vf", "scale='min(1280,iw)':-2",
                "-q:v", "3",
            ])
            .arg(poster_path)
            .output()
            .map_err(|e| format!("spawn ffmpeg (retry): {e}"))?;
        if !out2.status.success() {
            return Err(format!(
                "ffmpeg poster extraction failed: {}",
                String::from_utf8_lossy(&out2.stderr)
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn website_tour_add_videos(
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
    let assets_video = wc.repo_dir.join("assets").join("video");
    std::fs::create_dir_all(&assets_video)
        .map_err(|e| format!("mkdir assets/video: {e}"))?;

    let mut tour_val = ensure_v2(load_current_tour(db.inner(), &wc.repo_dir).await?);
    let mut current: Vec<TourVideo> = serde_json::from_value(
        tour_val
            .get("videos")
            .cloned()
            .unwrap_or_else(|| json!([])),
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

        let video_rel = format!("assets/video/{stem}.mp4");
        let poster_rel = format!("assets/video/{stem}-poster.jpg");
        let video_dst = wc.repo_dir.join(&video_rel);
        let poster_dst = wc.repo_dir.join(&poster_rel);

        std::fs::create_dir_all(video_dst.parent().unwrap()).ok();
        // ffmpeg is CPU + IO bound and can take tens of seconds per
        // clip — offload onto the blocking pool so we don't stall
        // Tauri's async runtime (progress events, other commands).
        let ffmpeg_c = ffmpeg.clone();
        let src_c = src.clone();
        let video_dst_c = video_dst.clone();
        let poster_dst_c = poster_dst.clone();
        tokio::task::spawn_blocking(move || {
            transcode_video(&ffmpeg_c, &src_c, &video_dst_c).map_err(|e| {
                format!(
                    "transcode {} → {}: {e}",
                    src_c.display(),
                    video_dst_c.display()
                )
            })?;
            if let Err(e) = extract_poster(&ffmpeg_c, &video_dst_c, &poster_dst_c) {
                let _ = std::fs::write(
                    poster_dst_c.with_extension("txt"),
                    format!("ffmpeg poster extraction skipped: {e}"),
                );
            }
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| format!("transcode join: {e}"))??;

        let id = next_id(&current);
        let title_stem = Path::new(&orig_name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Untitled")
            .to_string();
        let (title, description) = match ai_polish_video_meta(&orig_name).await {
            Some((t, d)) => (t, d),
            None => (title_stem, String::new()),
        };
        let entry = TourVideo {
            id: id.clone(),
            title,
            description,
            src: video_rel,
            poster: if poster_dst.exists() { poster_rel } else { "assets/img/og-image.png".into() },
        };
        current.push(entry.clone());
        added.push(entry);
    }

    tour_val
        .as_object_mut()
        .unwrap()
        .insert("videos".into(), serde_json::to_value(&current).unwrap());
    let pretty = serde_json::to_string_pretty(&tour_val)
        .map_err(|e| format!("serialize tour.json: {e}"))?
        + "\n";

    let rev = revisions::save_draft(db.inner(), "tour", &pretty, None, None)
        .await
        .map_err(|e| e.to_string())?;

    Ok(AddVideosResponse {
        added,
        revision_id: rev,
    })
}

#[derive(Debug, Deserialize)]
pub struct DeleteVideoRequest {
    pub id: String,
}

#[tauri::command]
pub async fn website_tour_delete_video(
    app: AppHandle,
    db: State<'_, DbGate>,
    request: DeleteVideoRequest,
) -> Result<i64, String> {
    require_enabled()?;
    let wc = working_copy_from_app(&app)?;
    let mut tour_val = ensure_v2(load_current_tour(db.inner(), &wc.repo_dir).await?);
    let mut current: Vec<TourVideo> = serde_json::from_value(
        tour_val
            .get("videos")
            .cloned()
            .unwrap_or_else(|| json!([])),
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

    // Save the draft FIRST so a save failure doesn't leave orphan JSON
    // pointers to files we already unlinked. Only after the DB commits
    // do we touch the working-copy files. Guard against path traversal
    // / absolute paths in the JSON — src/poster are meant to be
    // repo-relative under assets/video/, but a hand-edited tour.json
    // could point anywhere.
    tour_val
        .as_object_mut()
        .unwrap()
        .insert("videos".into(), serde_json::to_value(&current).unwrap());
    let pretty = serde_json::to_string_pretty(&tour_val)
        .map_err(|e| format!("serialize tour.json: {e}"))?
        + "\n";
    let rev = revisions::save_draft(db.inner(), "tour", &pretty, None, None)
        .await
        .map_err(|e| e.to_string())?;

    for r in &removed {
        let still_used = current.iter().any(|c| c.src == r.src || c.poster == r.poster);
        if !still_used {
            safe_delete_under_repo(&wc.repo_dir, &r.src, "assets/video/");
            safe_delete_under_repo(&wc.repo_dir, &r.poster, "assets/video/");
        }
    }
    Ok(rev)
}

#[derive(Debug, Deserialize)]
pub struct ReorderVideosRequest {
    pub ids: Vec<String>,
}

#[tauri::command]
pub async fn website_tour_reorder_videos(
    app: AppHandle,
    db: State<'_, DbGate>,
    request: ReorderVideosRequest,
) -> Result<i64, String> {
    require_enabled()?;
    let wc = working_copy_from_app(&app)?;
    let mut tour_val = ensure_v2(load_current_tour(db.inner(), &wc.repo_dir).await?);
    let current: Vec<TourVideo> = serde_json::from_value(
        tour_val
            .get("videos")
            .cloned()
            .unwrap_or_else(|| json!([])),
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
    // Append any that weren't in the request (defensive).
    for v in &current {
        if !request.ids.contains(&v.id) {
            reordered.push(v.clone());
        }
    }
    tour_val
        .as_object_mut()
        .unwrap()
        .insert("videos".into(), serde_json::to_value(&reordered).unwrap());
    let pretty = serde_json::to_string_pretty(&tour_val)
        .map_err(|e| format!("serialize tour.json: {e}"))?
        + "\n";
    let rev = revisions::save_draft(db.inner(), "tour", &pretty, None, None)
        .await
        .map_err(|e| e.to_string())?;
    Ok(rev)
}

/// Ask AOAI to produce a friendly title (2-6 words, title case) and a
/// one-sentence description from a raw filename. Never blocks the
/// upload: any error, timeout, or malformed response returns `None`
/// and the caller falls back to a stem-derived title.
pub(crate) async fn ai_polish_video_meta(orig_name: &str) -> Option<(String, String)> {
    ai_polish_video_meta_ctx(orig_name, "Virtual Tour").await
}

/// Like [`ai_polish_video_meta`] but with an explicit context label
/// (e.g. `"Virtual Tour"`, `"Gallery"`) so the prompt matches the page
/// the caller is populating.
pub(crate) async fn ai_polish_video_meta_ctx(orig_name: &str, context_label: &str) -> Option<(String, String)> {
    let key = crate::secrets::get_secret("azure_ai_key").ok()?;
    let url = format!(
        "https://ai-nse.openai.azure.com/openai/deployments/gpt-5.4/chat/completions?api-version=2025-04-01-preview"
    );
    let sys = format!("You clean up raw video filenames for a daycare's public '{context_label}' website. \
        Return a short human-friendly title (2-6 words, Title Case, no filler like 'video' or 'demo') \
        and a warm one-sentence description (max 20 words) suitable as caption text. \
        Never invent facts; if the filename is opaque, describe generically.");
    let user = format!("Filename: {orig_name}\nReturn JSON with fields `title` and `description`.");
    let schema = json!({
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "description": {"type": "string"}
        },
        "required": ["title", "description"],
        "additionalProperties": false
    });
    let body = json!({
        "messages": [
            {"role": "system", "content": sys},
            {"role": "user", "content": user},
        ],
        "max_completion_tokens": 400,
        "reasoning_effort": "low",
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "VideoMeta", "schema": schema, "strict": true}
        }
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .ok()?;
    let resp = client
        .post(&url)
        .header("api-key", &key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let v: Value = resp.json().await.ok()?;
    let msg = v["choices"][0]["message"]["content"].as_str()?;
    let parsed: Value = serde_json::from_str(msg).ok()?;
    let title = parsed["title"].as_str()?.trim().to_string();
    let desc = parsed["description"].as_str()?.trim().to_string();
    if title.is_empty() { None } else { Some((title, desc)) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_stem_normalises_unicode_and_spaces() {
        assert_eq!(safe_stem("My Cool Tour.mp4"), "my-cool-tour");
        assert_eq!(safe_stem("kids' rooms - final v2.mov"), "kids-rooms-final-v2");
        assert_eq!(safe_stem("...."), "video");
    }

    #[test]
    fn ensure_v2_migrates_v1() {
        let v1 = json!({
            "schema_version": 1,
            "heading": "Virtual Tour",
            "video_src": "assets/video/tour.mp4",
            "video_poster": "assets/video/tour-poster.jpg"
        });
        let v = ensure_v2(v1);
        assert_eq!(v["schema_version"], 2);
        let vids = v["videos"].as_array().unwrap();
        assert_eq!(vids.len(), 1);
        assert_eq!(vids[0]["src"], "assets/video/tour.mp4");
        assert_eq!(vids[0]["title"], "Virtual Tour");
    }

    #[test]
    fn next_id_skips_taken() {
        let taken = vec![
            TourVideo { id: "V001".into(), title: "".into(), description: "".into(), src: "".into(), poster: "".into() },
            TourVideo { id: "V002".into(), title: "".into(), description: "".into(), src: "".into(), poster: "".into() },
        ];
        assert_eq!(next_id(&taken), "V003");
    }
}
