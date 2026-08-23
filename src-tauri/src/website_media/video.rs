//! Video pipeline — STUB.
//!
//! The real video re-encode uses the ffmpeg sidecar the app already
//! ships (see `src-tauri/binaries/`); that integration lives in PR 3.5.
//! We publish the type shape now so the frontend and the CMS backend
//! can wire against stable interfaces during PR 3 assembly.

// The struct fields below are the frozen API surface PR 3.5 will
// populate; suppressing dead_code keeps `-D warnings` clean until then.
#![allow(dead_code)]

use super::error::MediaError;

#[derive(Debug, Clone)]
pub struct VideoInput {
    pub original_bytes: Vec<u8>,
    pub source_filename: String,
}

#[derive(Debug)]
pub struct VideoOutput {
    pub base_hash: String,
    /// Placeholder for the (mp4, webm, poster.jpg) triple PR 3.5 will
    /// materialise. Empty for now so the type is instantiable.
    pub variants: Vec<VideoVariant>,
}

#[derive(Debug)]
pub struct VideoVariant {
    pub filename: String,
    pub bytes: Vec<u8>,
    pub content_type: &'static str,
}

#[derive(Debug, Clone)]
pub struct VideoProbe {
    pub duration_seconds: f64,
    pub width: u32,
    pub height: u32,
    pub container: String,
}

/// Wired in PR 3.5 with ffmpeg sidecar reencode.
pub fn process_video(_input: VideoInput) -> Result<VideoOutput, MediaError> {
    // Wired in PR 3.5 with ffmpeg sidecar reencode.
    Err(MediaError::StubNotImplemented("process_video"))
}

/// Wired in PR 3.5 with ffmpeg sidecar reencode.
pub fn probe_video(_bytes: &[u8]) -> Result<VideoProbe, MediaError> {
    // Wired in PR 3.5 with ffmpeg sidecar reencode.
    Err(MediaError::StubNotImplemented("probe_video"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_stub_returns_stub_error() {
        let err = process_video(VideoInput {
            original_bytes: vec![0; 8],
            source_filename: "clip.mp4".into(),
        })
        .expect_err("stub");
        assert!(matches!(err, MediaError::StubNotImplemented("process_video")));
    }

    #[test]
    fn video_probe_stub_returns_stub_error() {
        let err = probe_video(&[0u8; 8]).expect_err("stub");
        assert!(matches!(err, MediaError::StubNotImplemented("probe_video")));
    }
}
