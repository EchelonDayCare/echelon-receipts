//! Class Reel feature (v3.3.0).
//!
//! Combines every graduating kid's photos into a single 10-12 min MP4.
//! Each kid gets ~30s: a 1.5s name card, then N photos xfade-chained
//! with Ken Burns pan/zoom (same brand as the per-kid reels).
//!
//! # Two-pass architecture
//!
//! **Pass 1 — per-kid segment:** For each kid, render a silent 1080p
//! MP4 to the cache dir: `color`-source name card + drawtext'd name
//! filter-chained into the existing per-photo Ken Burns pipeline.
//! Segments are ~30s each.
//!
//! **Pass 2 — concat + music:** All segments are `-i`'d as inputs and
//! xfade-chained with 0.6s crossfades (same rotation as [`engine`]).
//! Music track is mixed underneath with loudnorm + fade-out.
//!
//! Rationale for two passes vs one giant filter graph:
//! - Failure isolation for **missing / empty photo folders**: those
//!   kids are silently skipped and listed in the response `skipped[]`
//!   field so the render still produces a reel for the rest of the
//!   class. Note that an FFmpeg-level error on any segment still
//!   aborts the whole reel — the caller should surface that as a
//!   retryable failure, not a partial success.
//! - Progress bar can report "kid 5 of 20" naturally.
//! - Filter graph stays small per pass (no 200-node monster).
//! - Reuses [`engine::build_filter_script`] logic verbatim for photos.
//!
//! # Name cards
//!
//! Rendered inline via FFmpeg's `color` source + `drawtext` filter:
//! ```text
//! color=c=0x1e293b:s=WxH:d=1.5:r=30, drawtext=fontfile=...:text=...:...
//! ```
//!
//! Font is resolved at render time from the OS (Arial on Windows,
//! Helvetica on macOS, DejaVu on Linux) then copied into the per-job
//! alias dir so the filter arg is a bare filename — no path-escape
//! drama with Windows drive-letter colons or spaces. If no system
//! font is available, the name card falls back to a solid background
//! with no text (a colored breather between kids).

use std::path::PathBuf;

use crate::graduation::engine::HwEncoder;

/// Frame rate used for both segment render (Pass 1) and concat
/// (Pass 2). These MUST match — a mismatch would xfade at wrong
/// offsets and shift audio sync. Locked at 30 fps: matches the
/// per-kid engine, safe for TV playback, keeps encode time down.
pub const CLASS_REEL_FPS: u32 = 30;

/// Crossfade duration (seconds) used for both photo→photo transitions
/// inside a segment (Pass 1) and kid→kid transitions between segments
/// (Pass 2). MUST match at both call sites — Pass 2's offset math
/// assumes segments carry a symmetric xfade tail.
pub const CLASS_REEL_XFADE_SEC: f64 = 0.6;

/// Rotation of xfade transition kinds for kid-to-kid concat.
/// Mirrors [`engine::TRANSITIONS`] but kept local so future tuning can
/// diverge (e.g. class reel could prefer softer dissolves).
const CONCAT_TRANSITIONS: &[&str] = &[
    "fade",
    "dissolve",
    "wipeleft",
    "slideleft",
    "circleopen",
    "fadeblack",
    "wiperight",
    "slideright",
    "smoothleft",
];

/// One kid's segment inputs — resolved photo aliases and display name.
#[derive(Debug, Clone)]
pub struct SegmentSpec {
    pub display_name: String,
    /// Photo alias paths (relative filenames when caller uses cwd).
    pub photos: Vec<PathBuf>,
    /// Silent segment output MP4 (typically a `<cache>/class-seg-NN.mp4`).
    pub output: PathBuf,
    /// Filter-graph script destination.
    pub filter_script: PathBuf,
    /// Seconds of name card at the start of the segment. 0 disables.
    pub name_card_sec: f64,
    /// Font filename (relative to cwd). None → skip drawtext (bg only).
    pub name_card_font: Option<String>,
    /// Photo hold duration (seconds), pre-xfade overlap.
    pub photo_sec: f64,
    /// Crossfade duration between name card + photos and between photos.
    pub transition_sec: f64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub video_bitrate_kbps: u32,
    pub encoder: HwEncoder,
    pub emit_progress: bool,
}

impl SegmentSpec {
    fn effective_transition(&self) -> f64 {
        // Clamp so the transition can never exceed 40% of the shorter
        // of (name-card duration, photo duration).
        let short = self.photo_sec.min(if self.name_card_sec > 0.0 {
            self.name_card_sec
        } else {
            self.photo_sec
        });
        self.transition_sec.min(short * 0.4).max(0.0)
    }

    /// Total segment duration: name_card + N*photo - (N-1+has_card)*xfade.
    pub fn computed_duration(&self) -> f64 {
        let n = self.photos.len() as f64;
        let x = self.effective_transition();
        let card = if self.name_card_sec > 0.0 { self.name_card_sec } else { 0.0 };
        let card_gap = if self.name_card_sec > 0.0 && n >= 1.0 { x } else { 0.0 };
        let photo_gaps = (n - 1.0).max(0.0) * x;
        (card + n * self.photo_sec - card_gap - photo_gaps).max(0.0)
    }
}

/// FFmpeg drawtext text= escape: the surrounding `'…'` in the filter
/// graph enters single-quoted mode, and drawtext itself further
/// interprets `\`, `:`, `%`, and `'`. In practice, our render is safe
/// as long as we escape backslash, single quote (via `\\'`), and `%`.
/// Colons inside single-quoted text= are fine per FFmpeg's parser.
pub fn escape_drawtext_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '\\' => out.push_str(r"\\"),
            '\'' => out.push_str(r"\'"), // drawtext's own escape inside '…'
            '%' => out.push_str(r"\%"),
            _ => out.push(c),
        }
    }
    out
}

/// Locate a bold sans-serif font shipped with the OS. Returns the
/// absolute path (caller copies into the render's cwd so drawtext
/// sees a bare filename). Returns `None` if none of the well-known
/// paths exist — the caller falls back to a text-less name card.
pub fn resolve_system_font() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let candidates: &[&str] = &[
        r"C:\Windows\Fonts\arialbd.ttf",     // Arial Bold
        r"C:\Windows\Fonts\segoeuib.ttf",    // Segoe UI Bold
        r"C:\Windows\Fonts\calibrib.ttf",    // Calibri Bold
        r"C:\Windows\Fonts\arial.ttf",       // Arial Regular (fallback)
    ];
    #[cfg(target_os = "macos")]
    let candidates: &[&str] = &[
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/HelveticaNeue.ttc",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial Bold.ttf",
        "/System/Library/Fonts/Avenir Next.ttc",
    ];
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let candidates: &[&str] = &[
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    ];
    for c in candidates {
        let p = PathBuf::from(c);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// Build the filter-graph script for a single kid segment (name card
/// + photos xfade-chained). Output label is always `[vout]`.
pub fn build_segment_filter(spec: &SegmentSpec) -> String {
    let n = spec.photos.len();
    let w = spec.width;
    let h = spec.height;
    let fps = spec.fps;
    let d = spec.photo_sec;
    let x = spec.effective_transition();
    let total_frames = (d * fps as f64).round().max(1.0) as u64;
    let has_card = spec.name_card_sec > 0.0;

    let mut out = String::with_capacity(n * 512 + 512);

    // Name card: color source (constant duration) + optional drawtext.
    // Slate background 0x1e293b (matches app UI ink/900) with white text
    // sized to ~10% of frame height so it reads at any distance.
    if has_card {
        let font_size = ((h as f64) * 0.10).round() as u32;
        // Drop shadow gives the text lift on light photos in transition.
        let text = escape_drawtext_text(&spec.display_name);
        let drawtext = if let Some(font) = &spec.name_card_font {
            format!(
                ",drawtext=fontfile='{font}':text='{text}':\
                 fontsize={fs}:fontcolor=white:\
                 shadowcolor=black@0.55:shadowx=2:shadowy=3:\
                 x=(w-text_w)/2:y=(h-text_h)/2",
                font = font, text = text, fs = font_size,
            )
        } else {
            // No system font available → colored breather only.
            String::new()
        };
        out.push_str(&format!(
            "color=c=0x1e293b:s={w}x{h}:d={dur}:r={fps}{drawtext},\
             setsar=1,format=yuv420p[namecard];",
            w = w, h = h, dur = spec.name_card_sec, fps = fps,
            drawtext = drawtext,
        ));
    }

    // Per-photo Ken Burns chain (mirrors engine.rs::build_filter_script).
    // Each photo input is at index `i` (0..N-1) — no name card input
    // since we synthesise it via `color` source above.
    let zoom_expr = format!("min(1+0.1*on/{tf},1.10)", tf = total_frames.max(1));
    for i in 0..n {
        out.push_str(&format!(
            "[{i}:v]split[a{i}][b{i}];\
             [a{i}]scale=w={w}:h={h}:force_original_aspect_ratio=increase,\
                   crop={w}:{h},gblur=sigma=25,hue=s=0.7,\
                   lutyuv=y='val*0.65',setsar=1[bg{i}];\
             [b{i}]scale=w={w}:h={h}:force_original_aspect_ratio=decrease,\
                   setsar=1[fg{i}];\
             [bg{i}][fg{i}]overlay=(W-w)/2:(H-h)/2,\
                   zoompan=z='{zoom}':\
                          x='iw/2-(iw/zoom/2)':\
                          y='ih/2-(ih/zoom/2)':\
                          d=1:s={w}x{h}:fps={fps},\
                   format=yuv420p[v{i}];",
            i = i, w = w, h = h, fps = fps, zoom = zoom_expr,
        ));
    }

    // xfade chain: optional [namecard] -> [v0] -> [v1] -> ... -> [vout].
    let mut prev_label: String;
    let mut cursor: f64;
    if has_card && n >= 1 {
        // Card → first photo transition.
        let offset = spec.name_card_sec - x;
        let dst = if n == 1 { "vout".to_string() } else { "t0".to_string() };
        out.push_str(&format!(
            "[namecard][v0]xfade=transition=fade:duration={x:.3}:offset={o:.3}[{dst}];",
            x = x, o = offset.max(0.01), dst = dst,
        ));
        prev_label = dst;
        cursor = spec.name_card_sec + d - x; // start-time of v1 in output
    } else if !has_card && n >= 1 {
        // No name card — v0 is the head.
        prev_label = "v0".to_string();
        cursor = d;
    } else {
        // Degenerate: no photos at all. Emit a null pass so callers
        // don't blow up mapping [vout].
        out.push_str("[namecard]null[vout]");
        return out;
    }

    for i in 1..n {
        let dst = if i == n - 1 { "vout".to_string() } else { format!("s{i}") };
        let transition = super::engine_transitions()[(i - 1) % super::engine_transitions().len()];
        let offset = cursor - x; // xfade offset marks when the FADE starts
        out.push_str(&format!(
            "[{prev}][v{i}]xfade=transition={t}:duration={x:.3}:offset={o:.3}[{dst}];",
            prev = prev_label, i = i, t = transition, x = x, o = offset.max(0.01), dst = dst,
        ));
        prev_label = dst;
        cursor += d - x;
    }

    // Guard: if we never chained (single photo, no card), alias v0 → vout.
    if !out.contains("[vout]") {
        out.push_str(&format!("[{prev}]null[vout]", prev = prev_label));
    }

    if out.ends_with(';') { out.pop(); }
    out
}

/// Build the argv for a single kid segment render. Photos are passed
/// as `-loop 1 -t D -i <path>` inputs. Output is silent MP4.
pub fn build_segment_cmd(spec: &SegmentSpec) -> Vec<String> {
    let mut args: Vec<String> = Vec::with_capacity(24 + spec.photos.len() * 6);
    args.push("-hide_banner".into());
    args.push("-y".into());
    if spec.emit_progress {
        args.push("-progress".into());
        args.push("pipe:1".into());
        args.push("-nostats".into());
    }

    for photo in &spec.photos {
        args.push("-loop".into());
        args.push("1".into());
        args.push("-framerate".into());
        args.push(spec.fps.to_string());
        args.push("-t".into());
        args.push(format!("{:.3}", spec.photo_sec));
        args.push("-i".into());
        args.push(photo.to_string_lossy().into_owned());
    }

    args.push("-/filter_complex".into());
    args.push(spec.filter_script.to_string_lossy().into_owned());

    args.push("-map".into());
    args.push("[vout]".into());

    // No audio: class-reel music is mixed in Pass 2.
    args.push("-an".into());

    // Video encode. Same encoder gotchas as engine.rs — see its
    // docstring for the VideoToolbox / Media Foundation quirks.
    args.push("-c:v".into());
    args.push(spec.encoder.ffmpeg_codec_name().into());
    args.push("-pix_fmt".into());
    args.push("yuv420p".into());
    args.push("-r".into());
    args.push(spec.fps.to_string());
    match spec.encoder {
        HwEncoder::VideoToolbox => {
            args.push("-profile:v".into());
            args.push("main".into());
            args.push("-level".into());
            args.push("4.0".into());
            args.push("-bf".into());
            args.push("0".into());
            if spec.video_bitrate_kbps < 2000 {
                args.push("-q:v".into());
                args.push("50".into());
            } else {
                args.push("-b:v".into());
                args.push(format!("{}k", spec.video_bitrate_kbps));
            }
        }
        HwEncoder::MediaFoundation => {
            args.push("-b:v".into());
            args.push(format!("{}k", spec.video_bitrate_kbps));
            args.push("-rate_control".into());
            args.push("u_vbr".into());
            args.push("-scenario".into());
            args.push("camera_record".into());
            args.push("-quality".into());
            args.push("40".into());
        }
        HwEncoder::OpenH264 => {
            args.push("-b:v".into());
            args.push(format!("{}k", spec.video_bitrate_kbps));
        }
    }
    args.push("-movflags".into());
    args.push("+faststart".into());
    args.push("-f".into());
    args.push("mp4".into());
    args.push(spec.output.to_string_lossy().into_owned());
    args
}

// ─── Pass 2: concat + music ──────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ConcatSpec {
    /// Segment MP4s in playback order.
    pub segments: Vec<PathBuf>,
    /// Duration of each segment in seconds — needed for offset math.
    /// Must be same length as `segments`.
    pub segment_durations: Vec<f64>,
    pub music_track: Option<PathBuf>,
    pub output: PathBuf,
    pub filter_script: PathBuf,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// Crossfade duration between segments.
    pub transition_sec: f64,
    pub video_bitrate_kbps: u32,
    pub encoder: HwEncoder,
    pub emit_progress: bool,
}

impl ConcatSpec {
    /// Total output duration = sum(seg_dur) - (N-1)*xfade.
    pub fn computed_duration(&self) -> f64 {
        let x = self.transition_sec.max(0.0);
        let sum: f64 = self.segment_durations.iter().sum();
        let n = self.segments.len() as f64;
        (sum - (n - 1.0).max(0.0) * x).max(0.0)
    }
}

/// Filter graph for Pass 2: `[0:v][1:v]...[N-1:v]` xfade-chained,
/// music input at index N mixed in with loudnorm + fade-out. Output
/// video label `[vout]`, audio label `[aout]`.
pub fn build_concat_filter(spec: &ConcatSpec) -> String {
    // Defensive: use the shorter of the two vecs so a caller with
    // mismatched lengths gets a possibly-truncated but non-panicking
    // filter. debug_assert catches this in dev builds.
    debug_assert_eq!(
        spec.segments.len(),
        spec.segment_durations.len(),
        "segment_durations length must match segments length"
    );
    let n = spec.segments.len().min(spec.segment_durations.len());
    if n == 0 {
        return "color=c=black:s=1x1:d=1[vout]".to_string();
    }

    let mut out = String::with_capacity(n * 128 + 256);
    let x = spec.transition_sec.max(0.0);
    let w = spec.width;
    let h = spec.height;
    let fps = spec.fps;

    // Normalize each segment stream: setpts+fps+scale+format,setsar.
    // Guards against upstream encoders emitting drifted timestamps or
    // mismatched pixel formats when segments were encoded in different
    // sessions (rarely happens with our pipeline but cheap insurance).
    for i in 0..n {
        out.push_str(&format!(
            "[{i}:v]setpts=PTS-STARTPTS,fps={fps},\
             scale={w}:{h}:force_original_aspect_ratio=decrease,\
             pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,\
             setsar=1,format=yuv420p[s{i}];",
            i = i, w = w, h = h, fps = fps,
        ));
    }

    if n == 1 {
        out.push_str("[s0]null[vout]");
    } else {
        // Track offset of the running xfade point: each segment's play
        // window ends `duration - x` after its start, then next xfade
        // starts.
        let mut offset = 0.0f64;
        for i in 1..n {
            let seg_dur_prev = spec.segment_durations[i - 1];
            offset += seg_dur_prev - x;
            let prev = if i == 1 { "s0".to_string() } else { format!("c{}", i - 1) };
            let dst = if i == n - 1 { "vout".to_string() } else { format!("c{i}") };
            let transition = CONCAT_TRANSITIONS[(i - 1) % CONCAT_TRANSITIONS.len()];
            out.push_str(&format!(
                "[{prev}][s{i}]xfade=transition={t}:duration={x:.3}:offset={o:.3}[{dst}];",
                prev = prev, i = i, t = transition, x = x, o = offset.max(0.01), dst = dst,
            ));
        }
        if out.ends_with(';') { out.pop(); }
    }

    // Audio: last input is the music track when present.
    if spec.music_track.is_some() {
        let dur = spec.computed_duration();
        let fade_start = (dur - 3.0).max(1.0);
        let music_idx = n; // segments occupy 0..n
        out.push_str(&format!(
            ";[{m}:a]aloop=loop=-1:size=2e9,\
             loudnorm=I=-16:TP=-1.5:LRA=11,\
             aresample=48000,\
             atrim=0:{dur:.2},\
             afade=t=out:st={fs:.2}:d=3[aout]",
            m = music_idx, dur = dur, fs = fade_start,
        ));
    }

    out
}

/// Argv for Pass 2 (concat + music mux).
pub fn build_concat_cmd(spec: &ConcatSpec) -> Vec<String> {
    let mut args: Vec<String> = Vec::with_capacity(24 + spec.segments.len() * 2);
    args.push("-hide_banner".into());
    args.push("-y".into());
    if spec.emit_progress {
        args.push("-progress".into());
        args.push("pipe:1".into());
        args.push("-nostats".into());
    }

    for seg in &spec.segments {
        args.push("-i".into());
        args.push(seg.to_string_lossy().into_owned());
    }
    if let Some(music) = &spec.music_track {
        args.push("-i".into());
        args.push(music.to_string_lossy().into_owned());
    }

    args.push("-/filter_complex".into());
    args.push(spec.filter_script.to_string_lossy().into_owned());

    args.push("-map".into());
    args.push("[vout]".into());
    if spec.music_track.is_some() {
        args.push("-map".into());
        args.push("[aout]".into());
        args.push("-c:a".into());
        args.push("aac".into());
        args.push("-b:a".into());
        args.push("192k".into());
        args.push("-ar".into());
        args.push("48000".into());
        // -shortest not needed: we atrim audio to exact duration above.
    }

    args.push("-c:v".into());
    args.push(spec.encoder.ffmpeg_codec_name().into());
    args.push("-pix_fmt".into());
    args.push("yuv420p".into());
    args.push("-r".into());
    args.push(spec.fps.to_string());
    match spec.encoder {
        HwEncoder::VideoToolbox => {
            args.push("-profile:v".into());
            args.push("main".into());
            args.push("-level".into());
            args.push("4.0".into());
            args.push("-bf".into());
            args.push("0".into());
            if spec.video_bitrate_kbps < 2000 {
                args.push("-q:v".into());
                args.push("50".into());
            } else {
                args.push("-b:v".into());
                args.push(format!("{}k", spec.video_bitrate_kbps));
            }
        }
        HwEncoder::MediaFoundation => {
            args.push("-b:v".into());
            args.push(format!("{}k", spec.video_bitrate_kbps));
            args.push("-rate_control".into());
            args.push("u_vbr".into());
            args.push("-scenario".into());
            args.push("camera_record".into());
            args.push("-quality".into());
            args.push("40".into());
        }
        HwEncoder::OpenH264 => {
            args.push("-b:v".into());
            args.push(format!("{}k", spec.video_bitrate_kbps));
        }
    }
    args.push("-movflags".into());
    args.push("+faststart".into());
    args.push("-f".into());
    args.push("mp4".into());
    args.push(spec.output.to_string_lossy().into_owned());
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg_base() -> SegmentSpec {
        SegmentSpec {
            display_name: "Aarav S.".into(),
            photos: vec!["p0001.jpg".into(), "p0002.jpg".into(), "p0003.jpg".into()],
            output: "seg.mp4".into(),
            filter_script: "seg.filter".into(),
            name_card_sec: 1.5,
            name_card_font: Some("namecard.ttf".into()),
            photo_sec: 4.75,
            transition_sec: 0.6,
            width: 1920,
            height: 1080,
            fps: 30,
            video_bitrate_kbps: 5000,
            encoder: HwEncoder::OpenH264,
            emit_progress: false,
        }
    }

    #[test]
    fn escape_drawtext_handles_apostrophe() {
        assert_eq!(escape_drawtext_text("O'Brien"), r"O\'Brien");
        assert_eq!(escape_drawtext_text(r"path\to"), r"path\\to");
        assert_eq!(escape_drawtext_text("50%"), r"50\%");
    }

    #[test]
    fn segment_filter_has_namecard_and_photos() {
        let script = build_segment_filter(&seg_base());
        assert!(script.contains("color=c=0x1e293b"), "name card bg: {script}");
        assert!(script.contains("drawtext=fontfile='namecard.ttf'"),
                "font ref: {script}");
        assert!(script.contains("text='Aarav S.'"), "name text: {script}");
        // Three photo chains.
        for i in 0..3 {
            assert!(script.contains(&format!("[{i}:v]split")),
                    "photo {i} split: {script}");
            assert!(script.contains(&format!("[v{i}]")), "v{i}: {script}");
        }
        // Terminates at [vout].
        assert!(script.ends_with("[vout]"), "vout: {script}");
    }

    #[test]
    fn segment_filter_without_namecard() {
        let mut spec = seg_base();
        spec.name_card_sec = 0.0;
        let script = build_segment_filter(&spec);
        assert!(!script.contains("drawtext"), "no drawtext when disabled");
        // v0 is head instead of [namecard].
        assert!(script.contains("[v0][v1]xfade") || script.contains("[v0]null"),
                "v0-headed chain: {script}");
    }

    #[test]
    fn segment_filter_font_missing_falls_back_to_bg_only() {
        let mut spec = seg_base();
        spec.name_card_font = None;
        let script = build_segment_filter(&spec);
        assert!(script.contains("color=c=0x1e293b"), "still has bg");
        assert!(!script.contains("drawtext"), "no drawtext without font");
    }

    #[test]
    fn segment_cmd_omits_audio() {
        let args = build_segment_cmd(&seg_base());
        assert!(args.iter().any(|a| a == "-an"), "silent output: {args:?}");
        assert!(!args.iter().any(|a| a.contains("loudnorm")));
    }

    #[test]
    fn segment_duration_computes_with_card() {
        // 1.5 card + 3*4.75 photo - 1 card_gap*0.6 - 2 photo_gaps*0.6
        // = 1.5 + 14.25 - 0.6 - 1.2 = 13.95
        let d = seg_base().computed_duration();
        assert!((d - 13.95).abs() < 1e-6, "expected 13.95, got {d}");
    }

    fn concat_base() -> ConcatSpec {
        ConcatSpec {
            segments: vec!["seg0.mp4".into(), "seg1.mp4".into(), "seg2.mp4".into()],
            segment_durations: vec![30.0, 30.0, 30.0],
            music_track: Some("track.mp3".into()),
            output: "class.mp4".into(),
            filter_script: "concat.filter".into(),
            width: 1920,
            height: 1080,
            fps: 30,
            transition_sec: 0.6,
            video_bitrate_kbps: 6000,
            encoder: HwEncoder::OpenH264,
            emit_progress: false,
        }
    }

    #[test]
    fn concat_filter_chains_segments() {
        let script = build_concat_filter(&concat_base());
        for i in 0..3 {
            assert!(script.contains(&format!("[{i}:v]setpts=PTS-STARTPTS")),
                    "seg {i} norm: {script}");
            assert!(script.contains(&format!("[s{i}]")), "s{i} label: {script}");
        }
        // Two xfades between three segments.
        assert!(script.matches("xfade=transition=").count() == 2,
                "two xfades: {script}");
        // Offsets: first at 30-0.6=29.4, second at 29.4+30-0.6=58.8
        assert!(script.contains("offset=29.400"), "first offset: {script}");
        assert!(script.contains("offset=58.800"), "second offset: {script}");
    }

    #[test]
    fn concat_filter_includes_music_when_track_present() {
        let script = build_concat_filter(&concat_base());
        // 3 segments + 1 music input → music at index 3
        assert!(script.contains("[3:a]"), "music input: {script}");
        assert!(script.contains("loudnorm"), "audio normalized: {script}");
        assert!(script.contains("[aout]"), "aout label: {script}");
    }

    #[test]
    fn concat_filter_no_audio_without_music() {
        let mut spec = concat_base();
        spec.music_track = None;
        let script = build_concat_filter(&spec);
        assert!(!script.contains("[aout]"));
        assert!(!script.contains("loudnorm"));
    }

    #[test]
    fn concat_cmd_maps_audio_only_with_music() {
        let args = build_concat_cmd(&concat_base());
        assert!(args.windows(2).any(|w| w[0] == "-map" && w[1] == "[aout]"));
        assert!(args.iter().any(|a| a == "aac"));

        let mut silent = concat_base();
        silent.music_track = None;
        let sargs = build_concat_cmd(&silent);
        assert!(!sargs.windows(2).any(|w| w[0] == "-map" && w[1] == "[aout]"));
    }

    #[test]
    fn concat_computed_duration_matches_math() {
        // 3*30 - 2*0.6 = 88.8
        let d = concat_base().computed_duration();
        assert!((d - 88.8).abs() < 1e-6, "expected 88.8, got {d}");
    }
}
