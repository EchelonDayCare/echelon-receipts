//! FFmpeg render engine for the Graduation Day pipeline.
//!
//! Two public entry points:
//! - [`build_reel_cmd`] — assembles the arg list for the 15-min
//!   year-in-review reel: photos + music + optional per-chapter title
//!   cards + credits.
//! - [`build_per_child_cmd`] — the 2-min per-child slideshow.
//!
//! Rendering itself is dispatched to a spawned FFmpeg sidecar in
//! [`commands`]; this module is pure "shape the argv" so it's
//! testable without a live FFmpeg install.
//!
//! # VideoToolbox / Media Foundation gotchas
//! Both hardware encoders have quirks we code around:
//! - Filter chain **must** end with `format=yuv420p` — anything else
//!   confuses the videotoolbox uploader.
//! - `-bf 0` (no B-frames) — VT's B-frame handling is unreliable.
//! - `-profile:v 1` (integer for VT: 1 = Main).
//! - Below ~2 Mbps target rate, VT ignores `-b:v` — use `-q:v 50` for
//!   a constant-quality mode instead.
//! - zoompan runs on CPU: keep the pixel format on CPU until the
//!   final `format=yuv420p`, then upload once.

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

/// High-level render specification.
#[derive(Debug, Clone)]
pub struct ReelSpec {
    /// Path to the concat demuxer list file (already written).
    pub concat_list: PathBuf,
    /// Music track to mix under the reel. If None, the video ships silent.
    pub music_track: Option<PathBuf>,
    /// Final output file path (typically ending in .mp4 and living
    /// under the user's reel folder).
    pub output: PathBuf,
    /// Target width / height. 1920x1080 for the reel, 1280x720 for the
    /// per-child videos.
    pub width: u32,
    pub height: u32,
    /// Ken Burns pan-zoom duration per photo in seconds. Should match
    /// the average duration on the concat entries.
    pub avg_photo_sec: f64,
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

/// Build the FFmpeg argv for the reel. Does not include the binary name
/// itself — that's supplied by the sidecar spawn helper.
pub fn build_reel_cmd(spec: &ReelSpec) -> Vec<String> {
    let mut args: Vec<String> = Vec::with_capacity(64);
    args.push("-hide_banner".into());
    args.push("-y".into()); // Always overwrite the .tmp output.
    if spec.emit_progress {
        args.push("-progress".into());
        args.push("pipe:1".into());
        args.push("-nostats".into());
    }
    // Input 0: the photo concat list.
    args.push("-f".into());
    args.push("concat".into());
    args.push("-safe".into());
    args.push("0".into());
    // Photos coming through the concat demuxer can have different pixel
    // dimensions. Without this flag, FFmpeg reinitialises the filter
    // graph on each new frame size, which resets zoompan state and
    // drops frames. Force one graph to service the whole reel.
    args.push("-reinit_filter".into());
    args.push("0".into());
    args.push("-i".into());
    args.push(spec.concat_list.to_string_lossy().into_owned());

    // Input 1: music (if provided). `-stream_loop -1` keeps the audio
    // rolling for the full video duration — the trailing `-shortest`
    // caps it at the video length so we don't accumulate silent tail.
    if let Some(music) = &spec.music_track {
        args.push("-stream_loop".into());
        args.push("-1".into());
        args.push("-i".into());
        args.push(music.to_string_lossy().into_owned());
    }

    // Video filter chain: blurred-backdrop composition + Ken Burns.
    //
    // The v2.3.0 filter used "cover" scaling (`scale=increase,crop`),
    // which fixed the horizontal-stretch bug but produced extreme
    // facial close-ups when portrait selfies were fed into a 16:9
    // output canvas — the middle horizontal band of a portrait photo
    // is exactly at eye level, so heads got chopped and chins cropped.
    //
    // v2.3.1 pipeline (per input photo):
    //   1. Split the source into two streams.
    //   2. BG: scale-to-fill + crop → gblur → desaturate (hue s=0.7)
    //      → darken (lutyuv y=val*0.65).
    //   3. FG: scale-to-fit (letterbox) preserving aspect.
    //   4. Overlay FG on BG at centre.
    //   5. Zoompan on the composite for gentle "breathing" motion; bg
    //      and fg zoom together and the blurred bg absorbs magnification
    //      artefacts so we can zoom without visible pixellation.
    //   6. format=yuv420p for encoder compatibility.
    //
    // Filter choices note: our shipped FFmpeg does not include the
    // `eq` or `boxblur` filters. We use `gblur` (Gaussian blur), `hue`
    // (saturation control), and `lutyuv` (luma scaling) instead, all
    // of which are always present.
    let hold_frames = (spec.avg_photo_sec * spec.fps as f64).round().max(1.0) as u64;
    let vf = format!(
        "split=2[a][b];\
         [a]scale=w={w}:h={h}:force_original_aspect_ratio=increase,\
            crop={w}:{h},\
            gblur=sigma=25,\
            hue=s=0.7,\
            lutyuv=y='val*0.65',\
            setsar=1[bg];\
         [b]scale=w={w}:h={h}:force_original_aspect_ratio=decrease,\
            setsar=1[fg];\
         [bg][fg]overlay=(W-w)/2:(H-h)/2[comp];\
         [comp]zoompan=z='min(zoom+0.0008,1.10)':\
               x='iw/2-(iw/zoom/2)':\
               y='ih/2-(ih/zoom/2)':\
               d={hf}:s={w}x{h}:fps={fps},\
               format=yuv420p",
        w = spec.width,
        h = spec.height,
        fps = spec.fps,
        hf = hold_frames,
    );
    args.push("-filter_complex".into());
    args.push(format!("[0:v]{vf}[v]"));

    args.push("-map".into());
    args.push("[v]".into());
    if spec.music_track.is_some() {
        // Audio: normalise to broadcast loudness, resample to 48 kHz
        // (loudnorm's internal rate is 192 kHz; without an explicit
        // aresample the encoder receives a non-standard rate and
        // emits 96 kHz output), then fade out 3s before end. `-shortest`
        // caps audio at video length so we don't accumulate silent tail.
        let fade_start = (spec.total_duration_sec - 3.0).max(1.0);
        args.push("-map".into());
        args.push("1:a:0".into());
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

    // Video encode. See gotchas at top.
    args.push("-c:v".into());
    args.push(spec.encoder.ffmpeg_codec().into());
    args.push("-pix_fmt".into());
    args.push("yuv420p".into());
    args.push("-r".into());
    args.push(spec.fps.to_string());
    match spec.encoder {
        HwEncoder::VideoToolbox => {
            args.push("-profile:v".into());
            args.push("1".into()); // Main (integer for VT)
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
pub fn build_per_child_cmd(concat_list: &Path, music: Option<&Path>, output: &Path, total_duration_sec: f64) -> Vec<String> {
    let spec = ReelSpec {
        concat_list: concat_list.to_path_buf(),
        music_track: music.map(|p| p.to_path_buf()),
        output: output.to_path_buf(),
        width: 1280,
        height: 720,
        avg_photo_sec: 3.0,
        total_duration_sec,
        fps: 30,
        video_bitrate_kbps: 2000,
        encoder: HwEncoder::for_current_os(),
        emit_progress: true,
    };
    build_reel_cmd(&spec)
}

/// Build a reel spec appropriate for the 15-minute year-in-review.
/// Assumes `avg_photo_sec` matches whatever was used to compute the
/// concat entries — the caller controls this so it stays in sync.
pub fn default_reel_spec(concat_list: PathBuf, music: Option<PathBuf>, output: PathBuf, avg_photo_sec: f64, total_duration_sec: f64) -> ReelSpec {
    ReelSpec {
        concat_list,
        music_track: music,
        output,
        width: 1920,
        height: 1080,
        avg_photo_sec,
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
            concat_list: "/tmp/list.txt".into(),
            music_track: Some("/tmp/song.mp3".into()),
            output: "/tmp/out.mp4".into(),
            width: 1920, height: 1080,
            avg_photo_sec: 3.0, total_duration_sec: 900.0, fps: 30,
            video_bitrate_kbps: 6000,
            encoder: HwEncoder::OpenH264,
            emit_progress: false,
        }
    }

    #[test]
    fn reel_cmd_has_concat_input() {
        let args = build_reel_cmd(&base_spec());
        assert!(args.iter().any(|a| a == "concat"));
        assert!(args.iter().any(|a| a == "/tmp/list.txt"));
    }

    #[test]
    fn reel_cmd_maps_audio_when_music_present() {
        let args = build_reel_cmd(&base_spec());
        assert!(args.windows(2).any(|w| w[0] == "-map" && w[1] == "1:a:0"));
        assert!(args.iter().any(|a| a.contains("loudnorm")));
    }

    #[test]
    fn reel_cmd_omits_audio_without_music() {
        let mut spec = base_spec();
        spec.music_track = None;
        let args = build_reel_cmd(&spec);
        assert!(!args.iter().any(|a| a == "1:a:0"));
        assert!(!args.iter().any(|a| a.contains("loudnorm")));
    }

    #[test]
    fn per_child_defaults() {
        let args = build_per_child_cmd(
            Path::new("/tmp/list.txt"),
            None,
            Path::new("/tmp/kid.mp4"),
            120.0,
        );
        assert!(args.iter().any(|a| a == "/tmp/kid.mp4"));
    }

    #[test]
    fn fade_start_scales_with_duration() {
        // Reel: 900s → fade_start = 897.0
        let args = build_reel_cmd(&base_spec());
        let af = args.iter().find(|a| a.contains("afade")).unwrap();
        assert!(af.contains("st=897.0"), "reel fade should start at 897s, got {af}");

        // Per-child: 120s → fade_start = 117.0
        let per_child_args = build_per_child_cmd(
            Path::new("/tmp/list.txt"),
            Some(Path::new("/tmp/song.mp3")),
            Path::new("/tmp/kid.mp4"),
            120.0,
        );
        let af2 = per_child_args.iter().find(|a| a.contains("afade")).unwrap();
        assert!(af2.contains("st=117.0"), "per-child fade should start at 117s, got {af2}");
    }

    #[test]
    fn filter_preserves_aspect_ratio() {
        let args = build_reel_cmd(&base_spec());
        let filter = args.iter().find(|a| a.contains("zoompan")).unwrap();
        // v2.3.1: blurred-backdrop composition preserves the full photo.
        // The FG branch uses force_original_aspect_ratio=decrease (fit
        // inside canvas → letterbox); the BG branch uses =increase +
        // crop (fill canvas with blurred backdrop). Both branches must
        // be present in the filter graph.
        assert!(filter.contains("force_original_aspect_ratio=decrease"),
                "foreground fit-scaling missing (portrait photos will be over-cropped): {filter}");
        assert!(filter.contains("force_original_aspect_ratio=increase"),
                "background fill-scaling missing: {filter}");
        assert!(filter.contains("gblur"),
                "backdrop blur missing — bg should be a soft blurred version of the photo: {filter}");
        assert!(filter.contains("overlay="),
                "fg overlay onto bg missing: {filter}");
    }

    #[test]
    fn zoompan_is_centre_anchored() {
        // Without x/y expressions, zoompan defaults to top-left anchor
        // and the composite drifts up-and-left as zoom increases.
        let args = build_reel_cmd(&base_spec());
        let filter = args.iter().find(|a| a.contains("zoompan")).unwrap();
        assert!(filter.contains("x='iw/2-(iw/zoom/2)'"), "zoompan x anchor missing: {filter}");
        assert!(filter.contains("y='ih/2-(ih/zoom/2)'"), "zoompan y anchor missing: {filter}");
    }

    #[test]
    fn audio_forces_48khz_output() {
        let args = build_reel_cmd(&base_spec());
        assert!(args.windows(2).any(|w| w[0] == "-ar" && w[1] == "48000"));
        // aresample=48000 in the -af string prevents loudnorm's internal
        // 192 kHz from reaching the encoder as 96 kHz.
        let af = args.iter().find(|a| a.contains("loudnorm")).unwrap();
        assert!(af.contains("aresample=48000"), "aresample missing: {af}");
    }

    #[test]
    fn videotoolbox_uses_integer_profile() {
        let mut spec = base_spec();
        spec.encoder = HwEncoder::VideoToolbox;
        let args = build_reel_cmd(&spec);
        let idx = args.iter().position(|a| a == "-profile:v").unwrap();
        assert_eq!(args[idx + 1], "1"); // Not "main"
        assert!(args.windows(2).any(|w| w[0] == "-bf" && w[1] == "0"));
    }

    #[test]
    fn zoompan_frame_count_scales_with_hold() {
        let mut spec = base_spec();
        spec.avg_photo_sec = 2.5;
        spec.fps = 30;
        let args = build_reel_cmd(&spec);
        let filter = args.iter().find(|a| a.contains("zoompan")).unwrap();
        // 2.5 * 30 = 75
        assert!(filter.contains("d=75"));
    }

    /// Concat entries silence -Wunused-import on debug builds where the
    /// full pipeline isn't wired yet.
    #[test]
    fn concat_entry_used() {
        let _e = ConcatEntry { path: PathBuf::from("/x"), duration_sec: 1.0 };
    }
}
