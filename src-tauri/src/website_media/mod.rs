//! Deterministic media pipeline for the Website CMS (PR 3 groundwork).
//!
//! This module is **isolated** and does not depend on any other module in the
//! crate. It is designed to be wired into the top-level `website` module (PR 2)
//! by a single `pub mod website_media;` line in `src-tauri/src/lib.rs` once
//! both PRs land — see `PR3_INTEGRATION.md` at the repo root.
//!
//! Public entry points:
//! - [`pipeline::process_photo`] — full photo pipeline: EXIF strip → decode →
//!   re-encode 3 widths × 3 formats → 9 deterministic outputs.
//! - [`video::process_video`] / [`video::probe_video`] — video stubs (real
//!   ffmpeg-sidecar integration lands in PR 3.5).
//! - [`pdf::accept_pdf`] — PDF magic + size validation (thumbnails in PR 3.5).
//! - [`emergency_remove::EmergencyRemoveMark`] — data shape for the child-
//!   photo emergency-remove flow. The actual git history rewrite runs in the
//!   `website` module in PR 3.

// The `pub use` re-exports below are the public API of this module. Until
// this module is wired into `lib.rs` (PR 3 assembly) the integration-test
// crate that hosts these files doesn't use every re-export directly — that
// would trip `unused_imports` under `-D warnings`. The re-exports still
// have to exist here for downstream consumers post-wiring.
#![allow(unused_imports, dead_code)]

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
