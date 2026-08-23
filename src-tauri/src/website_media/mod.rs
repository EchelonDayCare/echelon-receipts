//! Deterministic media pipeline for the Website CMS (v3.20.0 PR 3).
//!
//! This module is consumed by the top-level `website` module — the
//! `website::media` submodule wraps [`pipeline::process_photo`] with
//! DB writes and working-copy file placement, and `website::commands`
//! exposes the Tauri command surface for the frontend.
//!
//! Public entry points:
//! - [`pipeline::process_photo`] — full photo pipeline: EXIF strip →
//!   decode → re-encode 3 widths × 3 formats → 9 deterministic outputs.
//! - [`video::process_video`] / [`video::probe_video`] — video stubs (real
//!   ffmpeg-sidecar integration lands in PR 3.5).
//! - [`pdf::accept_pdf`] — PDF magic + size validation (thumbnails in PR 3.5).
//! - [`emergency_remove::EmergencyRemoveMark`] — data shape for the child-
//!   photo emergency-remove flow. The actual git history rewrite runs in
//!   the `website::media` submodule.

// `dead_code` is retained because the video/pdf stubs aren't
// consumed by the wired call sites yet — they exist so PR 3.5 can
// flip the stubs on without an API break.
//
// `unused_imports` is allowed because the `pub use` block below
// re-exports names for future in-crate consumers (and to define a
// clean facade for docs); as of PR 3 the only wired consumer is
// `website::media`, which reaches into the submodules directly.
// The re-exports stay so PR 3.5+ can `use website_media::VideoInput`.
#![allow(dead_code, unused_imports)]

pub mod emergency_remove;
pub mod error;
pub mod exif;
pub mod hash;
pub mod pdf;
pub mod pipeline;
pub mod reencode;
pub mod video;

pub use emergency_remove::EmergencyRemoveMark;
pub use error::MediaError;
pub use exif::{strip_metadata, FormatHint};
pub use hash::{filename, Format, RECIPE_VERSION};
pub use pdf::{accept_pdf, PdfAccepted};
pub use pipeline::{process_photo, PhotoInput, PhotoOutput, Variant, MAX_INPUT_SIZE};
pub use video::{process_video, probe_video, VideoInput, VideoOutput, VideoProbe};
