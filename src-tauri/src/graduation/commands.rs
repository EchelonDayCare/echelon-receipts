//! Tauri commands exposed to the frontend for the Graduation Day feature.
//!
//! Boundaries:
//! - Commands MUST validate every user-supplied path via
//!   `paths::validate_folder` / `validate_writable_dir` / `validate_file`.
//!   These reject symlinks, resolve traversal, and require the path to
//!   canonicalise cleanly.
//! - Every command that spawns FFmpeg emits a `graduation://progress`
//!   Tauri event on the main window so the UI can render a real
//!   progress bar.
//! - Renders are cancellable: cancel closes the FFmpeg child, which
//!   FFmpeg treats as SIGINT / TerminateProcess. Cancel also clears
//!   the state slot before the frontend batch loop advances so the
//!   next iteration's spawn doesn't race.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

use crate::graduation::{curate, engine, paths, pptx, preflight, progress};
use crate::db_gate::DbGate;

/// Total reel duration accounting for xfade overlaps.
/// N*D - (N-1)*X, floored at 4.0 so audio fade math (dur-3) stays positive.
fn spec_total_duration(n: usize, photo_sec: f64, xfade_sec: f64) -> f64 {
    let n = n as f64;
    let raw = (n * photo_sec - (n - 1.0).max(0.0) * xfade_sec).max(0.0);
    raw.max(4.0)
}

/// Reject any `job_id` that isn't `[A-Za-z0-9_-]{1,64}`. F6: the raw
/// job_id is spliced into cache paths (`reel-{job_id}-filter.script`,
/// `child-{job_id}-aliases`), so a hostile frontend value like
/// `../../../etc` would let a render write outside the cache dir. This
/// pins it to the character class the frontend uses (`crypto.randomUUID()`
/// stripped of dashes, timestamps) and length-caps to prevent DoS via
/// pathological filenames.
fn sanitize_job_id(raw: &str) -> Result<String, String> {
    if raw.is_empty() {
        return Err("job_id must not be empty".to_string());
    }
    if raw.len() > 64 {
        return Err("job_id too long (max 64 chars)".to_string());
    }
    if !raw
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(
            "job_id must contain only ASCII letters, digits, '_' or '-'".to_string(),
        );
    }
    Ok(raw.to_string())
}

/// Hard-link (or copy on cross-volume failure) each source photo to
/// a short deterministic alias `p0001.jpg` … `pNNNN.jpg` in a scratch
/// dir. Returns just the alias **filenames** (no path prefix) in the
/// same order as `sources`.
///
/// Rationale (F4 + review-agent #2): Windows `CreateProcess` caps the
/// command line at 32 767 chars. With 150+ photos and typical
/// OneDrive/Documents paths (~130 chars each), the raw `-i <abs-path>`
/// arg list can blow past that limit and FFmpeg fails to launch with a
/// cryptic error. Even shortening filenames alone isn't enough — the
/// scratch dir sits under the user's cache root, so full alias paths
/// still run ~150 chars. Returning bare filenames and setting the
/// spawned FFmpeg command's `current_dir` to the scratch dir keeps
/// each `-i` arg at ~12 bytes.
///
/// The `@filelist` approach was investigated first and abandoned —
/// bundled FFmpeg parses `@arg` as an *output format specifier*, not
/// a filelist reference, so `-i @list.txt` yields
/// "Unable to choose an output format for '@…'".
fn alias_photos(sources: &[PathBuf], scratch_dir: &Path) -> Result<Vec<PathBuf>, String> {
    std::fs::create_dir_all(scratch_dir)
        .map_err(|e| format!("mkdir alias scratch: {e}"))?;
    let mut aliases: Vec<PathBuf> = Vec::with_capacity(sources.len());
    for (i, src) in sources.iter().enumerate() {
        let ext = src
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("jpg")
            .to_ascii_lowercase();
        let name = format!("p{:04}.{ext}", i + 1);
        let alias_full = scratch_dir.join(&name);
        let _ = std::fs::remove_file(&alias_full);
        match std::fs::hard_link(src, &alias_full) {
            Ok(()) => {}
            Err(_) => {
                std::fs::copy(src, &alias_full).map_err(|e| {
                    format!("alias copy {} → {}: {e}", src.display(), alias_full.display())
                })?;
            }
        }
        aliases.push(PathBuf::from(name));
    }
    Ok(aliases)
}

/// Best-effort audit write into `graduation_renders` so Ask Echelon can
/// answer render-history questions. Failures are logged and swallowed —
/// the render itself already succeeded and we don't want a DB hiccup
/// to surface as a user-facing error.
async fn record_render(
    db_gate: &DbGate,
    kind: &'static str,
    year: i64,
    student_id: Option<i64>,
    output_path: &str,
    duration_ms: Option<i64>,
    frames_encoded: Option<i64>,
    slides_written: Option<i64>,
) {
    let output_path = output_path.to_string();
    let res = db_gate
        .with_conn(move |conn| {
            conn.execute(
                "INSERT INTO graduation_renders \
                 (kind, year, student_id, output_path, duration_ms, frames_encoded, slides_written) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    kind, year, student_id, output_path,
                    duration_ms, frames_encoded, slides_written,
                ],
            )?;
            Ok(())
        })
        .await;
    if let Err(e) = res {
        eprintln!("[graduation] failed to record render history: {e:?}");
    }
}

/// Session-level state that tracks the currently-running FFmpeg render
/// so the frontend can cancel it. `current_child` and `cancelled` live
/// under a single mutex so callers can never acquire them in
/// inconsistent order (F5). Every read/write of either field goes
/// through `state.inner.lock()`.
#[derive(Default)]
pub struct RenderState {
    pub inner: Mutex<RenderInner>,
    /// Lock-free cancel signal readable from worker threads (curate
    /// scan_and_rank, HEIC decode) without going through the mutex.
    /// F14: threads a cancel checkpoint into HEIC decode so cancelling
    /// during a 100+ HEIC batch takes effect within one photo instead
    /// of running to completion. Kept in sync with `RenderInner.cancelled`
    /// — every write to one must write the other under the mutex.
    pub cancel_flag: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct RenderInner {
    /// (invocation-id, child). Only the owning spawn_and_stream may
    /// clear this slot on Terminate/Error — matching by id prevents an
    /// earlier render's cleanup from wiping a newer render's handle
    /// after the older process was killed and replaced.
    pub current_child: Option<(u64, CommandChild)>,
    pub cancelled: bool,
    /// Monotonic invocation counter. Each spawn_and_stream call
    /// grabs the next id under the mutex.
    pub next_child_id: u64,
}

/// Payload emitted on the `graduation://progress` channel.
#[derive(Debug, Clone, Serialize)]
pub struct ProgressPayload {
    pub job_id: String,
    pub stage: String,
    pub tick: progress::ProgressTick,
}

/// Payload emitted on the `graduation://log` channel — captures FFmpeg
/// stderr lines so the UI can surface errors in real time.
#[derive(Debug, Clone, Serialize)]
pub struct LogPayload {
    pub job_id: String,
    pub level: String,
    pub message: String,
}

// ── Preflight ─────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct PreflightRequest {
    pub reel_folder: Option<String>,
    pub kids_folder: Option<String>,
    pub slides_folder: Option<String>,
    /// Where the render will write its outputs. This is the only folder
    /// where free-space actually matters (multi-GB reels + per-child
    /// videos land here). The input folders above are checked only for
    /// existence.
    pub output_folder: Option<String>,
    pub check_heic: bool,
}

#[tauri::command]
pub fn graduation_preflight(
    app: AppHandle,
    req: PreflightRequest,
) -> Result<preflight::PreflightReport, String> {
    let ffmpeg_path = sidecar_binary_path(&app)?;
    // Validate every user-supplied path against symlinks + traversal
    // before it reaches the check functions.
    let reel_folder = req.reel_folder.as_deref().map(paths::validate_folder).transpose()?;
    let kids_folder = req.kids_folder.as_deref().map(paths::validate_folder).transpose()?;
    let slides_folder = req.slides_folder.as_deref().map(paths::validate_folder).transpose()?;
    let output_folder = req.output_folder.as_deref().map(paths::validate_writable_dir).transpose()?;
    let inputs = preflight::PreflightInputs {
        ffmpeg_path: &ffmpeg_path,
        reel_folder,
        kids_folder,
        slides_folder,
        output_folder,
        any_heic: req.check_heic,
    };
    Ok(preflight::run_preflight(inputs))
}

// ── Scaffold ─────────────────────────────────────────────────────────

/// Creates the year's folder tree under the user's base folder so they
/// only ever have to pick ONE folder. Idempotent — safe to re-run to
/// add newly-added students.
#[derive(Debug, Deserialize)]
pub struct ScaffoldRequest {
    pub base_folder: String,
    pub year: u32,
    pub students: Vec<ScaffoldStudent>,
}

#[derive(Debug, Deserialize)]
pub struct ScaffoldStudent {
    pub id: i64,
    pub name: String,
}

#[tauri::command]
pub fn graduation_scaffold(
    req: ScaffoldRequest,
) -> Result<paths::GraduationLayout, String> {
    // Validate: reject symlinks + traversal on the user-picked base.
    let base = paths::validate_folder(&req.base_folder)?;
    let students: Vec<(i64, String)> = req
        .students
        .into_iter()
        .map(|s| (s.id, s.name))
        .collect();
    paths::scaffold_year(&base, req.year, &students)
}

// ── Photo curation ────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CurateRequest {
    pub folder: String,
    pub target_duration_sec: f64,
    pub avg_photo_sec: f64,
}

#[derive(Debug, Serialize)]
pub struct CurateResponse {
    pub selected: Vec<CuratedPhoto>,
    pub total_candidates: usize,
    pub heic_count: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct CuratedPhoto {
    pub source: String,
    pub decoded: String,
    pub sharpness: f64,
}

#[tauri::command]
pub async fn graduation_curate_photos(
    app: AppHandle,
    req: CurateRequest,
) -> Result<CurateResponse, String> {
    let folder = paths::validate_folder(&req.folder)?;
    let cache = paths::cache_dir(&app)?.join("heic");
    // Curate is CPU/IO heavy (Laplacian variance per photo + HEIC
    // decode). Offload to a blocking pool so the Tauri IPC thread
    // doesn't stall other commands (DB writes, auth timers, etc.).
    let scan = tokio::task::spawn_blocking(move || {
        curate::scan_and_rank(&folder, &cache)
    })
    .await
    .map_err(|e| format!("curate join: {e}"))?;
    let target_count = (req.target_duration_sec / req.avg_photo_sec.max(0.5)).ceil() as usize;
    let selected = curate::curate(&scan.photos, target_count.max(1));
    Ok(CurateResponse {
        total_candidates: scan.photos.len(),
        heic_count: scan.heic_count,
        errors: scan.errors,
        selected: selected
            .into_iter()
            .map(|p| CuratedPhoto {
                source: p.source.to_string_lossy().into_owned(),
                decoded: p.path.to_string_lossy().into_owned(),
                sharpness: p.sharpness,
            })
            .collect(),
    })
}

// ── Reel render ───────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct RenderReelRequest {
    pub source_folder: String,
    pub output_folder: String,
    pub music_track: Option<String>,
    /// If `music_track` is empty, auto-detect the first audio file in
    /// this folder. Used by the one-folder scaffold flow.
    pub music_folder: Option<String>,
    pub year: u32,
    pub duration_sec: f64,
    pub avg_photo_sec: f64,
    pub job_id: String,
}

#[derive(Debug, Serialize)]
pub struct RenderReelResponse {
    pub output_path: String,
    pub frames_encoded: u64,
    pub duration_ms: i64,
    /// Absolute path (or filename) of the music track actually used
    /// in the reel — surfaces the auto-picked random track so the
    /// user can see which one FFmpeg mixed (F11).
    pub music_used: Option<String>,
}

#[tauri::command]
pub async fn graduation_render_reel(
    app: AppHandle,
    state: State<'_, RenderState>,
    db_gate: State<'_, DbGate>,
    req: RenderReelRequest,
) -> Result<RenderReelResponse, String> {
    // F6: reject a hostile job_id before it lands in cache paths.
    let job_id = sanitize_job_id(&req.job_id)?;
    // Clear any stale cancel flag from a previous batch.
    reset_cancelled(&state);
    let cache_root = paths::cache_dir(&app)?;
    let heic_cache = cache_root.join("heic");
    // Best-effort cache GC — 30 days / 2 GiB. Never blocks the render.
    let _ = paths::gc_cache(&heic_cache, 30, 2 * 1024 * 1024 * 1024);
    let source = paths::validate_folder(&req.source_folder)?;
    let scan = {
        let src = source.clone();
        let cache = heic_cache.clone();
        let flag = Arc::clone(&state.cancel_flag);
        tokio::task::spawn_blocking(move || {
            curate::scan_and_rank_cancellable(&src, &cache, &|| flag.load(Ordering::Relaxed))
        })
            .await
            .map_err(|e| format!("curate join: {e}"))?
    };
    if is_cancelled(&state) {
        return Err("cancelled".into());
    }
    if scan.photos.is_empty() {
        return Err(format!(
            "No usable photos in {}. {} errors encountered.",
            req.source_folder,
            scan.errors.len()
        ));
    }
    // Warn (via log event, not error) if the user only supplied enough
    // photos for a much shorter reel than requested. FFmpeg will still
    // produce a valid file, but the user should know before waiting.
    let target_count = (req.duration_sec / req.avg_photo_sec.max(0.5)).ceil() as usize;
    if scan.photos.len() < target_count / 4 {
        let actual_sec = scan.photos.len() as f64 * req.avg_photo_sec;
        let _ = app.emit(
            "graduation://log",
            LogPayload {
                job_id: job_id.clone(),
                level: "warn".into(),
                message: format!(
                    "Only {} photos available; reel will be ~{actual_sec:.0}s not {}s. \
                     Add more photos to 1-Year-Reel-Photos/ for a longer reel.",
                    scan.photos.len(),
                    req.duration_sec as u64
                ),
            },
        );
    }
    let curated = curate::curate(&scan.photos, target_count.max(1));

    // Explicit music track — validate if supplied. Auto-detect
    // otherwise. Fail fast on a broken explicit path so FFmpeg doesn't
    // surface a mysterious "Invalid data found" mid-encode.
    let explicit_music: Option<PathBuf> = req
        .music_track
        .as_ref()
        .filter(|s| !s.is_empty())
        .map(|s| paths::validate_file(s))
        .transpose()?;
    // Precedence: explicit music_track → random pick from music_folder → bundled default.
    let auto_music: Option<PathBuf> = if explicit_music.is_none() {
        req.music_folder
            .as_ref()
            .filter(|s| !s.is_empty())
            .and_then(|f| paths::validate_folder(f).ok())
            .and_then(|f| {
                let picked = paths::pick_random_audio_in(&f);
                if let Some(ref p) = picked {
                    let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("?");
                    let list_len = paths::list_audio_in(&f).len();
                    let _ = app.emit(
                        "graduation://log",
                        LogPayload {
                            job_id: job_id.clone(),
                            level: "info".into(),
                            message: if list_len > 1 {
                                format!("Picked '{name}' at random from {list_len} tracks in music folder.")
                            } else {
                                format!("Using music track '{name}'.")
                            },
                        },
                    );
                }
                picked
            })
    } else {
        None
    };
    let music_track: Option<PathBuf> = explicit_music
        .or(auto_music)
        .or_else(|| paths::default_music_track(&app));

    let filter_script = cache_root.join(format!("reel-{}-filter.script", job_id));

    // Render to .tmp first so the final output only appears when the
    // encode completes cleanly.
    let out_dir = paths::validate_writable_dir(&req.output_folder)?;
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("mkdir output: {e}"))?;
    let final_path = out_dir.join(format!("Graduation-Year-Reel-{}.mp4", req.year));
    let tmp_path = out_dir.join(format!("Graduation-Year-Reel-{}.mp4.tmp", req.year));

    // v2.4.0: per-photo inputs + xfade transitions. Duration accounts
    // for transitions consuming overlap: N*D - (N-1)*X.
    let source_photos: Vec<PathBuf> = curated.iter().map(|p| p.path.clone()).collect();
    // F4: hard-link photos to short aliases before handing to FFmpeg
    // so `CreateProcess` argv stays under the Windows 32 KB cap even
    // for large batches (150+ photos with deep OneDrive paths).
    let alias_dir = cache_root.join(format!("reel-{}-aliases", job_id));
    let photos = alias_photos(&source_photos, &alias_dir)?;
    let spec = engine::default_reel_spec(
        photos,
        music_track,
        tmp_path.clone(),
        filter_script.clone(),
        req.avg_photo_sec,
        spec_total_duration(curated.len(), req.avg_photo_sec, 0.6),
    );
    let filter_text = engine::build_filter_script(&spec);
    std::fs::write(&filter_script, &filter_text)
        .map_err(|e| format!("write filter script: {e}"))?;
    let args = engine::build_reel_cmd(&spec);

    let outcome = match spawn_and_stream(&app, state, &job_id, "reel", args, Some(alias_dir.clone())).await {
        Ok(o) => o,
        Err(e) => {
            // Failed / cancelled renders leave a partial `.mp4.tmp`
            // that can be several hundred MB. Sweep it before returning
            // so the output folder stays clean; the filter script is
            // also useless without the render, so remove it too.
            let _ = std::fs::remove_file(&tmp_path);
            let _ = std::fs::remove_file(&filter_script);
            let _ = std::fs::remove_dir_all(&alias_dir);
            return Err(e);
        }
    };
    // Filter script + alias dir are per-job — safe to remove on success.
    let _ = std::fs::remove_file(&filter_script);
    let _ = std::fs::remove_dir_all(&alias_dir);

    let published = paths::atomic_publish(&tmp_path, &final_path)?;
    let output_path = published.to_string_lossy().into_owned();
    record_render(
        &db_gate,
        "reel",
        req.year as i64,
        None,
        &output_path,
        Some(outcome.duration_ms),
        Some(outcome.frames as i64),
        None,
    )
    .await;
    Ok(RenderReelResponse {
        output_path,
        frames_encoded: outcome.frames,
        duration_ms: outcome.duration_ms,
        music_used: spec
            .music_track
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned()),
    })
}

// ── Per-child render ─────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct RenderChildRequest {
    pub source_folder: String,
    pub output_folder: String,
    pub student_id: i64,
    pub display_name: String,
    pub year: u32,
    pub music_track: Option<String>,
    pub music_folder: Option<String>,
    pub duration_sec: f64,
    pub avg_photo_sec: f64,
    pub job_id: String,
}

#[tauri::command]
pub async fn graduation_render_child(
    app: AppHandle,
    state: State<'_, RenderState>,
    db_gate: State<'_, DbGate>,
    req: RenderChildRequest,
) -> Result<RenderReelResponse, String> {
    // F6: reject a hostile job_id before it lands in cache paths.
    let job_id = sanitize_job_id(&req.job_id)?;
    // F9: reset the backend cancel flag on every render entrypoint. The
    // frontend batch loop's own `cancelledRef` decides whether to
    // iterate; the backend flag is only meaningful for "kill the
    // currently-running child". Leaving it sticky between calls made
    // standalone per-child runs abort instantly after any prior cancel.
    reset_cancelled(&state);
    let cache_root = paths::cache_dir(&app)?;
    let heic_cache = cache_root.join("heic");
    let source = paths::validate_folder(&req.source_folder)?;
    let scan = {
        let src = source.clone();
        let cache = heic_cache.clone();
        let flag = Arc::clone(&state.cancel_flag);
        tokio::task::spawn_blocking(move || {
            curate::scan_and_rank_cancellable(&src, &cache, &|| flag.load(Ordering::Relaxed))
        })
            .await
            .map_err(|e| format!("curate join: {e}"))?
    };
    // Post-scan cancel checkpoint. See render_reel for rationale.
    if is_cancelled(&state) {
        return Err("cancelled".into());
    }
    if scan.photos.is_empty() {
        return Err(format!(
            "No usable photos in {} for student {}.",
            req.source_folder, req.display_name,
        ));
    }
    let target_count = (req.duration_sec / req.avg_photo_sec.max(0.5)).ceil() as usize;
    let curated = curate::curate(&scan.photos, target_count.max(1));

    let explicit_music: Option<PathBuf> = req
        .music_track
        .as_ref()
        .filter(|s| !s.is_empty())
        .map(|s| paths::validate_file(s))
        .transpose()?;
    let auto_music: Option<PathBuf> = if explicit_music.is_none() {
        req.music_folder
            .as_ref()
            .filter(|s| !s.is_empty())
            .and_then(|f| paths::validate_folder(f).ok())
            .and_then(|f| paths::pick_random_audio_in(&f))
    } else {
        None
    };
    let music_track: Option<PathBuf> = explicit_music
        .or(auto_music)
        .or_else(|| paths::default_music_track(&app));

    let filter_script = cache_root.join(format!("child-{}-filter.script", job_id));

    let out_dir = paths::validate_writable_dir(&req.output_folder)?;
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("mkdir output: {e}"))?;
    let folder_name = paths::student_folder_name(req.student_id, &req.display_name);
    let final_path = out_dir.join(format!("{folder_name}.mp4"));
    let tmp_path = out_dir.join(format!("{folder_name}.mp4.tmp"));

    let source_photos: Vec<PathBuf> = curated.iter().map(|p| p.path.clone()).collect();
    // F4: hard-link → short alias to keep Windows argv under 32 KB.
    let alias_dir = cache_root.join(format!("child-{}-aliases", job_id));
    let photos = alias_photos(&source_photos, &alias_dir)?;
    // Build the same ReelSpec build_per_child_cmd would produce so we
    // can render its filter script deterministically before spawning.
    let per_child_spec = engine::ReelSpec {
        photos: photos.clone(),
        music_track: music_track.clone(),
        output: tmp_path.clone(),
        filter_script: filter_script.clone(),
        width: 1280,
        height: 720,
        avg_photo_sec: req.avg_photo_sec,
        transition_sec: 0.6,
        total_duration_sec: spec_total_duration(curated.len(), req.avg_photo_sec, 0.6),
        fps: 30,
        video_bitrate_kbps: 2000,
        encoder: engine::HwEncoder::for_current_os(),
        emit_progress: true,
    };
    let filter_text = engine::build_filter_script(&per_child_spec);
    std::fs::write(&filter_script, &filter_text)
        .map_err(|e| format!("write filter script: {e}"))?;
    let args = engine::build_reel_cmd(&per_child_spec);

    let outcome = match spawn_and_stream(&app, state, &job_id, "per-child", args, Some(alias_dir.clone())).await {
        Ok(o) => o,
        Err(e) => {
            let _ = std::fs::remove_file(&tmp_path);
            let _ = std::fs::remove_file(&filter_script);
            let _ = std::fs::remove_dir_all(&alias_dir);
            return Err(e);
        }
    };
    let _ = std::fs::remove_file(&filter_script);
    let _ = std::fs::remove_dir_all(&alias_dir);
    let published = paths::atomic_publish(&tmp_path, &final_path)?;
    let output_path = published.to_string_lossy().into_owned();
    record_render(
        &db_gate,
        "per_child",
        req.year as i64,
        Some(req.student_id),
        &output_path,
        Some(outcome.duration_ms),
        Some(outcome.frames as i64),
        None,
    )
    .await;
    Ok(RenderReelResponse {
        output_path,
        frames_encoded: outcome.frames,
        duration_ms: outcome.duration_ms,
        music_used: per_child_spec
            .music_track
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned()),
    })
}

// ── Cancel ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn graduation_cancel(state: State<'_, RenderState>) -> Result<(), String> {
    // Atomically set the cancel flag AND take the current child under a
    // single lock — this used to be two separate mutexes acquired in
    // opposite order from the spawn path, which was a lock-inversion
    // hazard (see F5). Fixing by merging into one struct.
    let mut inner = state.inner.lock().map_err(|e| format!("lock: {e}"))?;
    inner.cancelled = true;
    // F14: signal worker threads (curate scan, HEIC decode) via the
    // atomic mirror so they can bail out mid-work without touching the
    // mutex. Set AFTER the bool so any observer that sees the atomic
    // set will also see the bool set on next lock acquisition.
    state.cancel_flag.store(true, Ordering::SeqCst);
    if let Some((_id, child)) = inner.current_child.take() {
        // Release the lock before kill() so we don't hold it across a
        // potentially-blocking OS call.
        drop(inner);
        child.kill().map_err(|e| format!("kill: {e}"))?;
    }
    Ok(())
}

/// Explicit reset — called by the frontend at the start of a new batch
/// so a prior cancel doesn't leak into the next `Render everything`.
#[tauri::command]
pub fn graduation_reset_cancel(state: State<'_, RenderState>) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| format!("lock: {e}"))?;
    inner.cancelled = false;
    state.cancel_flag.store(false, Ordering::SeqCst);
    Ok(())
}

// ── Slides render ────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct RenderSlidesRequest {
    /// Explicit template path. If empty, we auto-detect a .pptx in
    /// `template_folder`; if still nothing, fall back to the bundled
    /// default template shipped in resources/.
    pub template_path: Option<String>,
    pub template_folder: Option<String>,
    pub output_folder: String,
    pub year: u32,
    pub students: Vec<SlideStudentIn>,
}

#[derive(Debug, Deserialize)]
pub struct SlideStudentIn {
    pub name: String,
    pub note: Option<String>,
    pub photo_folder: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RenderSlidesResponse {
    pub output_path: String,
    pub slides_written: usize,
    pub template_used: String,
    /// Non-fatal render warnings — surface these in the UI so users
    /// understand why a slide fell back to the placeholder (F15).
    pub warnings: Vec<String>,
    /// Per-child status (name + matched photo count + human-readable
    /// status message). Frontend can render this as a table so the
    /// user sees which kids matched, which fell back, and why (F16).
    pub child_results: Vec<ChildResult>,
}

#[derive(Debug, Serialize)]
pub struct ChildResult {
    pub name: String,
    pub photo_count: usize,
    pub status: String,
}

#[tauri::command]
pub async fn graduation_render_slides(
    app: AppHandle,
    db_gate: State<'_, DbGate>,
    state: State<'_, RenderState>,
    req: RenderSlidesRequest,
) -> Result<RenderSlidesResponse, String> {
    if req.students.is_empty() {
        return Err("No graduating students provided".to_string());
    }
    reset_cancelled(&state);
    // Resolve template: explicit path → template_folder → bundled default.
    // Every user-supplied path passes through path_guard first.
    let tpl: PathBuf = if let Some(p) = req.template_path.as_ref().filter(|s| !s.is_empty()) {
        paths::validate_file(p)?
    } else if let Some(folder) = req.template_folder.as_ref().filter(|s| !s.is_empty()) {
        let f = paths::validate_folder(folder)?;
        if let Some(found) = paths::first_pptx_in(&f) {
            found
        } else {
            paths::default_slide_template(&app)
                .ok_or_else(|| "No template found in folder and no bundled default available".to_string())?
        }
    } else {
        paths::default_slide_template(&app)
            .ok_or_else(|| "No template specified and no bundled default available".to_string())?
    };
    let out_dir = paths::validate_writable_dir(&req.output_folder)?;
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("mkdir output: {e}"))?;
    let final_path = out_dir.join(format!("Graduation-Slides-{}.pptx", req.year));
    let tmp_path = out_dir.join(format!("Graduation-Slides-{}.pptx.tmp", req.year));

    let ctx = pptx::TemplateContext {
        year: req.year,
        students: req
            .students
            .iter()
            .map(|s| {
                let photos: Vec<PathBuf> = s
                    .photo_folder
                    .as_deref()
                    .map(|folder_str| match paths::validate_folder(folder_str) {
                        Ok(folder) => {
                            let hits = paths::child_photos(&folder, &s.name);
                            if hits.is_empty() {
                                eprintln!(
                                    "[graduation] no matching photo for '{}' in {folder_str}",
                                    s.name
                                );
                            }
                            hits
                        }
                        Err(e) => {
                            eprintln!(
                                "[graduation] invalid photo folder for '{}': {e}",
                                s.name
                            );
                            Vec::new()
                        }
                    })
                    .unwrap_or_default();
                pptx::SlideRow {
                    name: s.name.clone(),
                    note: s.note.clone().unwrap_or_default(),
                    photos,
                }
            })
            .collect(),
    };
    let flag = Arc::clone(&state.cancel_flag);
    let is_cancelled_cb: Box<dyn Fn() -> bool + Send + Sync> =
        Box::new(move || flag.load(Ordering::Relaxed));
    let report = match pptx::render_slides_cancellable(&tpl, &tmp_path, &ctx, &*is_cancelled_cb) {
        Ok(r) => r,
        Err(e) => {
            // F15: sweep any partial .pptx.tmp on failure so stale
            // half-written decks don't accumulate in the output folder.
            let _ = std::fs::remove_file(&tmp_path);
            return Err(e);
        }
    };
    let published = match paths::atomic_publish(&tmp_path, &final_path) {
        Ok(p) => p,
        Err(e) => {
            // Publish failed → tmp is still there. Sweep it.
            let _ = std::fs::remove_file(&tmp_path);
            return Err(e);
        }
    };
    let output_path = published.to_string_lossy().into_owned();
    let template_used = tpl.to_string_lossy().into_owned();
    record_render(
        &db_gate,
        "slides",
        req.year as i64,
        None,
        &output_path,
        None,
        None,
        Some(req.students.len() as i64),
    )
    .await;
    Ok(RenderSlidesResponse {
        output_path,
        slides_written: req.students.len(),
        template_used,
        warnings: report.warnings,
        child_results: report
            .children
            .into_iter()
            .map(|c| ChildResult {
                name: c.name,
                photo_count: c.photo_count,
                status: c.status,
            })
            .collect(),
    })
}

// ── Internals ─────────────────────────────────────────────────────────

struct RenderOutcome {
    frames: u64,
    duration_ms: i64,
}

async fn spawn_and_stream(
    app: &AppHandle,
    state: State<'_, RenderState>,
    job_id: &str,
    stage: &'static str,
    args: Vec<String>,
    cwd: Option<PathBuf>,
) -> Result<RenderOutcome, String> {
    use tauri_plugin_shell::process::CommandEvent;

    let shell = app.shell();
    let mut cmd = shell
        .sidecar("ffmpeg")
        .map_err(|e| format!("sidecar resolve: {e}"))?
        .args(args);
    // Setting current_dir lets callers pass relative `-i p0001.jpg`
    // args instead of full alias paths, keeping argv well under
    // Windows' 32 KB CreateProcess cap even for 300+ photos.
    if let Some(dir) = cwd {
        cmd = cmd.current_dir(dir);
    }

    let (mut rx, child) = cmd.spawn().map_err(|e| format!("spawn ffmpeg: {e}"))?;

    let my_id = {
        let mut inner = state.inner.lock().map_err(|e| format!("lock: {e}"))?;
        // Kill any previous child before overwriting. `CommandChild`'s
        // Drop does NOT kill the process — dropping just closes our
        // side of the pipes, leaving a zombie FFmpeg that fills its
        // stderr buffer, blocks, and idles until app exit.
        if let Some((_prev_id, prev)) = inner.current_child.take() {
            let _ = prev.kill();
        }
        // Cancel race guard: if the user pressed Cancel between the
        // photo scan finishing and this point, the cancel signal
        // arrived while current_child was None. Check the flag now
        // that we hold the same lock cancel uses.
        if inner.cancelled {
            let _ = child.kill();
            return Err("cancelled".into());
        }
        inner.next_child_id = inner.next_child_id.wrapping_add(1);
        let id = inner.next_child_id;
        inner.current_child = Some((id, child));
        id
    };

    let start = std::time::Instant::now();
    let mut latest = progress::ProgressTick::default();
    let mut carry = String::new();
    // Stateful progress parser: keep field state across stdout events so
    // fields from the same block (frame/fps/out_time_us) stay bundled
    // even when they arrive in separate CommandEvent::Stdout chunks.
    let mut parser = progress::ProgressParser::new();
    while let Some(ev) = rx.recv().await {
        match ev {
            CommandEvent::Stdout(bytes) => {
                let text = String::from_utf8_lossy(&bytes).into_owned();
                carry.push_str(&text);
                if let Some(last_newline) = carry.rfind('\n') {
                    let ready = carry[..=last_newline].to_string();
                    carry = carry[last_newline + 1..].to_string();
                    for line in ready.split_inclusive('\n') {
                        if let Some(tick) = parser.feed_line(line) {
                            latest = tick.clone();
                            let _ = app.emit(
                                "graduation://progress",
                                ProgressPayload {
                                    job_id: job_id.to_string(),
                                    stage: stage.to_string(),
                                    tick,
                                },
                            );
                        }
                    }
                }
            }
            CommandEvent::Stderr(bytes) => {
                let msg = String::from_utf8_lossy(&bytes).trim_end().to_string();
                if !msg.is_empty() {
                    let _ = app.emit(
                        "graduation://log",
                        LogPayload {
                            job_id: job_id.to_string(),
                            level: "info".into(),
                            message: msg,
                        },
                    );
                }
            }
            CommandEvent::Error(e) => {
                let _ = clear_child(&state, my_id);
                return Err(format!("ffmpeg command error: {e}"));
            }
            CommandEvent::Terminated(status) => {
                let _ = clear_child(&state, my_id);
                if status.code.unwrap_or(1) != 0 {
                    return Err(format!(
                        "ffmpeg exited with code {:?} signal {:?}",
                        status.code, status.signal,
                    ));
                }
                break;
            }
            _ => {}
        }
    }

    Ok(RenderOutcome {
        frames: latest.frame.unwrap_or(0),
        duration_ms: start.elapsed().as_millis() as i64,
    })
}

fn clear_child(state: &State<'_, RenderState>, my_id: u64) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| format!("lock: {e}"))?;
    // Only clear if we still own the slot. If a newer render replaced
    // us (and killed our process to do so), leave the newer child in
    // place — otherwise its cancel handle would be lost.
    if let Some((cur_id, _)) = &inner.current_child {
        if *cur_id == my_id {
            inner.current_child = None;
        }
    }
    Ok(())
}

fn is_cancelled(state: &State<'_, RenderState>) -> bool {
    state
        .inner
        .lock()
        .map(|g| g.cancelled)
        .unwrap_or(false)
}

fn reset_cancelled(state: &State<'_, RenderState>) {
    if let Ok(mut g) = state.inner.lock() {
        g.cancelled = false;
    }
    state.cancel_flag.store(false, Ordering::SeqCst);
}

/// Resolve the FFmpeg sidecar path relative to the app bundle. Used by
/// preflight (which needs the plain path so it can shell out with
/// std::process::Command for a quick `-version` probe).
///
/// Tries every plausible target-triple name so a mixed-arch Mac (Intel
/// vs Apple Silicon) or a fresh Windows install (with or without
/// Tauri's target-triple suffix) resolves cleanly.
fn sidecar_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    // Prefer the resource dir (bundle-relative); fall back to the exe's
    // parent for `cargo tauri dev` where the sidecar sits next to the
    // dev binary, then the src-tauri/binaries/ dev tree.
    #[cfg(target_os = "windows")]
    let candidates: &[&str] = &["ffmpeg-x86_64-pc-windows-msvc.exe", "ffmpeg.exe"];
    #[cfg(target_os = "macos")]
    let candidates: &[&str] = &[
        // Try the current arch first, then the other Mac arch (Rosetta
        // can execute x86_64 on Apple Silicon transparently).
        #[cfg(target_arch = "aarch64")]
        "ffmpeg-aarch64-apple-darwin",
        #[cfg(target_arch = "aarch64")]
        "ffmpeg-x86_64-apple-darwin",
        #[cfg(target_arch = "x86_64")]
        "ffmpeg-x86_64-apple-darwin",
        #[cfg(target_arch = "x86_64")]
        "ffmpeg-aarch64-apple-darwin",
        "ffmpeg",
    ];
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let candidates: &[&str] = &["ffmpeg"];

    // Search order for each candidate name: bundle resource_dir → exe
    // dir → dev binaries tree. First hit wins.
    let mut search_roots: Vec<PathBuf> = Vec::new();
    if let Ok(resource) = app.path().resource_dir() {
        search_roots.push(resource);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            search_roots.push(dir.to_path_buf());
        }
    }
    search_roots.push(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries"));

    for name in candidates {
        for root in &search_roots {
            let candidate = root.join(name);
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }
    Err(format!(
        "FFmpeg sidecar not found. Tried: {} in {}",
        candidates.join(", "),
        search_roots.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join("; ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_job_id_accepts_typical_uuid_like_strings() {
        // Frontend passes `crypto.randomUUID()` without dashes, or a
        // timestamp+random suffix. Both must pass.
        assert!(sanitize_job_id("abc123DEF").is_ok());
        assert!(sanitize_job_id("1699999999-abcd_efgh").is_ok());
        assert!(sanitize_job_id("a").is_ok());
    }

    #[test]
    fn sanitize_job_id_rejects_traversal_and_special_chars() {
        // F6: raw job_id lands in cache paths; escape hatches must fail.
        assert!(sanitize_job_id("../etc/passwd").is_err());
        assert!(sanitize_job_id("job/id").is_err());
        assert!(sanitize_job_id("job.id").is_err());
        assert!(sanitize_job_id("job id").is_err());
        assert!(sanitize_job_id("").is_err());
        // Length cap.
        assert!(sanitize_job_id(&"a".repeat(65)).is_err());
        assert!(sanitize_job_id(&"a".repeat(64)).is_ok());
    }

    #[test]
    fn alias_photos_creates_short_paths_in_order() {
        // F4 + review-agent #2: aliases must be relative filenames
        // (no path prefix) so the argv stays under Windows' 32 KB cap
        // when the caller sets ffmpeg's current_dir to scratch.
        let src_dir = tempfile::tempdir().unwrap();
        let scratch = tempfile::tempdir().unwrap();
        let mut sources: Vec<PathBuf> = Vec::new();
        for i in 0..3 {
            let p = src_dir.path().join(format!("very-long-source-name-{i}.jpg"));
            std::fs::write(&p, format!("photo-{i}").as_bytes()).unwrap();
            sources.push(p);
        }
        let aliases = alias_photos(&sources, scratch.path()).expect("alias should succeed");
        assert_eq!(aliases.len(), 3);
        // Each alias is a bare filename — no parent components.
        for a in &aliases {
            assert!(a.parent().map(|p| p.as_os_str().is_empty()).unwrap_or(true),
                "alias {:?} should be a bare filename, no path prefix", a);
        }
        assert_eq!(aliases[0].to_str().unwrap(), "p0001.jpg");
        assert_eq!(aliases[2].to_str().unwrap(), "p0003.jpg");
        // Content preserved (hard link or copy) on disk under scratch.
        for (i, a) in aliases.iter().enumerate() {
            let bytes = std::fs::read(scratch.path().join(a)).unwrap();
            assert_eq!(bytes, format!("photo-{i}").as_bytes());
        }
    }
}
