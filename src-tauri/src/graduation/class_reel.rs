//! Class Reel feature (v3.3.0 → v3.5.0).
//!
//! Combines every graduating kid's photos into a single 10-12 min MP4.
//! Each kid gets ~30s: a 1.5s name card, then N photos xfade-chained.
//!
//! # Two-pass architecture
//!
//! **Pass 1 — per-kid segment:** For each kid, render a silent 1080p
//! MP4 to the cache dir: pre-rendered name-card PNG + photo inputs
//! filter-chained through xfade. Segments are ~30s each.
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
//! # Name cards (v3.5.0 redesign)
//!
//! In v3.3.0 / v3.4.0 the name card was rendered inline via FFmpeg's
//! `color` source + `drawtext` filter. That approach broke on macOS
//! sidecars built without `libfreetype` (drawtext is a compile-time
//! optional filter). It also produced OS-dependent visuals (different
//! system font per platform).
//!
//! v3.5.0 pre-renders each kid's name card as a PNG in Rust using
//! `ab_glyph` + a bundled Inter-Variable font (OFL-1.1). The PNG is
//! fed to FFmpeg as a `-loop 1 -t <dur> -i namecard.png` input. This:
//!
//! - Works on every FFmpeg build — no `drawtext` filter needed.
//! - Deterministic visuals across macOS / Windows / Linux (one font).
//! - No runtime capability probing or filter-graph branching.
//! - No system-font resolution dance.

use std::path::{Path, PathBuf};

use ab_glyph::{Font, FontRef, PxScale, ScaleFont};
use image::{Rgba, RgbaImage};

use crate::graduation::engine::HwEncoder;

/// Bundled Inter Variable font (SIL Open Font License v1.1).
/// Embedded at compile time so name-card rendering never depends on
/// runtime resource-path resolution and works identically in tests.
const NAME_CARD_FONT_BYTES: &[u8] =
    include_bytes!("../../resources/fonts/Inter-Variable.ttf");

/// Slate background RGB matching the app's UI ink/900 (0x1e293b).
const NAME_CARD_BG: Rgba<u8> = Rgba([0x1e, 0x29, 0x3b, 0xff]);
const NAME_CARD_FG: Rgba<u8> = Rgba([0xff, 0xff, 0xff, 0xff]);
/// Semi-transparent black drop shadow — lifts the text visually.
const NAME_CARD_SHADOW: Rgba<u8> = Rgba([0x00, 0x00, 0x00, 140]);
const NAME_CARD_SHADOW_OFFSET_PX: i32 = 3;

/// Font size as a fraction of card height, with an auto-shrink floor.
/// Matches the previous drawtext heuristic (`h * 0.10`) so v3.4.0 and
/// v3.5.0 name cards feel visually consistent to users.
const NAME_CARD_FONT_FRACTION: f32 = 0.10;
const NAME_CARD_FONT_MIN_PX: f32 = 24.0;
/// Maximum horizontal extent (fraction of card width) before we
/// auto-shrink the font size. Long names (e.g. "Alessandra Buitrago
/// Rodriguez") get scaled down instead of running off-frame.
const NAME_CARD_MAX_WIDTH_FRACTION: f32 = 0.85;

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
    /// Path to the pre-rendered name-card PNG (relative to cwd).
    /// `None` skips the name card entirely — segment starts on the
    /// first photo. In v3.5.0 the caller renders the PNG via
    /// [`render_name_card_png`] before spawning FFmpeg.
    pub name_card_png: Option<PathBuf>,
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

/// Render one kid's name card to a PNG on disk.
///
/// Uses the bundled Inter Variable font (compile-time embedded) so
/// this call has no runtime dependency on the OS, the FFmpeg sidecar's
/// build-time flags, or any font resolution logic. Output is a slate
/// (`NAME_CARD_BG`) `w × h` PNG with the display name centered in
/// white with a soft drop shadow.
///
/// Long names auto-shrink so text stays inside
/// `NAME_CARD_MAX_WIDTH_FRACTION` of the card width. Below
/// `NAME_CARD_FONT_MIN_PX` we stop shrinking (an extremely long name
/// will just clip — a name-card is not a novel).
pub fn render_name_card_png(
    display_name: &str,
    width: u32,
    height: u32,
    out_path: &Path,
) -> Result<(), String> {
    let font = FontRef::try_from_slice(NAME_CARD_FONT_BYTES)
        .map_err(|e| format!("load bundled Inter font: {e}"))?;

    // Start at target size and shrink until text width ≤ 85% of card
    // width, or we hit the floor. Empty / whitespace-only names still
    // render as a blank slate — same visual as the v3.4.0 fallback.
    let target_px = (height as f32) * NAME_CARD_FONT_FRACTION;
    let max_text_w = (width as f32) * NAME_CARD_MAX_WIDTH_FRACTION;
    let mut px = target_px;
    let mut text_w = measure_text_width(&font, PxScale::from(px), display_name);
    while text_w > max_text_w && px > NAME_CARD_FONT_MIN_PX {
        let shrink = ((max_text_w / text_w).min(0.98)).max(0.5);
        px = (px * shrink).max(NAME_CARD_FONT_MIN_PX);
        text_w = measure_text_width(&font, PxScale::from(px), display_name);
    }
    let scale = PxScale::from(px);
    let scaled = font.as_scaled(scale);

    // Baseline placement: center visually using cap-height offset,
    // not the raw ascent/descent (which is dominated by diacritics
    // and descenders and would push text upward).
    let baseline_y = (height as f32) / 2.0 + scaled.ascent() * 0.35;
    let start_x = ((width as f32) - text_w).max(0.0) / 2.0;

    let mut img = RgbaImage::from_pixel(width, height, NAME_CARD_BG);
    // Shadow first (below-right), then main glyph on top.
    draw_text_line(
        &mut img, &font, scale,
        start_x + NAME_CARD_SHADOW_OFFSET_PX as f32,
        baseline_y + NAME_CARD_SHADOW_OFFSET_PX as f32,
        display_name, NAME_CARD_SHADOW,
    );
    draw_text_line(
        &mut img, &font, scale, start_x, baseline_y, display_name, NAME_CARD_FG,
    );

    img.save(out_path)
        .map_err(|e| format!("save name-card PNG: {e}"))?;
    Ok(())
}

fn measure_text_width<F: Font>(font: &F, scale: PxScale, text: &str) -> f32 {
    let scaled = font.as_scaled(scale);
    text.chars()
        .map(|c| scaled.h_advance(scaled.glyph_id(c)))
        .sum()
}

fn draw_text_line<F: Font>(
    img: &mut RgbaImage,
    font: &F,
    scale: PxScale,
    start_x: f32,
    baseline_y: f32,
    text: &str,
    color: Rgba<u8>,
) {
    let scaled = font.as_scaled(scale);
    let mut x = start_x;
    let img_w = img.width() as i32;
    let img_h = img.height() as i32;
    for c in text.chars() {
        let glyph_id = scaled.glyph_id(c);
        let glyph = glyph_id.with_scale_and_position(scale, ab_glyph::point(x, baseline_y));
        if let Some(outlined) = font.outline_glyph(glyph) {
            let bounds = outlined.px_bounds();
            outlined.draw(|dx, dy, coverage| {
                let px = bounds.min.x as i32 + dx as i32;
                let py = bounds.min.y as i32 + dy as i32;
                if px < 0 || py < 0 || px >= img_w || py >= img_h {
                    return;
                }
                let alpha = coverage * (color[3] as f32 / 255.0);
                if alpha <= 0.0 {
                    return;
                }
                let base = *img.get_pixel(px as u32, py as u32);
                let inv = 1.0 - alpha;
                let out = Rgba([
                    (color[0] as f32 * alpha + base[0] as f32 * inv) as u8,
                    (color[1] as f32 * alpha + base[1] as f32 * inv) as u8,
                    (color[2] as f32 * alpha + base[2] as f32 * inv) as u8,
                    255,
                ]);
                img.put_pixel(px as u32, py as u32, out);
            });
        }
        x += scaled.h_advance(glyph_id);
    }
}

/// Build the filter-graph script for a single kid segment (name card
/// + photos xfade-chained). Output label is always `[vout]`.
///
/// v3.5.0 input layout:
/// - If `name_card_png` is `Some`, that PNG is FFmpeg input index 0
///   (looped for `name_card_sec`) and photos take indices 1..=N.
/// - If `name_card_png` is `None`, photos take indices 0..N (no card).
pub fn build_segment_filter(spec: &SegmentSpec) -> String {
    let n = spec.photos.len();
    let w = spec.width;
    let h = spec.height;
    let fps = spec.fps;
    let d = spec.photo_sec;
    let x = spec.effective_transition();
    let has_card = spec.name_card_sec > 0.0 && spec.name_card_png.is_some();
    // Photo input index offset — 1 when the name card takes index 0.
    let base = if has_card { 1 } else { 0 };

    let mut out = String::with_capacity(n * 512 + 512);

    // Name card: normalise the pre-rendered PNG input to yuv420p at
    // the target fps. No color source, no drawtext — the visual is
    // baked into the PNG at render time.
    if has_card {
        out.push_str(&format!(
            "[0:v]scale=w={w}:h={h},setsar=1,fps={fps},format=yuv420p[namecard];",
            w = w, h = h, fps = fps,
        ));
    }

    // Per-photo static chain (mirrors engine.rs::build_filter_script).
    // v3.4.0: Ken Burns zoompan removed on user request — photos are
    // now shown static in-frame; xfade transitions between photos are
    // preserved. v3.5.0: photo inputs are at FFmpeg indices
    // `base + i` (base = 1 when the name card takes index 0).
    for i in 0..n {
        let in_idx = base + i;
        out.push_str(&format!(
            "[{in_idx}:v]split[a{i}][b{i}];\
             [a{i}]scale=w={w}:h={h}:force_original_aspect_ratio=increase,\
                   crop={w}:{h},gblur=sigma=25,hue=s=0.7,\
                   lutyuv=y='val*0.65',setsar=1[bg{i}];\
             [b{i}]scale=w={w}:h={h}:force_original_aspect_ratio=decrease,\
                   setsar=1[fg{i}];\
             [bg{i}][fg{i}]overlay=(W-w)/2:(H-h)/2,\
                   fps={fps},format=yuv420p[v{i}];",
            in_idx = in_idx, i = i, w = w, h = h, fps = fps,
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
///
/// v3.5.0: if `name_card_png` is set, it is prepended as FFmpeg input
/// index 0 (looped for `name_card_sec`); photos then take indices
/// 1..=N. This matches [`build_segment_filter`].
pub fn build_segment_cmd(spec: &SegmentSpec) -> Vec<String> {
    let mut args: Vec<String> = Vec::with_capacity(24 + spec.photos.len() * 6);
    args.push("-hide_banner".into());
    args.push("-y".into());
    if spec.emit_progress {
        args.push("-progress".into());
        args.push("pipe:1".into());
        args.push("-nostats".into());
    }

    // Name-card PNG as input 0 when enabled.
    if spec.name_card_sec > 0.0 {
        if let Some(png) = &spec.name_card_png {
            args.push("-loop".into());
            args.push("1".into());
            args.push("-framerate".into());
            args.push(spec.fps.to_string());
            args.push("-t".into());
            args.push(format!("{:.3}", spec.name_card_sec));
            args.push("-i".into());
            args.push(png.to_string_lossy().into_owned());
        }
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
            name_card_png: Some("namecard.png".into()),
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
    fn segment_filter_uses_png_namecard_and_shifts_photo_indices() {
        let script = build_segment_filter(&seg_base());
        // v3.5.0: no more color= or drawtext — name card is PNG input 0.
        assert!(!script.contains("color=c="), "color= source removed: {script}");
        assert!(!script.contains("drawtext"), "drawtext removed: {script}");
        assert!(script.contains("[0:v]scale="),
                "name-card PNG normalised from input 0: {script}");
        assert!(script.contains("[namecard]"), "namecard label: {script}");
        // Three photo chains at indices 1..=3 (shifted by name card).
        for (photo_idx, in_idx) in (0..3).zip(1..=3) {
            assert!(script.contains(&format!("[{in_idx}:v]split")),
                    "photo {photo_idx} at input {in_idx}: {script}");
            assert!(script.contains(&format!("[v{photo_idx}]")),
                    "v{photo_idx}: {script}");
        }
        // Terminates at [vout].
        assert!(script.ends_with("[vout]"), "vout: {script}");
    }

    #[test]
    fn segment_filter_without_namecard() {
        let mut spec = seg_base();
        spec.name_card_sec = 0.0;
        let script = build_segment_filter(&spec);
        assert!(!script.contains("[namecard]"), "no namecard node when disabled");
        // Photo inputs start at index 0 again (no shift).
        assert!(script.contains("[0:v]split"),
                "photos start at input 0 when no card: {script}");
    }

    #[test]
    fn segment_filter_skips_namecard_when_png_missing() {
        // Contract: name_card_sec > 0 but name_card_png=None → treat
        // as no card. Prevents mis-configured callers from producing
        // a mis-indexed graph that references input 0 that doesn't exist.
        let mut spec = seg_base();
        spec.name_card_png = None;
        let script = build_segment_filter(&spec);
        assert!(!script.contains("[namecard]"), "no namecard when png absent");
        assert!(script.contains("[0:v]split"),
                "photos start at input 0: {script}");
    }

    #[test]
    fn segment_cmd_prepends_namecard_png_input() {
        let args = build_segment_cmd(&seg_base());
        // First -i should be the name-card PNG.
        let first_i = args.iter().position(|a| a == "-i").unwrap();
        assert_eq!(args[first_i + 1], "namecard.png",
                   "name-card PNG must be input 0: {args:?}");
        // Photo -i args follow.
        let all_i: Vec<&String> = args.iter().enumerate()
            .filter(|(_, a)| a.as_str() == "-i")
            .map(|(idx, _)| &args[idx + 1])
            .collect();
        assert_eq!(all_i.len(), 4, "1 card + 3 photos: {all_i:?}");
        assert_eq!(all_i[1], "p0001.jpg");
    }

    #[test]
    fn render_name_card_png_writes_valid_png() {
        // Smoke test: renderer produces a decodable PNG.
        let tmp = std::env::temp_dir()
            .join(format!("nc-test-{}.png", std::process::id()));
        render_name_card_png("Aarav S.", 320, 180, &tmp).expect("render ok");
        let img = image::open(&tmp).expect("png decodes");
        assert_eq!(img.width(), 320);
        assert_eq!(img.height(), 180);
        // BG pixel (0,0) should be close to slate 0x1e293b — no text there.
        let px = img.to_rgba8().get_pixel(0, 0).0;
        assert_eq!(px[0], 0x1e);
        assert_eq!(px[1], 0x29);
        assert_eq!(px[2], 0x3b);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn render_name_card_png_handles_long_names() {
        // Just verifies no panic / overflow when the name is longer than
        // the width. Auto-shrink kicks in.
        let tmp = std::env::temp_dir()
            .join(format!("nc-long-{}.png", std::process::id()));
        let long = "Alessandra Buitrago-Rodriguez de la Vega";
        render_name_card_png(long, 640, 360, &tmp).expect("render ok");
        assert!(tmp.exists());
        let _ = std::fs::remove_file(&tmp);
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
