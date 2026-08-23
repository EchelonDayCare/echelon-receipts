//! Website CMS module (v3.20.0 PR 2 — text-only content).
//!
//! End-to-end pipeline that lets the daycare owner edit the
//! `EchelonDayCare/echelon-website` content JSON files from the
//! desktop app, preview the rendered site locally, and eventually
//! publish back to GitHub Pages.
//!
//! # Architecture
//! - **Working copy:** `git2` clone of the site repo lives under
//!   `app_data_dir/website/repo/`. Templates and content are read
//!   from disk, never bundled — so a template change in the site
//!   repo is picked up on the next `git pull` without an app
//!   redeploy.
//! - **Drafts:** every editor "Save draft" writes an immutable row to
//!   `site_revisions` and updates a per-file pointer in
//!   `site_pointers.active_draft_rev`. On publish we snapshot the
//!   current drafts, overwrite the files in the working copy, render
//!   HTML into `.render-cache/build/`, and validate the DOM before
//!   commit + push.
//! - **Preview:** a `tiny_http` server binds to a random loopback
//!   port and serves the rendered `.render-cache/build/` dir. The
//!   WebView loads that URL inside an iframe on the preview screen.
//! - **Publish state machine:** persisted in `site_publications`.
//!   `draft → rendering → rendered → git_fetching → git_fetched →
//!    committing → pushing → pushed → polling_pages → verified_live`,
//!   with `error` as a terminal branch from any state.
//! - **PAT:** stored in the OS keyring under
//!   `echelon-website-cms-github-pat`. The frontend never sees the
//!   token — it just hands the user's typed value to a Rust command
//!   that verifies against `GET /repos/EchelonDayCare/echelon-website`
//!   and stores on success.
//!
//! # Feature flag
//! Guarded by the `ECHELON_WEBSITE_CMS=1` env var. The flag is
//! captured at startup in [`FeatureFlag::detect`] and exposed to the
//! frontend via the [`commands::website_feature_enabled`] Tauri
//! command. When disabled, every other command returns an
//! informative error rather than silently no-op'ing — so a UI bug
//! that ships a Website nav entry can never accidentally write to
//! `site_revisions`.

#![allow(dead_code)] // Public API is exposed via Tauri commands; some
                    // helpers on the schema types are only called
                    // from tests until the media PR lands.

use std::sync::Arc;

use tokio::sync::Mutex;

pub mod ai_edit;
pub mod commands;
pub mod gallery_videos;
pub mod git_ops;
pub mod media;
pub mod pat;
pub mod preview_server;
pub mod publish;
pub mod renderer;
pub mod revisions;
pub mod schema;
pub mod tour;

/// Feature flag captured once at startup. See module docs for why we
/// do this at startup vs on every command — the env var is set (or
/// not) when the user launches the app; toggling it mid-session isn't
/// supported.
#[derive(Debug, Clone, Copy)]
pub struct FeatureFlag(pub bool);

impl FeatureFlag {
    /// Read `ECHELON_WEBSITE_CMS` from the environment.
    ///
    /// From v3.23.0 the Website CMS is a shipped feature: it is enabled
    /// by default. The env var is retained as an explicit **opt-out**
    /// escape hatch (`ECHELON_WEBSITE_CMS=0`) for support scenarios or
    /// automated tests where the module should stay hidden. Any other
    /// value (missing, `"1"`, `"true"`, ...) leaves it enabled.
    pub fn detect() -> Self {
        let enabled = std::env::var("ECHELON_WEBSITE_CMS")
            .map(|v| v != "0")
            .unwrap_or(true);
        Self(enabled)
    }

    pub fn enabled(self) -> bool {
        self.0
    }
}

/// Session-level state for the Website CMS module.
///
/// * `preview` — an optional running preview server handle. Only one
///   preview at a time; starting a new preview closes the old one.
/// * `publish_in_flight` — a mutex latch so two publish runs can't
///   race against each other and against the git working copy.
#[derive(Default)]
pub struct WebsiteState {
    pub preview: Arc<Mutex<Option<preview_server::PreviewHandle>>>,
    pub publish_in_flight: Arc<Mutex<()>>,
}
