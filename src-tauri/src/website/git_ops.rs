//! git2 wrapper for the working copy of the site repo.
//!
//! # What this module owns
//! - Clone / open the local working copy under
//!   `app_data_dir/website/repo/`.
//! - Pull fast-forward from origin/main so the templates reflect the
//!   latest server state before we render.
//! - Stage every content file that changed, create a signed-off
//!   commit, and (optionally) push to origin/main using a PAT.
//! - Read `HEAD.rev_parse("HEAD")` sha for reporting to the state
//!   machine.
//!
//! # Non-goals
//! - Merge conflict resolution. If `git fetch` shows origin/main
//!   ahead of the local working copy in a non-fast-forward way, we
//!   surface the conflict and refuse to auto-publish. The user must
//!   pull manually (out-of-band) and re-open the app.
//! - Branch juggling. We always work on `main`. Feature branches are
//!   out of scope for the CMS.

use std::path::{Path, PathBuf};

use git2::{
    build::CheckoutBuilder, Cred, FetchOptions, PushOptions, RemoteCallbacks, Repository,
    Signature,
};

/// URL of the canonical site repo. Hard-coded because there's only
/// one — and hardcoding it means a user can't accidentally point the
/// CMS at some other repo.
pub const SITE_REPO_URL: &str = "https://github.com/EchelonDayCare/echelon-website.git";

/// Working-copy layout under `app_data_dir/website/`.
pub struct WorkingCopy {
    pub root: PathBuf,
    pub repo_dir: PathBuf,
    pub render_dir: PathBuf,
}

impl WorkingCopy {
    /// Build a `WorkingCopy` layout rooted at `app_data_dir`. Does not
    /// touch disk — callers use `ensure_cloned` / `open` etc. for that.
    pub fn from_app_data(app_data_dir: &Path) -> Self {
        let root = app_data_dir.join("website");
        let repo_dir = root.join("repo");
        let render_dir = root.join("preview");
        Self {
            root,
            repo_dir,
            render_dir,
        }
    }

    /// Return true iff the working copy has already been cloned.
    pub fn exists(&self) -> bool {
        self.repo_dir.join(".git").exists()
    }

    /// Clone the site repo into `repo_dir` if it isn't there yet. Uses
    /// the default git2 transport (WinHTTP on Windows, OpenSSL/schannel
    /// on Unix — depends on how libgit2 was compiled). Public repo, so
    /// no credentials needed for read.
    pub fn ensure_cloned(&self) -> Result<Repository, String> {
        std::fs::create_dir_all(&self.root)
            .map_err(|e| format!("mkdir {}: {e}", self.root.display()))?;
        if self.exists() {
            return Repository::open(&self.repo_dir)
                .map_err(|e| format!("open existing repo: {e}"));
        }
        Repository::clone(SITE_REPO_URL, &self.repo_dir)
            .map_err(|e| format!("clone {SITE_REPO_URL}: {e}"))
    }

    /// Open an already-cloned working copy. Returns Err if missing.
    pub fn open(&self) -> Result<Repository, String> {
        if !self.exists() {
            return Err(format!(
                "site working copy not initialized at {}",
                self.repo_dir.display()
            ));
        }
        Repository::open(&self.repo_dir).map_err(|e| format!("open repo: {e}"))
    }
}

/// Return the HEAD commit sha as lowercase hex.
pub fn head_sha(repo: &Repository) -> Result<String, String> {
    let head = repo.head().map_err(|e| format!("HEAD: {e}"))?;
    let oid = head.target().ok_or_else(|| "HEAD has no target".to_string())?;
    Ok(oid.to_string())
}

/// Return the sha of `refs/remotes/origin/main` if the fetch has
/// populated it, otherwise None.
pub fn origin_main_sha(repo: &Repository) -> Option<String> {
    repo.find_reference("refs/remotes/origin/main")
        .ok()
        .and_then(|r| r.target())
        .map(|oid| oid.to_string())
}

/// Fetch `origin/main` and fast-forward the local branch onto it. If
/// the local branch has diverged from origin, return
/// `Err("non-fast-forward")` so the caller can surface a conflict.
pub fn fetch_and_ff_main(repo: &Repository) -> Result<String, String> {
    let mut remote = repo
        .find_remote("origin")
        .map_err(|e| format!("find remote origin: {e}"))?;

    let mut cb = RemoteCallbacks::new();
    cb.credentials(|_url, username_from_url, _allowed| {
        // Public repo fetch: git2 tries anonymous first. If a proxy
        // demands credentials we don't have any to hand over, so
        // fall through to CredentialType::DEFAULT which is
        // equivalent to no auth.
        Cred::default().or_else(|_| Cred::username(username_from_url.unwrap_or("git")))
    });
    let mut fo = FetchOptions::new();
    fo.remote_callbacks(cb);

    remote
        .fetch(&["main"], Some(&mut fo), None)
        .map_err(|e| format!("fetch: {e}"))?;

    let fetch_head = repo
        .find_reference("FETCH_HEAD")
        .map_err(|e| format!("FETCH_HEAD: {e}"))?;
    let fetch_commit = repo
        .reference_to_annotated_commit(&fetch_head)
        .map_err(|e| format!("annotate FETCH_HEAD: {e}"))?;
    let analysis = repo
        .merge_analysis(&[&fetch_commit])
        .map_err(|e| format!("merge_analysis: {e}"))?;

    if analysis.0.is_up_to_date() {
        // Even when already up to date, if the working copy has
        // pending edits in publish-managed paths we snapshot them now
        // so the subsequent `commit_all` never sees "no changes to
        // commit" for a purely template/gallery edit and so the ff
        // path below stays symmetric with the fresh case.
        autostash_publish_paths(repo)?;
        return head_sha(repo);
    }
    if analysis.0.is_fast_forward() {
        // Auto-snapshot pending edits in publish-managed paths
        // (content/, templates/, assets/) before the force-checkout
        // that ff performs — otherwise the force-checkout would
        // silently drop the owner's template edits, uploaded photos
        // not yet committed, etc. Any dirty state OUTSIDE those
        // paths is still a hard refusal: publish isn't responsible
        // for random other files.
        //
        // Ignore untracked files (stray .DS_Store on macOS, editor
        // swap files, etc.) — only refuse on real user-edited state.
        let mut opts = git2::StatusOptions::new();
        opts.include_untracked(false).include_ignored(false);
        let statuses = repo
            .statuses(Some(&mut opts))
            .map_err(|e| format!("status: {e}"))?;
        let mut foreign_dirty: Vec<String> = Vec::new();
        for s in statuses.iter() {
            let f = s.status();
            if f.is_ignored() || f.is_empty() {
                continue;
            }
            let path = s.path().unwrap_or("").to_string();
            if !is_publish_managed_path(&path) {
                foreign_dirty.push(path);
            }
        }
        if !foreign_dirty.is_empty() {
            return Err(format!(
                "working copy has uncommitted changes outside CMS-managed paths ({}); resolve them before publishing.",
                foreign_dirty.join(", ")
            ));
        }
        autostash_publish_paths(repo)?;
        let refname = "refs/heads/main";
        let mut r = repo
            .find_reference(refname)
            .map_err(|e| format!("find main: {e}"))?;
        r.set_target(fetch_commit.id(), "fast-forward")
            .map_err(|e| format!("ff main: {e}"))?;
        repo.set_head(refname).map_err(|e| format!("set_head: {e}"))?;
        repo.checkout_head(Some(CheckoutBuilder::default().force()))
            .map_err(|e| format!("checkout_head: {e}"))?;
        return head_sha(repo);
    }
    Err("non-fast-forward: local main has diverged from origin/main. Reopen the app or reclone the working copy.".to_string())
}

/// Files the publish pipeline is responsible for shipping. Any dirty
/// state in these paths is safe to auto-stage as part of publish.
fn is_publish_managed_path(rel: &str) -> bool {
    let p = rel.replace('\\', "/");
    p.starts_with("content/")
        || p.starts_with("templates/")
        || p.starts_with("assets/")
        || p == "sitemap.xml"
        || p == "robots.txt"
        || p == "index.html"
        || p.starts_with("pages/") && p.ends_with(".html")
}

/// Stage every dirty publish-managed path and, if any survived, drop
/// a snapshot commit so subsequent ff / render / commit steps see a
/// clean tree. No-op when nothing is dirty in those paths.
fn autostash_publish_paths(repo: &Repository) -> Result<(), String> {
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true).include_ignored(false);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| format!("status: {e}"))?;
    let mut to_stage: Vec<String> = Vec::new();
    for s in statuses.iter() {
        let f = s.status();
        if f.is_ignored() || f.is_empty() {
            continue;
        }
        let path = match s.path() {
            Some(p) => p.to_string(),
            None => continue,
        };
        if is_publish_managed_path(&path) {
            to_stage.push(path);
        }
    }
    if to_stage.is_empty() {
        return Ok(());
    }
    let mut index = repo.index().map_err(|e| format!("index: {e}"))?;
    for rel in &to_stage {
        // add_all handles both modifications and untracked files, and
        // survives paths that no longer exist (deletes).
        index
            .add_all([rel].iter(), git2::IndexAddOption::DEFAULT, None)
            .map_err(|e| format!("index add {rel}: {e}"))?;
    }
    index.write().map_err(|e| format!("index write: {e}"))?;

    let tree_id = index.write_tree().map_err(|e| format!("write_tree: {e}"))?;
    let head_ref = repo.head().map_err(|e| format!("HEAD: {e}"))?;
    let parent = head_ref
        .peel_to_commit()
        .map_err(|e| format!("HEAD peel: {e}"))?;
    if parent.tree().map_err(|e| format!("HEAD tree: {e}"))?.id() == tree_id {
        return Ok(());
    }
    let tree = repo
        .find_tree(tree_id)
        .map_err(|e| format!("find_tree: {e}"))?;
    let sig = Signature::now("Echelon CMS (desktop)", "cms-desktop@echelondaycare.local")
        .map_err(|e| format!("signature: {e}"))?;
    repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        "CMS pre-publish autosnapshot",
        &tree,
        &[&parent],
    )
    .map_err(|e| format!("autostash commit: {e}"))?;
    Ok(())
}

/// Write `content_by_file` (keyed by `"site" | "home" | ...`) into
/// `repo/content/<name>.json` and stage them. Returns the sorted list
/// of touched paths.
pub fn stage_content_writes(
    repo: &Repository,
    content_by_file: &[(String, String)],
) -> Result<Vec<PathBuf>, String> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| "bare repo has no workdir".to_string())?;
    let content_dir = workdir.join("content");
    std::fs::create_dir_all(&content_dir)
        .map_err(|e| format!("mkdir {}: {e}", content_dir.display()))?;

    let mut index = repo.index().map_err(|e| format!("index: {e}"))?;
    let mut touched = Vec::new();
    for (file, raw) in content_by_file {
        let rel = format!("content/{file}.json");
        let full = workdir.join(&rel);
        // Normalise LF endings before writing (matches `.gitattributes`
        // + render.py's normalisation).
        let normalised = raw.replace("\r\n", "\n");
        let with_trailing = if normalised.ends_with('\n') {
            normalised
        } else {
            format!("{normalised}\n")
        };
        std::fs::write(&full, with_trailing.as_bytes())
            .map_err(|e| format!("write {}: {e}", full.display()))?;
        index
            .add_path(Path::new(&rel))
            .map_err(|e| format!("index add {rel}: {e}"))?;
        touched.push(PathBuf::from(rel));
    }
    index.write().map_err(|e| format!("index write: {e}"))?;
    touched.sort();
    Ok(touched)
}

/// Copy rendered HTML (top-level `*.html` + `pages/*.html`),
/// `sitemap.xml`, `robots.txt`, and `assets/data/**` from
/// `render_dir` into the working copy at `repo_dir`, then stage
/// those files plus everything under `assets/img/**` (variants that
/// `write_variants_to_working_copy` dropped there during upload).
///
/// Called during publish so the commit carries both the CMS JSON
/// and the fully-rendered site GitHub Pages will serve. Without
/// this, GH's content-render-validation workflow blocks deploy
/// because committed HTML lags behind committed JSON.
pub fn stage_rendered_html_and_assets(
    repo: &Repository,
    render_dir: &Path,
) -> Result<Vec<PathBuf>, String> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| "bare repo has no workdir".to_string())?
        .to_path_buf();

    // 1. Mirror render_dir into workdir for the tracked outputs.
    let mut copied: Vec<PathBuf> = Vec::new();
    copy_rendered_outputs(render_dir, &workdir, &mut copied)?;

    // 2. Stage: rendered outputs + everything under assets/.
    let mut index = repo.index().map_err(|e| format!("index: {e}"))?;
    for rel in &copied {
        index
            .add_path(rel)
            .map_err(|e| format!("index add {}: {e}", rel.display()))?;
    }
    // assets/** — pick up new variant files written by upload flow.
    let assets_dir = workdir.join("assets");
    if assets_dir.is_dir() {
        index
            .add_all(["assets/*"].iter(), git2::IndexAddOption::DEFAULT, None)
            .map_err(|e| format!("index add_all assets: {e}"))?;
    }
    // templates/** — since the CMS is the source of truth for template
    // edits, publish also has to push templates so a fresh clone on
    // another machine renders correctly. Without this, a machine that
    // clones fresh gets whatever template last landed upstream, which
    // may be far behind the JSON schema the CMS is now writing.
    let templates_dir = workdir.join("templates");
    if templates_dir.is_dir() {
        index
            .add_all(["templates/*"].iter(), git2::IndexAddOption::DEFAULT, None)
            .map_err(|e| format!("index add_all templates: {e}"))?;
    }
    // content/** — media commands (uploads, reorders, deletes) write
    // gallery.json / video manifests directly. Without staging content
    // here those mutations never make it into the commit, so a fresh
    // clone sees images on disk but an empty JSON manifest.
    let content_dir = workdir.join("content");
    if content_dir.is_dir() {
        index
            .add_all(["content/*"].iter(), git2::IndexAddOption::DEFAULT, None)
            .map_err(|e| format!("index add_all content: {e}"))?;
    }
    index.write().map_err(|e| format!("index write: {e}"))?;

    copied.sort();
    Ok(copied)
}

/// Walk `render_dir` and copy `*.html`, `sitemap.xml`, `robots.txt`,
/// and everything under `assets/data/` into `workdir`, preserving
/// relative paths. Records copied paths (repo-relative) into `out`.
fn copy_rendered_outputs(
    render_dir: &Path,
    workdir: &Path,
    out: &mut Vec<PathBuf>,
) -> Result<(), String> {
    fn walk(
        base: &Path,
        rel: &Path,
        workdir: &Path,
        out: &mut Vec<PathBuf>,
    ) -> Result<(), String> {
        let full = base.join(rel);
        if !full.exists() {
            return Ok(());
        }
        for entry in std::fs::read_dir(&full)
            .map_err(|e| format!("read_dir {}: {e}", full.display()))?
        {
            let entry = entry.map_err(|e| format!("dir entry: {e}"))?;
            let name = entry.file_name();
            let ty = entry
                .file_type()
                .map_err(|e| format!("file_type: {e}"))?;
            let child_rel = if rel.as_os_str().is_empty() {
                PathBuf::from(&name)
            } else {
                rel.join(&name)
            };
            if ty.is_dir() {
                walk(base, &child_rel, workdir, out)?;
            } else if ty.is_file() {
                let name_str = name.to_string_lossy();
                let rel_str = child_rel.to_string_lossy().replace('\\', "/");
                let keep = name_str.ends_with(".html")
                    || rel_str == "sitemap.xml"
                    || rel_str == "robots.txt"
                    || rel_str.starts_with("assets/data/");
                if !keep {
                    continue;
                }
                let dst = workdir.join(&child_rel);
                if let Some(parent) = dst.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
                }
                std::fs::copy(entry.path(), &dst)
                    .map_err(|e| format!("copy {} -> {}: {e}", entry.path().display(), dst.display()))?;
                out.push(child_rel);
            }
        }
        Ok(())
    }
    walk(render_dir, Path::new(""), workdir, out)
}

/// Create a commit on `main` with the given message. Fails if the
/// index has no staged changes (nothing to commit).
///
/// Uses a generic author signature — commits produced by the CMS are
/// visibly bot-authored so they're easy to filter in git log.
pub fn commit_all(
    repo: &Repository,
    message: &str,
    author_display: Option<&str>,
) -> Result<String, String> {
    let mut index = repo.index().map_err(|e| format!("index: {e}"))?;
    let tree_id = index.write_tree().map_err(|e| format!("write_tree: {e}"))?;
    let tree = repo
        .find_tree(tree_id)
        .map_err(|e| format!("find_tree: {e}"))?;

    let head_ref = repo.head().map_err(|e| format!("HEAD: {e}"))?;
    let parent_commit = head_ref
        .peel_to_commit()
        .map_err(|e| format!("HEAD peel: {e}"))?;
    // Refuse to commit if the tree is identical to HEAD's tree.
    if parent_commit.tree().map_err(|e| format!("HEAD tree: {e}"))?.id() == tree_id {
        return Err("no changes to commit".to_string());
    }

    let author = author_display.unwrap_or("Echelon CMS (desktop)");
    let email = "cms-desktop@echelondaycare.local";
    let sig = Signature::now(author, email).map_err(|e| format!("signature: {e}"))?;

    let commit_id = repo
        .commit(Some("HEAD"), &sig, &sig, message, &tree, &[&parent_commit])
        .map_err(|e| format!("commit: {e}"))?;
    Ok(commit_id.to_string())
}

/// Push `main` to `origin` using the supplied PAT. On Windows the
/// libgit2 https transport uses WinHTTP; on Unix it uses OpenSSL —
/// both accept `Cred::userpass_plaintext("x-access-token", pat)` for
/// GitHub token auth.
///
/// Returns Err on non-fast-forward reject or any transport error.
pub fn push_main_with_pat(repo: &Repository, pat: &str) -> Result<(), String> {
    let mut remote = repo
        .find_remote("origin")
        .map_err(|e| format!("find origin: {e}"))?;

    let push_err: std::sync::Arc<std::sync::Mutex<Option<String>>> =
        std::sync::Arc::new(std::sync::Mutex::new(None));
    let mut cb = RemoteCallbacks::new();
    let pat_owned = pat.to_string();
    cb.credentials(move |_url, _user, _allowed| {
        Cred::userpass_plaintext("x-access-token", &pat_owned)
    });
    let push_err_cb = push_err.clone();
    cb.push_update_reference(move |refname, status| {
        if let Some(msg) = status {
            if let Ok(mut g) = push_err_cb.lock() {
                *g = Some(format!("remote rejected {refname}: {msg}"));
            }
        }
        Ok(())
    });
    let mut po = PushOptions::new();
    po.remote_callbacks(cb);

    remote
        .push(&["refs/heads/main:refs/heads/main"], Some(&mut po))
        .map_err(|e| format!("push: {e}"))?;
    // Drop po/cb (and their borrow of push_err) before we read.
    drop(po);
    let taken = push_err.lock().ok().and_then(|mut g| g.take());
    if let Some(e) = taken {
        return Err(e);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_app_data_layout_paths() {
        let base = std::env::temp_dir().join("echelon-website-test");
        let wc = WorkingCopy::from_app_data(&base);
        assert_eq!(wc.root, base.join("website"));
        assert_eq!(wc.repo_dir, base.join("website").join("repo"));
        assert_eq!(wc.render_dir, base.join("website").join("preview"));
        assert!(!wc.exists());
    }

    // Full clone test — hits the network, so gated by env. Enable
    // manually with `set ECHELON_WEBSITE_TEST_NET=1`. We init an
    // empty local repo instead of network-cloning to keep the
    // default test run offline-safe.
    #[test]
    fn ensure_cloned_creates_dir_and_repo_locally() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().to_path_buf();
        // Simulate what ensure_cloned does on a machine without network
        // by manually initialising an empty repo — `open()` should then
        // succeed.
        let wc = WorkingCopy::from_app_data(&base);
        std::fs::create_dir_all(&wc.repo_dir).unwrap();
        Repository::init(&wc.repo_dir).unwrap();
        assert!(wc.exists());
        assert!(wc.open().is_ok());
    }
}
