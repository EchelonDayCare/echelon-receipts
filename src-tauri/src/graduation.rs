//! Graduation Day feature (v2.3.0).
//!
//! End-to-end pipeline that renders a 15-minute year-in-review reel, a
//! 2-minute per-child slideshow for every graduating student, and a
//! PowerPoint deck built from a user-supplied template.
//!
//! # Architecture
//! - **Photo intake:** iPhone photos are HEIC. Everything else is JPEG /
//!   PNG / WebP. The `heic` submodule normalises HEIC to JPEG in a cache
//!   directory before FFmpeg ever sees the file — FFmpeg has no HEIF
//!   demuxer in our LGPL build.
//! - **Rendering:** shells out to the FFmpeg sidecar bundled at
//!   `binaries/ffmpeg-<target-triple>`. See `docs/graduation-day.md`.
//! - **Preflight:** every render is gated by a preflight check that
//!   verifies FFmpeg runs, required encoders/filters exist, disk space
//!   is adequate, and destination folders are writable.
//!
//! # Wiring
//! Currently unwired from the Tauri `invoke_handler`. Commands will be
//! registered once the pipeline is complete (see plan.md).

#![allow(dead_code)] // The public API of this module is exposed via
                    // Tauri commands, which are registered in lib.rs as
                    // each pipeline stage lands. Suppresses warnings
                    // during the incremental build-out.

use serde::Serialize;

/// A structured result for any preflight or render step.
#[derive(Debug, Serialize)]
pub struct StepReport {
    pub ok: bool,
    pub message: String,
    pub details: Option<serde_json::Value>,
}

impl StepReport {
    pub fn ok(msg: impl Into<String>) -> Self {
        Self { ok: true, message: msg.into(), details: None }
    }

    pub fn fail(msg: impl Into<String>) -> Self {
        Self { ok: false, message: msg.into(), details: None }
    }

    pub fn with_details(mut self, v: serde_json::Value) -> Self {
        self.details = Some(v);
        self
    }
}

pub mod commands;
pub mod concat;
pub mod curate;
pub mod engine;
pub mod heic;
pub mod paths;
pub mod pptx;
pub mod preflight;
pub mod progress;
