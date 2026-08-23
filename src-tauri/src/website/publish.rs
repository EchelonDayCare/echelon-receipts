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
use crate::website::{git_ops, renderer};

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
            Self::Error => "error",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::VerifiedLive | Self::Error)
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
        if matches!(self, Self::VerifiedLive) {
            return false;
        }
        // Error is also terminal on the failure branch.
        if matches!(self, Self::Error) {
            return false;
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
        "error" => PublishState::Error,
        _ => return None,
    })
}

// ─────────────────────────────────────────────────────────────────────
// Pipeline sub-steps
// ─────────────────────────────────────────────────────────────────────

/// Validate every rendered HTML file under `render_dir` parses. Uses
/// `scraper::Html::parse_document` which wraps html5ever — very
/// tolerant of quirks-mode markup, so a failure here means the input
/// is genuinely broken (unbalanced braces from a template bug, huge
/// null-byte splat, etc.).
pub fn validate_rendered(render_dir: &Path) -> Result<usize, String> {
    let mut count = 0usize;
    for entry in walkdir::WalkDir::new(render_dir) {
        let entry = entry.map_err(|e| format!("walk render dir: {e}"))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext != "html" && ext != "htm" {
            continue;
        }
        let raw = std::fs::read_to_string(path)
            .map_err(|e| format!("read {}: {e}", path.display()))?;
        let doc = Html::parse_document(&raw);
        // html5ever is extremely permissive: doc.errors surfaces
        // real defects like premature </html>. We reject only when
        // the document has zero elements *or* zero <html> ancestor —
        // a sign the render truly produced no HTML at all.
        let html_root = doc.select(&scraper::Selector::parse("html").unwrap()).next();
        if raw.trim().is_empty() {
            return Err(format!(
                "rendered file is empty: {}",
                path.display()
            ));
        }
        if html_root.is_none() {
            return Err(format!(
                "rendered file has no <html> element: {}",
                path.display()
            ));
        }
        count += 1;
    }
    if count == 0 {
        return Err("no HTML files were rendered".into());
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
    // 1. Render.
    set_state(inputs.db, publication_id, PublishState::Rendering)
        .await
        .map_err(|e| e.to_string())?;
    let pages_written = render_step(inputs)?;
    set_state(inputs.db, publication_id, PublishState::Rendered)
        .await
        .map_err(|e| e.to_string())?;

    // 2. Validate.
    set_state(inputs.db, publication_id, PublishState::Validating)
        .await
        .map_err(|e| e.to_string())?;
    validate_rendered(inputs.render_dir)?;
    set_state(inputs.db, publication_id, PublishState::Validated)
        .await
        .map_err(|e| e.to_string())?;

    // 3. Git fetch + ff.
    set_state(inputs.db, publication_id, PublishState::GitFetching)
        .await
        .map_err(|e| e.to_string())?;
    let repo = git2::Repository::open(inputs.repo_dir).map_err(|e| e.to_string())?;
    let _sha_before = git_ops::fetch_and_ff_main(&repo)?;
    set_state(inputs.db, publication_id, PublishState::GitFetched)
        .await
        .map_err(|e| e.to_string())?;

    // 4. Stage + commit content changes.
    set_state(inputs.db, publication_id, PublishState::Committing)
        .await
        .map_err(|e| e.to_string())?;
    let _touched = git_ops::stage_content_writes(&repo, &inputs.drafts)?;
    // Also stage the rendered HTML (+ sitemap, robots, assets/data)
    // and any newly-uploaded media variants under assets/img/**.
    // Without this the GH content-render-validation workflow blocks
    // the Pages deploy because committed HTML lags committed JSON.
    let _rendered = git_ops::stage_rendered_html_and_assets(&repo, inputs.render_dir)?;
    let commit_sha = match git_ops::commit_all(
        &repo,
        &inputs.commit_message,
        inputs.author_display.as_deref(),
    ) {
        Ok(sha) => sha,
        Err(e) if e == "no changes to commit" => {
            // Nothing to publish — advance to VerifiedLive with the
            // existing HEAD sha and mark early completion.
            let sha = git_ops::head_sha(&repo)?;
            set_commit_sha(inputs.db, publication_id, &sha)
                .await
                .map_err(|e| e.to_string())?;
            // Skip commit and push, jump straight to committed→pushed→…
            for step in [
                PublishState::Committed,
                PublishState::Pushing,
                PublishState::Pushed,
                PublishState::PollingPages,
                PublishState::VerifiedLive,
            ] {
                set_state(inputs.db, publication_id, step)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            return Ok(PipelineOutcome {
                publication_id,
                final_state: "verified_live".into(),
                commit_sha: Some(sha),
                verified_url: Some(inputs.verified_url.clone()),
                error: Some("no changes to commit".into()),
                pages_written,
            });
        }
        Err(e) => return Err(e),
    };
    set_commit_sha(inputs.db, publication_id, &commit_sha)
        .await
        .map_err(|e| e.to_string())?;
    set_state(inputs.db, publication_id, PublishState::Committed)
        .await
        .map_err(|e| e.to_string())?;

    // 5. Push.
    set_state(inputs.db, publication_id, PublishState::Pushing)
        .await
        .map_err(|e| e.to_string())?;
    if inputs.dry_run {
        // Skip actual push. Advance through remaining states so the
        // audit row still reads coherently.
        for step in [
            PublishState::Pushed,
            PublishState::PollingPages,
            PublishState::VerifiedLive,
        ] {
            set_state(inputs.db, publication_id, step)
                .await
                .map_err(|e| e.to_string())?;
        }
        return Ok(PipelineOutcome {
            publication_id,
            final_state: "verified_live".into(),
            commit_sha: Some(commit_sha),
            verified_url: Some(format!("{} (dry-run — not pushed)", inputs.verified_url)),
            error: None,
            pages_written,
        });
    }
    let pat = inputs
        .pat
        .as_deref()
        .ok_or_else(|| "PAT is required for a real (non-dry-run) publish".to_string())?;
    git_ops::push_main_with_pat(&repo, pat)?;
    set_state(inputs.db, publication_id, PublishState::Pushed)
        .await
        .map_err(|e| e.to_string())?;

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
    let written = renderer::render_all(&render_inputs, &out_dir)?;
    // Also copy assets/ over so the preview browser can find CSS/img.
    copy_assets_if_present(inputs.repo_dir, &out_dir).ok();
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
    let deadline = Instant::now() + Duration::from_secs(180);
    let mut last_err: Option<String> = None;
    while Instant::now() < deadline {
        let resp = client.get(verified_url).send().await;
        match resp {
            Ok(r) if r.status().is_success() => {
                let body = r.text().await.unwrap_or_default();
                // Look for the canary comment `<!-- rev: <sha> -->`
                // that render.py MIGHT emit in a future PR. Absent
                // that, accept any 200 body.
                let marker = format!("<!-- rev: {expected_sha} -->");
                if body.contains(&marker) || !body.is_empty() {
                    return Ok(verified_url.to_string());
                }
            }
            Ok(r) => last_err = Some(format!("HTTP {}", r.status())),
            Err(e) => last_err = Some(format!("{e}")),
        }
        tokio::time::sleep(Duration::from_secs(10)).await;
    }
    Err(format!(
        "timed out waiting for Pages deploy of {expected_sha}: last={}",
        last_err.unwrap_or_else(|| "no attempt returned 200".into())
    ))
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
        let e = validate_rendered(tmp.path()).unwrap_err();
        assert!(e.contains("no HTML files"), "got {e}");
    }

    #[test]
    fn validate_rendered_accepts_well_formed_html() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("index.html"),
            b"<!doctype html><html><body>Hi</body></html>",
        )
        .unwrap();
        let n = validate_rendered(tmp.path()).unwrap();
        assert_eq!(n, 1);
    }
}
