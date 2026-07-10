//! Preflight checks for the Graduation Day render pipeline.
//!
//! Runs BEFORE any FFmpeg render. Validates:
//! 1. FFmpeg sidecar exists and executes (`-version` returns 0)
//! 2. Required encoders + filters are present in that binary
//! 3. Required destination folders exist and are writable
//! 4. Disk space at the output volume is > minimum threshold
//! 5. libheif loads (only needed if the source folder contains HEIC)
//!
//! Every check returns a `StepReport` so the frontend can render the
//! full preflight matrix with per-check status.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::graduation::StepReport;

/// Encoders we require in the FFmpeg sidecar. Platform-specific: on
/// macOS we need `h264_videotoolbox`, on Windows we need `h264_mf`.
pub fn required_encoders() -> &'static [&'static str] {
    #[cfg(target_os = "macos")]
    {
        &["h264_videotoolbox", "aac"]
    }
    #[cfg(target_os = "windows")]
    {
        &["h264_mf", "aac"]
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        &["libopenh264", "aac"]
    }
}

/// Filters we depend on across all render paths. Split into two rows
/// so the failure surface is more precise than "one required filter is
/// missing".
///
/// - Core scale/format primitives are needed on every render.
/// - Ken Burns + audio fade + loudness normalisation for slideshow reels.
/// - v2.3.1 blurred-backdrop composition: `split`, `gblur`, `hue`,
///   `lutyuv`, `overlay`. If the sidecar was built without any of these
///   (some minimal LGPL builds drop `hue` or `lutyuv`), the reel filter
///   graph will parse-fail 90 seconds into a render.
pub fn required_filters() -> &'static [&'static str] {
    &[
        // Core resize / pixel format primitives.
        "scale", "format", "setsar", "crop",
        // Motion + fades.
        "zoompan", "xfade", "afade", "loudnorm",
        // v2.3.1 blurred-backdrop composition.
        "split", "gblur", "hue", "lutyuv", "overlay",
    ]
}

/// Minimum free disk space at the output volume, in bytes. 5 GB covers
/// the 15-minute reel + all per-child videos + transient FFmpeg temp
/// files without ever crowding a modest SSD.
pub const MIN_FREE_BYTES: u64 = 5 * 1024 * 1024 * 1024;

/// Runs the ffmpeg sidecar with `-version`, capturing stdout. Errors if
/// the binary is missing, unexecutable, or returns non-zero.
pub fn check_ffmpeg(ffmpeg_path: &Path) -> StepReport {
    if !ffmpeg_path.exists() {
        return StepReport::fail(format!(
            "FFmpeg sidecar not found at {}",
            ffmpeg_path.display()
        ));
    }
    match Command::new(ffmpeg_path).arg("-version").output() {
        Ok(out) if out.status.success() => {
            let first_line = String::from_utf8_lossy(&out.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .to_string();
            StepReport::ok(format!("FFmpeg ok: {first_line}"))
        }
        Ok(out) => StepReport::fail(format!(
            "ffmpeg -version exit {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        )),
        Err(e) => StepReport::fail(format!("ffmpeg spawn: {e}")),
    }
}

/// Verify that every required encoder + filter is listed by the sidecar.
/// One extra spawn per check is cheap and lets us surface a precise
/// error like "missing h264_videotoolbox" instead of a mysterious render
/// failure 90 seconds into the reel.
pub fn check_capabilities(ffmpeg_path: &Path) -> StepReport {
    let enc = match Command::new(ffmpeg_path).arg("-hide_banner").arg("-encoders").output() {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
        Ok(o) => return StepReport::fail(format!("-encoders exit {}", o.status)),
        Err(e) => return StepReport::fail(format!("-encoders spawn: {e}")),
    };
    let filt = match Command::new(ffmpeg_path).arg("-hide_banner").arg("-filters").output() {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
        Ok(o) => return StepReport::fail(format!("-filters exit {}", o.status)),
        Err(e) => return StepReport::fail(format!("-filters spawn: {e}")),
    };

    let mut missing: Vec<String> = Vec::new();
    for name in required_encoders() {
        // Encoder listing rows look like " V..... h264_mf ...". Match on
        // whitespace-bounded token to avoid substring collisions
        // (e.g. matching `aac_at` when we asked for `aac`).
        if !enc.lines().any(|l| l.split_whitespace().nth(1) == Some(*name)) {
            missing.push(format!("encoder:{name}"));
        }
    }
    for name in required_filters() {
        // Filter listing rows look like " T.. loudnorm  V->V ...". Match
        // column 2 (the name) exactly to avoid substring collisions
        // (e.g. `format` matching `pixel_format` elsewhere in the
        // listing). Uses the same asymmetric-safe pattern as encoders.
        if !filt.lines().any(|l| l.split_whitespace().nth(1) == Some(*name)) {
            missing.push(format!("filter:{name}"));
        }
    }

    if missing.is_empty() {
        StepReport::ok("All required encoders + filters present.")
    } else {
        StepReport::fail(format!("Missing: {}", missing.join(", ")))
    }
}

/// Confirms `dir` exists and is writable by performing a create+delete
/// probe. Empty file so we don't leave a stray temp on failure.
pub fn check_writable_folder(dir: &Path) -> StepReport {
    if !dir.exists() {
        return StepReport::fail(format!("Folder not found: {}", dir.display()));
    }
    if !dir.is_dir() {
        return StepReport::fail(format!("Not a directory: {}", dir.display()));
    }
    let probe = dir.join(".echelon-write-probe");
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            StepReport::ok(format!("Writable: {}", dir.display()))
        }
        Err(e) => StepReport::fail(format!("Not writable: {} ({e})", dir.display())),
    }
}

/// Free-space check. Platform-specific; falls back to a soft-ok on
/// platforms where the query isn't wired.
pub fn check_free_space(dir: &Path) -> StepReport {
    match free_bytes(dir) {
        Some(bytes) if bytes >= MIN_FREE_BYTES => StepReport::ok(format!(
            "{:.1} GB free at {}",
            bytes as f64 / 1_073_741_824.0,
            dir.display()
        )),
        Some(bytes) => StepReport::fail(format!(
            "Only {:.1} GB free at {}. Need ≥ 5 GB.",
            bytes as f64 / 1_073_741_824.0,
            dir.display()
        )),
        None => StepReport::ok(format!(
            "Free-space check skipped (unsupported platform) at {}",
            dir.display()
        )),
    }
}

#[cfg(unix)]
fn free_bytes(dir: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c = CString::new(dir.as_os_str().as_bytes()).ok()?;
    // SAFETY: statvfs takes a NUL-terminated path and a pointer to a
    // caller-allocated statvfs struct. We provide both.
    unsafe {
        let mut s: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c.as_ptr(), &mut s) != 0 {
            return None;
        }
        Some(s.f_bavail as u64 * s.f_frsize as u64)
    }
}

#[cfg(windows)]
fn free_bytes(dir: &Path) -> Option<u64> {
    // Minimal Win32 call — no `windows` crate dep needed for a single
    // API. GetDiskFreeSpaceExW returns bytes available to the caller.
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetDiskFreeSpaceExW(
            lp_directory_name: *const u16,
            lp_free_bytes_available_to_caller: *mut u64,
            lp_total_number_of_bytes: *mut u64,
            lp_total_number_of_free_bytes: *mut u64,
        ) -> i32;
    }
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut avail: u64 = 0;
    let mut total: u64 = 0;
    let mut free: u64 = 0;
    // SAFETY: buffers are stack-allocated and outlive the call; path is
    // NUL-terminated per the encode_wide chain above.
    let ok = unsafe {
        GetDiskFreeSpaceExW(wide.as_ptr(), &mut avail, &mut total, &mut free)
    };
    if ok != 0 { Some(avail) } else { None }
}

#[cfg(not(any(unix, windows)))]
fn free_bytes(_: &Path) -> Option<u64> {
    None
}

/// Full preflight report, one entry per named check. The frontend
/// consumes the whole thing and renders a checklist; the render command
/// refuses to proceed if any check has `ok == false`.
#[derive(Debug, serde::Serialize)]
pub struct PreflightReport {
    pub checks: Vec<(String, StepReport)>,
    pub all_ok: bool,
}

pub struct PreflightInputs<'a> {
    pub ffmpeg_path: &'a Path,
    pub reel_folder: Option<PathBuf>,
    pub kids_folder: Option<PathBuf>,
    pub slides_folder: Option<PathBuf>,
    /// The output folder where renders are written. Distinct from the
    /// input folders above — this is where free-space actually matters.
    pub output_folder: Option<PathBuf>,
    pub any_heic: bool,
}

pub fn run_preflight(inputs: PreflightInputs<'_>) -> PreflightReport {
    let mut checks: Vec<(String, StepReport)> = Vec::new();
    checks.push(("ffmpeg-executable".into(), check_ffmpeg(inputs.ffmpeg_path)));
    if checks.last().map(|(_, r)| r.ok).unwrap_or(false) {
        checks.push((
            "ffmpeg-capabilities".into(),
            check_capabilities(inputs.ffmpeg_path),
        ));
    }
    // Input folders: only writability is meaningful (we write nothing
    // here; the check is a smoke test that the path resolves).
    for (label, opt) in [
        ("reel-folder", inputs.reel_folder.as_deref()),
        ("kids-folder", inputs.kids_folder.as_deref()),
        ("slides-folder", inputs.slides_folder.as_deref()),
    ] {
        if let Some(p) = opt {
            checks.push((format!("{label}-exists"), check_readable_folder(p)));
        }
    }
    // Output folder: writable AND has ≥ MIN_FREE_BYTES. This is where
    // multi-GB renders actually land, so it's the only place free-space
    // checks should gate the render.
    if let Some(p) = inputs.output_folder.as_deref() {
        checks.push(("output-writable".into(), check_writable_folder(p)));
        checks.push(("output-free-space".into(), check_free_space(p)));
    }
    if inputs.any_heic {
        checks.push(("libheif".into(), super::heic::probe()));
    }
    let all_ok = checks.iter().all(|(_, r)| r.ok);
    PreflightReport { checks, all_ok }
}

/// Softer sibling of [`check_writable_folder`]: only verifies existence
/// and that the path resolves to a directory. Used for input folders
/// where the user hasn't necessarily granted write permission.
pub fn check_readable_folder(dir: &Path) -> StepReport {
    if !dir.exists() {
        return StepReport::fail(format!("Folder not found: {}", dir.display()));
    }
    if !dir.is_dir() {
        return StepReport::fail(format!("Not a directory: {}", dir.display()));
    }
    StepReport::ok(format!("Found: {}", dir.display()))
}
