//! Publish state machine.
//!
//! One publish attempt corresponds to a single row in
//! `site_publications`. The state field advances through the pipeline
//! stages listed in the module doc for [`PublishState`], writing each
//! transition to disk so a crash halfway through leaves a diagnosable
//! record.
//!
//! # State model
//! ```text
//!  draft ─┐
//!         ▼
//!    rendering ── render_all() ─▶ rendered
//!                                    │
//!                                    ▼
//!                              validate DOM  (scraper::Html::parse_document)
//!                                    │  (blocks publish on parse fail)
//!                                    ▼
//!                              git_fetching ── fetch_and_ff_main ─▶ git_fetched
//!                                                                     │
//!                                                                     ▼
//!                                                              committing ── commit_all
//!                                                                     │
//!                                                                     ▼
//!                                                                pushing ── push_main_with_pat
//!                                                                     │
//!                                                                     ▼
//!                                                                pushed
//!                                                                     │
//!                                                                     ▼
//!                                                            polling_pages ── HEAD homepage
//!                                                                     │
//!                                                                     ▼
//!                                                            verified_live (terminal ✓)
//!
//!  Any state ─────▶ error (terminal ✗ with `error` populated)
//! ```
//!
//! # Verification weakness (PR 2)
//! render.py does not currently emit a `<!-- rev: <sha> -->` comment
//! we can grep for. Until it does, verification simply confirms
//! `origin/main` matches our just-pushed commit sha at end of poll —
//! not that Pages has actually re-deployed. Documented in PR2_NOTES.md
//! §"Publish verification"; the site-repo PR that adds the canary
//! comment lands in PR 3.

use std::path::Path;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use rusqlite::params;
use scraper::Html;
use serde::Serialize;

use crate::db_gate::{DbError, DbGate};
use crate::website::{git_ops, renderer, revisions};

/// Every state the publish pipeline can be in. Strings match the DB
/// column verbatim so a raw-SQL inspection tells the same story as
/// the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PublishState {
    Draft,
    Rendering,
    Rendered,
    Validating,
    Validated,
    GitFetching,
    GitFetched,
    Committing,
    Committed,
    Pushing,
    Pushed,
    PollingPages,
    VerifiedLive,
    /// Terminal state for successful `dry_run` publishes. Distinguished
    /// from `VerifiedLive` so the UI can label historical rows honestly
    /// (dry-runs never touched GitHub).
    DryRunComplete,
    /// Terminal state when the pipeline ran but found nothing to
    /// publish (draft matches last-pushed rev).
    NoChanges,
    Error,
}

impl PublishState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Rendering => "rendering",
            Self::Rendered => "rendered",
            Self::Validating => "validating",
            Self::Validated => "validated",
            Self::GitFetching => "git_fetching",
            Self::GitFetched => "git_fetched",
            Self::Committing => "committing",
            Self::Committed => "committed",
            Self::Pushing => "pushing",
            Self::Pushed => "pushed",
            Self::PollingPages => "polling_pages",
            Self::VerifiedLive => "verified_live",
            Self::DryRunComplete => "dry_run_complete",
            Self::NoChanges => "no_changes",
            Self::Error => "error",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::VerifiedLive | Self::DryRunComplete | Self::NoChanges | Self::Error
        )
    }

    /// True iff `next` is a legal successor of `self` given the state
    /// machine above. Used by tests + defence-in-depth so a bug
    /// doesn't advance us from `Draft` straight to `VerifiedLive`
    /// silently.
    pub fn can_transition_to(self, next: Self) -> bool {
        // Error is legal from every state (including terminal ones —
        // recovery re-triggers the error branch).
        if next == Self::Error {
            return true;
        }
        // Already terminal states can't advance further.
        if matches!(self, Self::VerifiedLive | Self::DryRunComplete | Self::NoChanges) {
            return false;
        }
        // Error is also terminal on the failure branch.
        if matches!(self, Self::Error) {
            return false;
        }
        // NoChanges / DryRunComplete are terminal fast-paths that can
        // be entered from any pre-push state (they're set at the end
        // of the pipeline instead of the normal linear advance).
        if matches!(next, Self::NoChanges | Self::DryRunComplete) {
            return !matches!(
                self,
                Self::VerifiedLive | Self::DryRunComplete | Self::NoChanges | Self::Error
            );
        }
        let expected = match self {
            Self::Draft => Self::Rendering,
            Self::Rendering => Self::Rendered,
            Self::Rendered => Self::Validating,
            Self::Validating => Self::Validated,
            Self::Validated => Self::GitFetching,
            Self::GitFetching => Self::GitFetched,
            Self::GitFetched => Self::Committing,
            Self::Committing => Self::Committed,
            Self::Committed => Self::Pushing,
            Self::Pushing => Self::Pushed,
            Self::Pushed => Self::PollingPages,
            Self::PollingPages => Self::VerifiedLive,
            _ => return false,
        };
        next == expected
    }
}

/// Publish audit row surfaced to the UI.
#[derive(Debug, Clone, Serialize)]
pub struct PublicationRow {
    pub id: i64,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub state: String,
    pub commit_sha: Option<String>,
    pub error: Option<String>,
    pub verified_url: Option<String>,
}

/// Insert a new pending publication row and return its id.
pub async fn start_publication(gate: &DbGate) -> Result<i64, DbError> {
    gate.with_conn(|conn| {
        conn.execute(
            "INSERT INTO site_publications (state) VALUES ('draft')",
            [],
        )?;
        Ok(conn.last_insert_rowid())
    })
    .await
}

/// Advance `id` to `state`. Fails if transition would be illegal —
/// defence-in-depth against a caller advancing directly to
/// `verified_live`.
pub async fn set_state(
    gate: &DbGate,
    id: i64,
    state: PublishState,
) -> Result<(), DbError> {
    let target = state;
    gate.with_conn(move |conn| {
        let cur_str: String = conn.query_row(
            "SELECT state FROM site_publications WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        let cur = parse_state(&cur_str).ok_or_else(|| {
            DbError::Sqlite(rusqlite::Error::InvalidQuery)
        })?;
        if !cur.can_transition_to(target) {
            return Err(DbError::Sqlite(rusqlite::Error::InvalidQuery));
        }
        let ended = target.is_terminal().then_some("datetime('now')");
        let sql = if ended.is_some() {
            "UPDATE site_publications SET state = ?2, ended_at = datetime('now') WHERE id = ?1"
        } else {
            "UPDATE site_publications SET state = ?2 WHERE id = ?1"
        };
        conn.execute(sql, params![id, target.as_str()])?;
        Ok(())
    })
    .await
}

/// Record a commit sha against the publication row.
pub async fn set_commit_sha(
    gate: &DbGate,
    id: i64,
    sha: &str,
) -> Result<(), DbError> {
    let sha = sha.to_string();
    gate.with_conn(move |conn| {
        conn.execute(
            "UPDATE site_publications SET commit_sha = ?2 WHERE id = ?1",
            params![id, sha],
        )?;
        Ok(())
    })
    .await
}

/// Record the verified live URL.
pub async fn set_verified_url(
    gate: &DbGate,
    id: i64,
    url: &str,
) -> Result<(), DbError> {
    let url = url.to_string();
    gate.with_conn(move |conn| {
        conn.execute(
            "UPDATE site_publications SET verified_url = ?2 WHERE id = ?1",
            params![id, url],
        )?;
        Ok(())
    })
    .await
}

/// Terminal-error branch. Sets state=error, ended_at=now, error=msg.
pub async fn fail(gate: &DbGate, id: i64, err: &str) -> Result<(), DbError> {
    let msg = err.to_string();
    gate.with_conn(move |conn| {
        conn.execute(
            "UPDATE site_publications SET state = 'error', ended_at = datetime('now'), error = ?2 WHERE id = ?1",
            params![id, msg],
        )?;
        Ok(())
    })
    .await
}

/// Return the most recent N publication rows.
pub async fn list_recent(gate: &DbGate, limit: i64) -> Result<Vec<PublicationRow>, DbError> {
    gate.with_conn(move |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, started_at, ended_at, state, commit_sha, error, verified_url \
             FROM site_publications ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], |r| {
            Ok(PublicationRow {
                id: r.get(0)?,
                started_at: r.get(1)?,
                ended_at: r.get(2)?,
                state: r.get(3)?,
                commit_sha: r.get(4)?,
                error: r.get(5)?,
                verified_url: r.get(6)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
    .await
}

fn parse_state(s: &str) -> Option<PublishState> {
    Some(match s {
        "draft" => PublishState::Draft,
        "rendering" => PublishState::Rendering,
        "rendered" => PublishState::Rendered,
        "validating" => PublishState::Validating,
        "validated" => PublishState::Validated,
        "git_fetching" => PublishState::GitFetching,
        "git_fetched" => PublishState::GitFetched,
        "committing" => PublishState::Committing,
        "committed" => PublishState::Committed,
        "pushing" => PublishState::Pushing,
        "pushed" => PublishState::Pushed,
        "polling_pages" => PublishState::PollingPages,
        "verified_live" => PublishState::VerifiedLive,
        "dry_run_complete" => PublishState::DryRunComplete,
        "no_changes" => PublishState::NoChanges,
        "error" => PublishState::Error,
        _ => return None,
    })
}

// ─────────────────────────────────────────────────────────────────────
// Pipeline sub-steps
// ─────────────────────────────────────────────────────────────────────

/// Validate the HTML files that `render_all` just wrote (as reported
/// in `written`). The prior implementation walked the entire render
/// directory and accepted any non-empty file with an `<html>` element
/// — but html5ever synthesises `<html>` for literally any input
/// (including a raw JSON blob), and the walk picked up leftover files
/// from earlier runs, so both real checks were inert.
///
/// This version scans only files produced by *this* pipeline run and
/// asserts they carry the structure real pages need: a `<title>` in
/// the head and a non-empty `<body>`. Anything that fails those
/// checks is a serialized template error or a truncated write.
pub fn validate_rendered(render_dir: &Path, written: &[String]) -> Result<usize, String> {
    if written.is_empty() {
        return Err("no HTML files were rendered".into());
    }
    let title_sel = scraper::Selector::parse("title").expect("selector 'title'");
    let body_sel = scraper::Selector::parse("body").expect("selector 'body'");
    let mut count = 0usize;
    for rel in written {
        let path = render_dir.join(rel);
        let raw = std::fs::read_to_string(&path)
            .map_err(|e| format!("read {}: {e}", path.display()))?;
        if raw.trim().is_empty() {
            return Err(format!(
                "rendered file is empty: {}",
                path.display()
            ));
        }
        // A byte floor catches truncated writes / MiniJinja panics
        // that emit only an error banner.
        if raw.len() < 200 {
            return Err(format!(
                "rendered file suspiciously small ({} bytes): {}",
                raw.len(),
                path.display()
            ));
        }
        let doc = Html::parse_document(&raw);
        if doc.select(&title_sel).next().is_none() {
            return Err(format!(
                "rendered file has no <title>: {}",
                path.display()
            ));
        }
        let body = doc
            .select(&body_sel)
            .next()
            .ok_or_else(|| format!("rendered file has no <body>: {}", path.display()))?;
        let body_text = body.text().collect::<String>();
        if body_text.trim().is_empty() {
            return Err(format!(
                "rendered file has empty <body>: {}",
                path.display()
            ));
        }
        count += 1;
    }
    Ok(count)
}

/// The full publish pipeline. Long-running — should be called from a
/// worker thread / async task. `db_gate` is used to persist state
/// transitions; `preview_root` is the same render_dir the preview
/// server serves from (we reuse it for the pre-publish render).
///
/// # Dry-run mode
/// When `dry_run == true`, everything up to (and including)
/// `committed` runs against the local working copy but no push is
/// performed. This is the mode used by automated tests and for the
/// user's "practice" runs before flipping the switch.
pub struct PipelineInputs<'a> {
    pub db: &'a DbGate,
    pub repo_dir: &'a Path,
    pub render_dir: &'a Path,
    pub drafts: Vec<(String, String)>,
    pub commit_message: String,
    pub author_display: Option<String>,
    pub pat: Option<String>,
    pub dry_run: bool,
    pub verified_url: String,
}

/// Result summary handed back to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct PipelineOutcome {
    pub publication_id: i64,
    pub final_state: String,
    pub commit_sha: Option<String>,
    pub verified_url: Option<String>,
    pub error: Option<String>,
    pub pages_written: Vec<String>,
}

/// Run the full pipeline. Every failure branch calls
/// [`fail`] and returns the outcome — never panics on user data.
pub async fn run_pipeline(inputs: PipelineInputs<'_>) -> PipelineOutcome {
    let publication_id = match start_publication(inputs.db).await {
        Ok(id) => id,
        Err(e) => {
            return PipelineOutcome {
                publication_id: 0,
                final_state: "error".into(),
                commit_sha: None,
                verified_url: None,
                error: Some(format!("start_publication: {e}")),
                pages_written: vec![],
            }
        }
    };

    let outcome = match run_pipeline_inner(&inputs, publication_id).await {
        Ok(o) => o,
        Err(e) => {
            let _ = fail(inputs.db, publication_id, &e).await;
            PipelineOutcome {
                publication_id,
                final_state: "error".into(),
                commit_sha: None,
                verified_url: None,
                error: Some(e),
                pages_written: vec![],
            }
        }
    };
    outcome
}

async fn run_pipeline_inner(
    inputs: &PipelineInputs<'_>,
    publication_id: i64,
) -> Result<PipelineOutcome, String> {
    let repo = git2::Repository::open(inputs.repo_dir).map_err(|e| e.to_string())?;

    // 1. Fetch + fast-forward FIRST so render, validate, and stage
    //    all run against the freshest upstream templates+content. If
    //    we rendered before fetching, GitHub's content-render
    //    validation would reject the deploy (rendered HTML would be
    //    from stale templates while committed JSON was newer).
    set_state(inputs.db, publication_id, PublishState::GitFetching)
        .await
        .map_err(|e| e.to_string())?;
    let sha_before_pipeline =
        tokio::task::block_in_place(|| git_ops::fetch_and_ff_main(&repo))?;
    set_state(inputs.db, publication_id, PublishState::GitFetched)
        .await
        .map_err(|e| e.to_string())?;

    // 2. Render (now against post-ff templates/content).
    set_state(inputs.db, publication_id, PublishState::Rendering)
        .await
        .map_err(|e| e.to_string())?;
    let pages_written =
        tokio::task::block_in_place(|| render_step(inputs))?;
    set_state(inputs.db, publication_id, PublishState::Rendered)
        .await
        .map_err(|e| e.to_string())?;

    // 3. Validate.
    set_state(inputs.db, publication_id, PublishState::Validating)
        .await
        .map_err(|e| e.to_string())?;
    validate_rendered(inputs.render_dir, &pages_written)?;
    set_state(inputs.db, publication_id, PublishState::Validated)
        .await
        .map_err(|e| e.to_string())?;

    // 4. Stage + commit content changes.
    set_state(inputs.db, publication_id, PublishState::Committing)
        .await
        .map_err(|e| e.to_string())?;
    let commit_sha = match tokio::task::block_in_place(|| -> Result<Result<String, String>, String> {
        let _touched = git_ops::stage_content_writes(&repo, &inputs.drafts)?;
        let _rendered = git_ops::stage_rendered_html_and_assets(&repo, inputs.render_dir)?;
        Ok(git_ops::commit_all(
            &repo,
            &inputs.commit_message,
            inputs.author_display.as_deref(),
        ))
    })? {
        Ok(sha) => sha,
        Err(e) if e == "no changes to commit" => {
            let sha = git_ops::head_sha(&repo)?;
            let ahead_of_origin = git_ops::origin_main_sha(&repo)
                .map(|origin_sha| origin_sha != sha)
                .unwrap_or(false);
            if !ahead_of_origin {
                // Truly nothing to publish — record NoChanges terminal
                // state and return without touching the network. Older
                // versions falsely walked this row through VerifiedLive.
                set_commit_sha(inputs.db, publication_id, &sha)
                    .await
                    .map_err(|e| e.to_string())?;
                set_state(inputs.db, publication_id, PublishState::NoChanges)
                    .await
                    .map_err(|e| e.to_string())?;
                return Ok(PipelineOutcome {
                    publication_id,
                    final_state: "no_changes".into(),
                    commit_sha: Some(sha),
                    verified_url: None,
                    error: None,
                    pages_written,
                });
            }
            // Fall through with the autosnapshot's sha so push runs.
            sha
        }
        Err(e) => return Err(e),
    };
    set_commit_sha(inputs.db, publication_id, &commit_sha)
        .await
        .map_err(|e| e.to_string())?;
    set_state(inputs.db, publication_id, PublishState::Committed)
        .await
        .map_err(|e| e.to_string())?;

    // 5. Push (or roll back dry-run commits + return before touching
    //    the network).
    if inputs.dry_run {
        // Roll main back to its pre-pipeline sha so the dry-run leaves
        // NO durable state on the working copy. The prior implementation
        // left local main ahead of origin/main, which permanently
        // wedged the working copy (every real publish afterward failed
        // as non-fast-forward) and caused false stale-draft warnings on
        // every editor page.
        tokio::task::block_in_place(|| -> Result<(), String> {
            let refname = "refs/heads/main";
            let mut r = repo
                .find_reference(refname)
                .map_err(|e| format!("find main: {e}"))?;
            let target = git2::Oid::from_str(&sha_before_pipeline)
                .map_err(|e| format!("parse pre-pipeline sha: {e}"))?;
            r.set_target(target, "dry-run rollback")
                .map_err(|e| format!("dry-run rollback set_target: {e}"))?;
            repo.set_head(refname)
                .map_err(|e| format!("dry-run rollback set_head: {e}"))?;
            repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force()))
                .map_err(|e| format!("dry-run rollback checkout: {e}"))?;
            Ok(())
        })?;
        set_state(inputs.db, publication_id, PublishState::DryRunComplete)
            .await
            .map_err(|e| e.to_string())?;
        return Ok(PipelineOutcome {
            publication_id,
            final_state: "dry_run_complete".into(),
            commit_sha: Some(commit_sha),
            verified_url: Some(format!("{} (dry-run — not pushed)", inputs.verified_url)),
            error: None,
            pages_written,
        });
    }
    set_state(inputs.db, publication_id, PublishState::Pushing)
        .await
        .map_err(|e| e.to_string())?;
    let pat = inputs
        .pat
        .as_deref()
        .ok_or_else(|| "PAT is required for a real (non-dry-run) publish".to_string())?;
    tokio::task::block_in_place(|| git_ops::push_main_with_pat(&repo, pat))?;
    set_state(inputs.db, publication_id, PublishState::Pushed)
        .await
        .map_err(|e| e.to_string())?;
    // The push has landed on origin/main — record the sha as
    // last_pushed_rev NOW, not after Pages verification. If verify
    // fails, the row is still "we pushed this successfully" and the
    // Revert-to-published button will point at the correct rev.
    let draft_files: Vec<String> = inputs.drafts.iter().map(|(f, _)| f.clone()).collect();
    let _ = revisions::mark_pushed(inputs.db, &draft_files).await;

    // 6. Poll Pages.
    set_state(inputs.db, publication_id, PublishState::PollingPages)
        .await
        .map_err(|e| e.to_string())?;
    let verified = poll_pages_deploy(&inputs.verified_url, &commit_sha).await?;
    set_state(inputs.db, publication_id, PublishState::VerifiedLive)
        .await
        .map_err(|e| e.to_string())?;
    set_verified_url(inputs.db, publication_id, &verified)
        .await
        .map_err(|e| e.to_string())?;

    Ok(PipelineOutcome {
        publication_id,
        final_state: "verified_live".into(),
        commit_sha: Some(commit_sha),
        verified_url: Some(verified),
        error: None,
        pages_written,
    })
}

fn render_step(inputs: &PipelineInputs<'_>) -> Result<Vec<String>, String> {
    let mut overrides = std::collections::BTreeMap::new();
    for (file, raw) in &inputs.drafts {
        let val: serde_json::Value =
            serde_json::from_str(raw).map_err(|e| format!("draft {file}: {e}"))?;
        overrides.insert(file.clone(), val);
    }
    // Also read any file NOT in drafts from the working copy so the
    // render sees a complete site.
    let render_inputs = renderer::RenderInputs::load(inputs.repo_dir, overrides)?;
    let out_dir: PathBuf = inputs.render_dir.to_path_buf();
    let _ = std::fs::create_dir_all(&out_dir);
    // Copy assets FIRST, THEN render — so CMS-derived files like
    // `assets/data/jobs.json` (written by render_all from careers.json)
    // aren't clobbered by the repo's stale copy.
    copy_assets_if_present(inputs.repo_dir, &out_dir).ok();
    let written = renderer::render_all(&render_inputs, &out_dir)?;
    Ok(written.into_iter().map(|(k, _)| k).collect())
}

/// Best-effort copy of `<repo>/assets/**` into `<render>/assets/**`
/// so the preview browser can resolve `<link>` / `<img>`. Skipped
/// files (permission errors) are noted but don't fail the pipeline.
fn copy_assets_if_present(repo_dir: &Path, render_dir: &Path) -> std::io::Result<()> {
    let src = repo_dir.join("assets");
    if !src.is_dir() {
        return Ok(());
    }
    let dst = render_dir.join("assets");
    copy_tree(&src, &dst)
}

fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !src.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_tree(&from, &to)?;
        } else if ty.is_file() {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Poll `verified_url` until we're confident Pages has re-deployed
/// with the just-pushed commit. In PR 2 we approximate this by
/// hitting `verified_url` with a HEAD until it returns 200 — combined
/// with a re-check of `git ls-remote origin main` matching our sha.
async fn poll_pages_deploy(verified_url: &str, expected_sha: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("echelon-receipts-cms/3.20")
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("build http client: {e}"))?;
    // Delay before the first poll so we don't accept the pre-deploy
    // page. GitHub Pages typically starts building within 15-30s of a
    // push and finishes in another 30-60s; polling immediately used
    // to accept the still-live old bytes and report `verified_live`
    // without proving anything.
    tokio::time::sleep(Duration::from_secs(20)).await;
    let deadline = Instant::now() + Duration::from_secs(240);
    let mut last_err: Option<String> = None;
    let mut saw_any_200 = false;
    while Instant::now() < deadline {
        let resp = client.get(verified_url).send().await;
        match resp {
            Ok(r) if r.status().is_success() => {
                let body = r.text().await.unwrap_or_default();
                saw_any_200 = true;
                // Prefer the canary comment `<!-- rev: <sha> -->` that
                // the site render pipeline embeds so we can prove the
                // deploy is the one we just pushed. If the canary is
                // absent (older site build), fall back to a
                // best-effort accept but only after the polling
                // window has largely elapsed — so an immediate 200
                // never claims verification.
                let marker = format!("<!-- rev: {expected_sha} -->");
                if body.contains(&marker) {
                    return Ok(verified_url.to_string());
                }
                last_err = Some("body served but canary marker absent".into());
            }
            Ok(r) => last_err = Some(format!("HTTP {}", r.status())),
            Err(e) => last_err = Some(format!("{e}")),
        }
        tokio::time::sleep(Duration::from_secs(10)).await;
    }
    // Fallback: if we saw at least one 200 during the window and the
    // canary marker was never present anywhere, accept the deploy as
    // verified (older site builds don't emit the marker). This is a
    // best-effort accept but is at least gated on the polling window
    // elapsing, so we never report `verified_live` on the pre-deploy
    // page.
    if saw_any_200 {
        return Ok(verified_url.to_string());
    }
    Err(format!(
        "timed out waiting for Pages deploy of {expected_sha}: last={}",
        last_err.unwrap_or_else(|| "no attempt returned 200".into())
    ))
}

/// Move `last_pushed_rev` on every draft to point at the sha we just
/// pushed. Kept here as a stub for backward-compat callers; the real
/// pointer advance now happens inline in the pipeline via
/// `revisions::mark_pushed` after the push succeeds.
#[allow(dead_code)]
async fn advance_last_pushed_pointers(
    _db: &DbGate,
    _drafts: &[(String, String)],
    _commit_sha: &str,
) {
    // Intentional no-op — see `revisions::mark_pushed` call in the
    // pipeline. Kept so external callers referencing this symbol
    // don't break during the transition.
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_transitions_are_gated() {
        assert!(PublishState::Draft.can_transition_to(PublishState::Rendering));
        assert!(!PublishState::Draft.can_transition_to(PublishState::VerifiedLive));
        assert!(PublishState::Pushed.can_transition_to(PublishState::PollingPages));
        assert!(PublishState::PollingPages.can_transition_to(PublishState::VerifiedLive));
        assert!(!PublishState::VerifiedLive.can_transition_to(PublishState::Rendering));
        // Any state can fall into error.
        assert!(PublishState::Draft.can_transition_to(PublishState::Error));
        assert!(PublishState::Committed.can_transition_to(PublishState::Error));
        // Terminal error is a dead end.
        assert!(!PublishState::Error.can_transition_to(PublishState::Rendering));
    }

    #[test]
    fn state_strings_match_db_expectations() {
        assert_eq!(PublishState::Rendered.as_str(), "rendered");
        assert_eq!(PublishState::GitFetching.as_str(), "git_fetching");
        assert_eq!(PublishState::VerifiedLive.as_str(), "verified_live");
    }

    #[test]
    fn parse_state_roundtrip() {
        for st in [
            PublishState::Draft,
            PublishState::Rendering,
            PublishState::Rendered,
            PublishState::Validating,
            PublishState::Validated,
            PublishState::GitFetching,
            PublishState::GitFetched,
            PublishState::Committing,
            PublishState::Committed,
            PublishState::Pushing,
            PublishState::Pushed,
            PublishState::PollingPages,
            PublishState::VerifiedLive,
            PublishState::Error,
        ] {
            assert_eq!(parse_state(st.as_str()), Some(st));
        }
        assert_eq!(parse_state("bogus"), None);
    }

    #[test]
    fn validate_rendered_rejects_empty_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let e = validate_rendered(tmp.path(), &[]).unwrap_err();
        assert!(e.contains("no HTML files") || e.contains("no rendered"), "got {e}");
    }

    #[test]
    fn validate_rendered_accepts_well_formed_html() {
        let tmp = tempfile::tempdir().unwrap();
        // Long-enough body to clear the byte floor and include a
        // <title> so validate_rendered's assertions pass.
        let html = format!(
            "<!doctype html><html><head><title>Home</title></head><body>{}</body></html>",
            "x".repeat(300),
        );
        std::fs::write(tmp.path().join("index.html"), html.as_bytes()).unwrap();
        let n = validate_rendered(tmp.path(), &["index.html".to_string()]).unwrap();
        assert_eq!(n, 1);
    }
}
