//! FFmpeg render engine for the Graduation Day pipeline.
//!
//! Two public entry points:
//! - [`build_reel_cmd`] — assembles the arg list for the 15-min
//!   year-in-review reel: photos + music.
//! - [`build_per_child_cmd`] — the 2-min per-child slideshow.
//!
//! Rendering itself is dispatched to a spawned FFmpeg sidecar in
//! [`commands`]; this module is pure "shape the argv" so it's
//! testable without a live FFmpeg install. The caller is responsible
//! for writing the returned filter-graph script to `spec.filter_script`
//! before spawning FFmpeg — see [`build_filter_script`].
//!
//! # v2.4.0 pipeline: per-photo inputs + rotating xfade transitions
//!
//! Prior versions used the concat demuxer (one stream of stills) which
//! meant hard cuts between photos. v2.4.0 gives each photo its own
//! `-loop 1 -t D -i` input, applies Ken Burns individually, and chains
//! them with `xfade` transitions. The transition kind cycles through a
//! rotation (slide/wipe/dissolve/circle/zoom) so the reel feels alive.
//!
//! Filter graph size scales as O(N) with N photos and easily exceeds
//! command-line arg limits at 100+ photos, so we write the entire
//! `-filter_complex` graph to a script file and pass it via
//! `-filter_complex_script`.
//!
//! # VideoToolbox / Media Foundation gotchas
//! Both hardware encoders have quirks we code around:
//! - Filter chain **must** end with `format=yuv420p` per photo before
//!   any xfade — mixing pixel formats confuses xfade too.
//! - `-bf 0` (no B-frames) — VT's B-frame handling is unreliable.
//! - `-profile:v main` **as a string** — passing integers to VT is
//!   silently reinterpreted as `-level` on recent FFmpeg builds and
//!   rejects 1080p at encoder-open ("Invalid Profile/Level"). See
//!   v2.3.4 fix.
//! - `-level 4.0` explicitly pinned so VT can't auto-pick too low.
//! - Below ~2 Mbps target rate, VT ignores `-b:v` — use `-q:v 50` for
//!   a constant-quality mode instead.

use std::path::{Path, PathBuf};

#[cfg(test)]
use crate::graduation::concat::ConcatEntry;

/// Which encoder to target. Chosen at runtime based on OS.
#[derive(Debug, Clone, Copy)]
pub enum HwEncoder {
    /// macOS: `h264_videotoolbox`.
    VideoToolbox,
    /// Windows: `h264_mf`.
    MediaFoundation,
    /// Everywhere else: bundled software fallback `libopenh264`.
    OpenH264,
}

impl HwEncoder {
    pub fn for_current_os() -> Self {
        #[cfg(target_os = "macos")] { HwEncoder::VideoToolbox }
        #[cfg(target_os = "windows")] { HwEncoder::MediaFoundation }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))] { HwEncoder::OpenH264 }
    }

    fn ffmpeg_codec(self) -> &'static str {
        match self {
            HwEncoder::VideoToolbox => "h264_videotoolbox",
            HwEncoder::MediaFoundation => "h264_mf",
            HwEncoder::OpenH264 => "libopenh264",
        }
    }
}

/// The transition rotation. Each xfade between consecutive photos
/// picks the next kind in this list (wrapping). Chosen for visual
/// variety without being gimmicky — mostly slides/wipes, a couple of
/// dissolves/circles/zooms for spice.
const TRANSITIONS: &[&str] = &[
    "slideleft",
    "slideup",
    "wiperight",
    "dissolve",
    "slideright",
    "slidedown",
    "wipeleft",
    "circleopen",
    "zoomin",
];

/// High-level render specification.
#[derive(Debug, Clone)]
pub struct ReelSpec {
    /// Curated photo paths, in display order. Each photo becomes its
    /// own `-loop 1 -t D -i` input.
    pub photos: Vec<PathBuf>,
    /// Music track to mix under the reel. If None, the video ships silent.
    pub music_track: Option<PathBuf>,
    /// Final output file path (typically ending in .mp4 and living
    /// under the user's reel folder).
    pub output: PathBuf,
    /// Path where the caller must write the filter-graph script (returned
    /// from [`build_filter_script`]) before spawning FFmpeg. The argv
    /// references this path via `-filter_complex_script`.
    pub filter_script: PathBuf,
    /// Target width / height. 1920x1080 for the reel, 1280x720 for the
    /// per-child videos.
    pub width: u32,
    pub height: u32,
    /// Visible display seconds per photo — before transition overlaps.
    pub avg_photo_sec: f64,
    /// Duration of each xfade transition. 0.6s is the v2.4.0 default;
    /// clamped to `avg_photo_sec * 0.4` so transitions never dominate
    /// a photo's on-screen time.
    pub transition_sec: f64,
    /// Approximate total video duration in seconds. Used to time the
    /// audio fade-out so it lands 3s before the end regardless of
    /// whether this is a 15-min reel or a 2-min per-child video.
    pub total_duration_sec: f64,
    /// Frames per second of the output.
    pub fps: u32,
    /// Target video bitrate. Falls back to constant-quality below
    /// 2 Mbps on VideoToolbox — see module docstring.
    pub video_bitrate_kbps: u32,
    /// Encoder selection.
    pub encoder: HwEncoder,
    /// Whether to emit `-progress pipe:1` for streaming progress. On
    /// during real renders, off for tests.
    pub emit_progress: bool,
}

impl ReelSpec {
    /// Effective transition duration, clamped so it can never eat more
    /// than 40% of a photo's hold time (a transition longer than that
    /// makes the photo mostly invisible).
    fn effective_transition(&self) -> f64 {
        let cap = self.avg_photo_sec * 0.4;
        self.transition_sec.min(cap).max(0.0)
    }

    /// Computed total video duration = N*D - (N-1)*X.
    /// Used mainly by the audio-fade math.
    pub fn computed_duration(&self) -> f64 {
        let n = self.photos.len() as f64;
        let d = self.avg_photo_sec;
        let x = self.effective_transition();
        (n * d - (n - 1.0).max(0.0) * x).max(0.0)
    }
}

/// Assemble the filter_complex script string. The caller must write
/// this to `spec.filter_script` before spawning FFmpeg. Separated from
/// [`build_reel_cmd`] so it stays pure and unit-testable.
///
/// Graph shape (per photo i):
///   `[i:v] split[a_i][b_i];`
///   `[a_i] scale=cover, crop, gblur, hue, lutyuv, setsar [bg_i];`
///   `[b_i] scale=fit, setsar [fg_i];`
///   `[bg_i][fg_i] overlay=center, zoompan, format=yuv420p [v_i];`
///
/// Then chain N-1 xfade nodes between consecutive `[v_i]` streams,
/// with offsets `(i+1)*(D-X)` where D=avg_photo_sec and X=xfade duration.
/// The transition kind rotates through [`TRANSITIONS`].
///
/// Final output label is `[vout]`.
pub fn build_filter_script(spec: &ReelSpec) -> String {
    let n = spec.photos.len();
    let w = spec.width;
    let h = spec.height;
    let fps = spec.fps;
    let d = spec.avg_photo_sec;
    let x = spec.effective_transition();
    let total_frames = (d * fps as f64).round().max(1.0) as u64;

    let mut out = String::with_capacity(n * 512);

    // Per-photo Ken Burns chain: split → bg (blur+darken) + fg (fit)
    // → overlay → zoompan → yuv420p.
    //
    // v2.4.0 zoompan is `d=1:fps={fps}` (one output frame per input
    // frame). This differs from the concat-demuxer pipeline where
    // zoompan produced d=hold_frames output frames from a single input
    // frame — with per-photo `-loop 1 -framerate fps -t D` inputs, each
    // input already emits fps*D frames, so d>1 would multiply frames
    // and blow up runtime by fps×. Zoom is now driven by the monotonic
    // `on` (output-frame index) so it grows linearly from 1.0 to 1.10
    // across each photo's total_frames span.
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

    // xfade chain. Nothing to chain if there's a single photo.
    if n <= 1 {
        // Just alias v0 as vout so downstream mapping stays uniform.
        out.push_str("[v0]null[vout]");
    } else {
        // First xfade takes [v0][v1] into [t1]; each subsequent xfade
        // takes [t_prev][v_i] into [t_i]. Final xfade output is [vout].
        for i in 1..n {
            let prev = if i == 1 { "v0".to_string() } else { format!("t{}", i - 1) };
            let dst = if i == n - 1 { "vout".to_string() } else { format!("t{}", i) };
            let transition = TRANSITIONS[(i - 1) % TRANSITIONS.len()];
            let offset = (i as f64) * (d - x);
            out.push_str(&format!(
                "[{prev}][v{i}]xfade=transition={t}:duration={x:.3}:offset={o:.3}[{dst}];",
                prev = prev, i = i, t = transition, x = x, o = offset, dst = dst,
            ));
        }
        // Strip trailing ';' — filter_complex_script tolerates it, but
        // cleaner without.
        if out.ends_with(';') { out.pop(); }
    }

    out
}

/// Build the FFmpeg argv for the reel. Does not include the binary name
/// itself — that's supplied by the sidecar spawn helper.
///
/// The caller MUST write [`build_filter_script`]'s output to
/// `spec.filter_script` before spawning; the argv references it via
/// `-filter_complex_script`.
pub fn build_reel_cmd(spec: &ReelSpec) -> Vec<String> {
    let mut args: Vec<String> = Vec::with_capacity(64 + spec.photos.len() * 6);
    args.push("-hide_banner".into());
    args.push("-y".into()); // Always overwrite the .tmp output.
    if spec.emit_progress {
        args.push("-progress".into());
        args.push("pipe:1".into());
        args.push("-nostats".into());
    }

    // Photo inputs: `-loop 1 -framerate {fps} -t {D} -i photo.jpg`
    // Each still is repeated at output fps for D seconds, feeding
    // enough frames for zoompan and the outgoing/incoming xfade
    // overlap window.
    for photo in &spec.photos {
        args.push("-loop".into());
        args.push("1".into());
        args.push("-framerate".into());
        args.push(spec.fps.to_string());
        args.push("-t".into());
        args.push(format!("{:.3}", spec.avg_photo_sec));
        args.push("-i".into());
        args.push(photo.to_string_lossy().into_owned());
    }

    // Music (optional) is the last input. `-stream_loop -1` keeps the
    // audio rolling for the full video duration; `-shortest` at the
    // encoder end caps it to the video length.
    let music_input_index = spec.photos.len(); // Position in the -i list.
    if let Some(music) = &spec.music_track {
        args.push("-stream_loop".into());
        args.push("-1".into());
        args.push("-i".into());
        args.push(music.to_string_lossy().into_owned());
    }

    // Filter graph via script file. Some FFmpeg builds don't ship the
    // newer `-filter_complex_script` option; the `-/filter_complex`
    // prefix syntax ("read arg from file") works on all builds since
    // the arg-source prefix predates the dedicated flag.
    args.push("-/filter_complex".into());
    args.push(spec.filter_script.to_string_lossy().into_owned());

    args.push("-map".into());
    args.push("[vout]".into());

    if spec.music_track.is_some() {
        // Audio: normalise to broadcast loudness, resample to 48 kHz
        // (loudnorm's internal rate is 192 kHz; without an explicit
        // aresample the encoder receives a non-standard rate), then
        // fade out 3s before end. `-shortest` caps audio at video
        // length so we don't accumulate silent tail.
        let fade_start = (spec.total_duration_sec - 3.0).max(1.0);
        args.push("-map".into());
        args.push(format!("{}:a:0", music_input_index));
        args.push("-af".into());
        args.push(format!(
            "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,afade=t=out:st={fade_start:.1}:d=3"
        ));
        args.push("-ar".into());
        args.push("48000".into());
        args.push("-c:a".into());
        args.push("aac".into());
        args.push("-b:a".into());
        args.push("192k".into());
        args.push("-shortest".into());
    }

    // Video encode. See gotchas at top of module.
    args.push("-c:v".into());
    args.push(spec.encoder.ffmpeg_codec().into());
    args.push("-pix_fmt".into());
    args.push("yuv420p".into());
    args.push("-r".into());
    args.push(spec.fps.to_string());
    match spec.encoder {
        HwEncoder::VideoToolbox => {
            // See module docstring — string form + explicit level.
            args.push("-profile:v".into());
            args.push("main".into());
            args.push("-level".into());
            args.push("4.0".into());
            args.push("-bf".into());
            args.push("0".into());
            if spec.video_bitrate_kbps < 2000 {
                // VT ignores -b:v below ~2 Mbps; use constant quality.
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
            args.push("-rc_mode".into());
            args.push("cbr".into());
        }
        HwEncoder::OpenH264 => {
            args.push("-b:v".into());
            args.push(format!("{}k", spec.video_bitrate_kbps));
        }
    }
    args.push("-movflags".into());
    args.push("+faststart".into());
    // Force MP4 muxer explicitly. Our output filename ends in `.mp4.tmp`
    // during atomic-publish and FFmpeg can't infer the muxer from `.tmp`.
    args.push("-f".into());
    args.push("mp4".into());
    args.push(spec.output.to_string_lossy().into_owned());

    args
}

/// Convenience wrapper that mirrors `build_reel_cmd` but with the
/// 2-min per-child defaults baked in (720p, 3s per photo, 2 Mbps).
pub fn build_per_child_cmd(
    photos: Vec<PathBuf>,
    music: Option<&Path>,
    output: &Path,
    filter_script: &Path,
    total_duration_sec: f64,
) -> Vec<String> {
    let spec = ReelSpec {
        photos,
        music_track: music.map(|p| p.to_path_buf()),
        output: output.to_path_buf(),
        filter_script: filter_script.to_path_buf(),
        width: 1280,
        height: 720,
        avg_photo_sec: 3.0,
        transition_sec: 0.6,
        total_duration_sec,
        fps: 30,
        video_bitrate_kbps: 2000,
        encoder: HwEncoder::for_current_os(),
        emit_progress: true,
    };
    build_reel_cmd(&spec)
}

/// Build a reel spec appropriate for the 15-minute year-in-review.
pub fn default_reel_spec(
    photos: Vec<PathBuf>,
    music: Option<PathBuf>,
    output: PathBuf,
    filter_script: PathBuf,
    avg_photo_sec: f64,
    total_duration_sec: f64,
) -> ReelSpec {
    ReelSpec {
        photos,
        music_track: music,
        output,
        filter_script,
        width: 1920,
        height: 1080,
        avg_photo_sec,
        transition_sec: 0.6,
        total_duration_sec,
        fps: 30,
        video_bitrate_kbps: 6000, // Broadcast-quality 1080p30.
        encoder: HwEncoder::for_current_os(),
        emit_progress: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_spec() -> ReelSpec {
        ReelSpec {
            photos: vec!["/tmp/p1.jpg".into(), "/tmp/p2.jpg".into(), "/tmp/p3.jpg".into()],
            music_track: Some("/tmp/song.mp3".into()),
            output: "/tmp/out.mp4".into(),
            filter_script: "/tmp/filter.script".into(),
            width: 1920, height: 1080,
            avg_photo_sec: 3.0, transition_sec: 0.6,
            total_duration_sec: 900.0, fps: 30,
            video_bitrate_kbps: 6000,
            encoder: HwEncoder::OpenH264,
            emit_progress: false,
        }
    }

    #[test]
    fn reel_cmd_uses_per_photo_inputs_not_concat() {
        let args = build_reel_cmd(&base_spec());
        // No concat demuxer any more.
        assert!(!args.iter().any(|a| a == "concat"),
                "v2.4.0 pipeline replaced concat demuxer with per-photo inputs");
        // One -loop 1 per photo (3 photos → 3 loops).
        let loops = args.iter().filter(|a| a.as_str() == "1")
            .zip(args.iter().filter(|a| a.as_str() == "-loop"))
            .count();
        assert_eq!(loops, 3, "expected 3 photo inputs, argv was {args:?}");
    }

    #[test]
    fn reel_cmd_maps_audio_when_music_present() {
        let args = build_reel_cmd(&base_spec());
        // Music is input index 3 (after 3 photos).
        assert!(args.windows(2).any(|w| w[0] == "-map" && w[1] == "3:a:0"),
                "expected -map 3:a:0 for music, got {args:?}");
        assert!(args.iter().any(|a| a.contains("loudnorm")));
    }

    #[test]
    fn reel_cmd_omits_audio_without_music() {
        let mut spec = base_spec();
        spec.music_track = None;
        let args = build_reel_cmd(&spec);
        assert!(!args.iter().any(|a| a.ends_with(":a:0")));
        assert!(!args.iter().any(|a| a.contains("loudnorm")));
    }

    #[test]
    fn reel_cmd_uses_filter_script() {
        let args = build_reel_cmd(&base_spec());
        let idx = args.iter().position(|a| a == "-/filter_complex").unwrap();
        assert_eq!(args[idx + 1], "/tmp/filter.script");
        // Also assert the video-out label is mapped.
        assert!(args.windows(2).any(|w| w[0] == "-map" && w[1] == "[vout]"));
    }

    #[test]
    fn per_child_defaults() {
        let args = build_per_child_cmd(
            vec!["/tmp/p1.jpg".into(), "/tmp/p2.jpg".into()],
            None,
            Path::new("/tmp/kid.mp4"),
            Path::new("/tmp/kid.filter"),
            120.0,
        );
        assert!(args.iter().any(|a| a == "/tmp/kid.mp4"));
        assert!(args.iter().any(|a| a == "/tmp/kid.filter"));
    }

    #[test]
    fn fade_start_scales_with_duration() {
        let args = build_reel_cmd(&base_spec());
        let af = args.iter().find(|a| a.contains("afade")).unwrap();
        assert!(af.contains("st=897.0"), "reel fade should start at 897s, got {af}");

        let per_child_args = build_per_child_cmd(
            vec!["/tmp/p1.jpg".into(), "/tmp/p2.jpg".into()],
            Some(Path::new("/tmp/song.mp3")),
            Path::new("/tmp/kid.mp4"),
            Path::new("/tmp/kid.filter"),
            120.0,
        );
        let af2 = per_child_args.iter().find(|a| a.contains("afade")).unwrap();
        assert!(af2.contains("st=117.0"), "per-child fade should start at 117s, got {af2}");
    }

    #[test]
    fn filter_script_has_per_photo_ken_burns() {
        let script = build_filter_script(&base_spec());
        // Each of 3 photos gets its own bg/fg/overlay/zoompan chain.
        for i in 0..3 {
            assert!(script.contains(&format!("[{i}:v]split")),
                    "missing split for photo {i}: {script}");
            assert!(script.contains(&format!("[bg{i}]")),
                    "missing bg label for photo {i}: {script}");
            assert!(script.contains(&format!("[fg{i}]")),
                    "missing fg label for photo {i}: {script}");
            assert!(script.contains(&format!("[v{i}]")),
                    "missing per-photo video label {i}: {script}");
        }
        // Backdrop composition primitives from v2.3.1 still present.
        assert!(script.contains("force_original_aspect_ratio=increase"));
        assert!(script.contains("force_original_aspect_ratio=decrease"));
        assert!(script.contains("gblur=sigma=25"));
        // Ken Burns zoompan.
        assert!(script.contains("x='iw/2-(iw/zoom/2)'"));
        assert!(script.contains("y='ih/2-(ih/zoom/2)'"));
    }

    #[test]
    fn filter_script_chains_xfade_transitions() {
        let script = build_filter_script(&base_spec());
        // 3 photos → 2 transitions. Both xfade nodes must exist, with
        // distinct transition kinds (rotation) and monotonic offsets.
        assert!(script.contains("xfade=transition=slideleft"),
                "expected first transition = slideleft: {script}");
        assert!(script.contains("xfade=transition=slideup"),
                "expected second transition = slideup: {script}");
        // Offsets: (i+1)*(D-X) with D=3.0, X=0.6 → 2.4, 4.8.
        assert!(script.contains("offset=2.400"), "missing first offset 2.4: {script}");
        assert!(script.contains("offset=4.800"), "missing second offset 4.8: {script}");
        // Final label always [vout].
        assert!(script.ends_with("[vout]"), "final label should be [vout]: {script}");
    }

    #[test]
    fn filter_script_rotation_covers_all_transitions_over_10_photos() {
        // With 10 photos → 9 xfades → should use all 9 unique transitions.
        let spec = ReelSpec {
            photos: (0..10).map(|i| PathBuf::from(format!("/tmp/p{i}.jpg"))).collect(),
            ..base_spec()
        };
        let script = build_filter_script(&spec);
        for t in TRANSITIONS {
            assert!(script.contains(&format!("xfade=transition={t}")),
                    "transition '{t}' missing from 10-photo rotation");
        }
    }

    #[test]
    fn filter_script_handles_single_photo() {
        // Edge case: only 1 photo → no xfade nodes, but still emit vout.
        let spec = ReelSpec {
            photos: vec!["/tmp/only.jpg".into()],
            ..base_spec()
        };
        let script = build_filter_script(&spec);
        assert!(!script.contains("xfade"), "single-photo reel should have no xfade");
        assert!(script.contains("[v0]"), "still need v0 chain: {script}");
        assert!(script.ends_with("[vout]"), "must terminate at [vout]: {script}");
    }

    #[test]
    fn transition_duration_clamped_to_photo_fraction() {
        // Absurd: 5s transitions on 2s photos would leave photos invisible.
        // Clamp to avg_photo_sec * 0.4.
        let spec = ReelSpec {
            avg_photo_sec: 2.0,
            transition_sec: 5.0,
            ..base_spec()
        };
        let x = spec.effective_transition();
        assert!(x <= 0.8 + 1e-9, "expected clamp ≤ 0.8, got {x}");
    }

    #[test]
    fn computed_duration_matches_xfade_math() {
        // N=3, D=3.0, X=0.6 → 3*3 - 2*0.6 = 7.8
        let dur = base_spec().computed_duration();
        assert!((dur - 7.8).abs() < 1e-6, "expected 7.8, got {dur}");
    }

    #[test]
    fn audio_forces_48khz_output() {
        let args = build_reel_cmd(&base_spec());
        assert!(args.windows(2).any(|w| w[0] == "-ar" && w[1] == "48000"));
        let af = args.iter().find(|a| a.contains("loudnorm")).unwrap();
        assert!(af.contains("aresample=48000"), "aresample missing: {af}");
    }

    #[test]
    fn videotoolbox_uses_string_main_profile_and_pinned_level() {
        let mut spec = base_spec();
        spec.encoder = HwEncoder::VideoToolbox;
        let args = build_reel_cmd(&spec);
        let pidx = args.iter().position(|a| a == "-profile:v").unwrap();
        assert_eq!(args[pidx + 1], "main");
        let lidx = args.iter().position(|a| a == "-level").unwrap();
        assert_eq!(args[lidx + 1], "4.0");
        assert!(args.windows(2).any(|w| w[0] == "-bf" && w[1] == "0"));
    }

    #[test]
    fn zoompan_frame_count_scales_with_hold() {
        // v2.4.0: zoompan uses d=1:fps={fps} (1-in-1-out) with on-based
        // linear zoom, since per-photo -loop inputs already emit fps*D
        // frames. The zoom span factor should equal round(D*fps).
        let mut spec = base_spec();
        spec.avg_photo_sec = 2.5;
        spec.fps = 30;
        let script = build_filter_script(&spec);
        // 2.5 * 30 = 75 — appears as the zoom denominator.
        assert!(script.contains("on/75"),
                "expected zoom span 75 for 2.5s @ 30fps: {script}");
        // And d=1 (not d=75) so zoompan is 1-in-1-out.
        assert!(script.contains("d=1:"),
                "zoompan should use d=1 with per-photo inputs: {script}");
    }

    /// Concat entries silence -Wunused-import on debug builds where the
    /// full pipeline isn't wired yet.
    #[test]
    fn concat_entry_used() {
        let _e = ConcatEntry { path: PathBuf::from("/x"), duration_sec: 1.0 };
    }
}
