//! `site_revisions` / `site_pointers` DB helpers.
//!
//! Every editor save calls [`save_draft`], which appends a new
//! immutable row to `site_revisions` and repoints
//! `site_pointers.active_draft_rev` to it. The publish pipeline then
//! reads the current draft revision per file via [`load_draft`], and
//! records `last_pushed_rev` / `last_verified_live_rev` as the state
//! machine advances.
//!
//! Restoring a previous version is just "insert a new revision whose
//! content_json is a copy of the older row's" — we never mutate
//! existing rows so the history stays honest.

use rusqlite::params;
use serde::Serialize;

use crate::db_gate::{DbError, DbGate};

/// Public row type returned to the frontend for the history screen.
#[derive(Debug, Clone, Serialize)]
pub struct RevisionRow {
    pub id: i64,
    pub file: String,
    pub created_at: String,
    pub author: Option<String>,
    /// Preview of the content — 240 chars max. Used in the history
    /// list; the full content is fetched on demand.
    pub preview: String,
}

/// Pointer state for a single content file.
#[derive(Debug, Clone, Serialize)]
pub struct PointerRow {
    pub file: String,
    pub active_draft_rev: Option<i64>,
    pub last_pushed_rev: Option<i64>,
    pub last_verified_live_rev: Option<i64>,
    pub updated_at: String,
}

/// Persist a draft: append to `site_revisions` and repoint the
/// pointer. Returns the new revision id.
///
/// `content_json` must already be valid JSON — callers should have
/// run [`crate::website::schema::validate`] first. This function
/// stores the raw bytes unchanged so an accidental re-serialize
/// doesn't strip a trailing newline or reorder keys.
///
/// `base_content_hash` is a fingerprint of the working-copy version
/// of `file` at the moment the user opened the editor. Stored so a
/// subsequent editor session can detect that the working copy has
/// moved (git pull, cross-machine publish) since — see
/// [`current_draft_base_hash`].
pub async fn save_draft(
    gate: &DbGate,
    file: &str,
    content_json: &str,
    author: Option<&str>,
    base_content_hash: Option<&str>,
) -> Result<i64, DbError> {
    let file = file.to_string();
    let content_json = content_json.to_string();
    let author = author.map(|s| s.to_string());
    let base_hash = base_content_hash.map(|s| s.to_string());
    gate.with_conn(move |conn| {
        conn.execute(
            "INSERT INTO site_revisions (file, content_json, author, base_content_hash) \
             VALUES (?1, ?2, ?3, ?4)",
            params![file, content_json, author, base_hash],
        )?;
        let new_id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO site_pointers (file, active_draft_rev, updated_at) \
             VALUES (?1, ?2, datetime('now')) \
             ON CONFLICT(file) DO UPDATE SET \
                active_draft_rev = excluded.active_draft_rev, \
                updated_at = datetime('now')",
            params![file, new_id],
        )?;
        Ok(new_id)
    })
    .await
}

/// Return the `base_content_hash` recorded on the current active
/// draft for `file`, or `Ok(None)` if there is no active draft or
/// the row predates the base_content_hash column.
pub async fn current_draft_base_hash(
    gate: &DbGate,
    file: &str,
) -> Result<Option<String>, DbError> {
    let file = file.to_string();
    gate.with_conn(move |conn| {
        let row: Result<Option<Option<String>>, _> = conn
            .query_row(
                "SELECT r.base_content_hash \
                 FROM site_pointers p \
                 JOIN site_revisions r ON r.id = p.active_draft_rev \
                 WHERE p.file = ?1",
                params![file],
                |r| r.get::<_, Option<String>>(0),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            });
        Ok(row?.flatten())
    })
    .await
}

/// Load the current active draft's JSON blob for `file`. Returns
/// `Ok(None)` if there is no draft yet — the caller should fall back
/// to reading the site working copy.
pub async fn load_draft(gate: &DbGate, file: &str) -> Result<Option<String>, DbError> {
    let file = file.to_string();
    gate.with_conn(move |conn| {
        let row: Result<Option<String>, _> = conn
            .query_row(
                "SELECT r.content_json \
                 FROM site_pointers p \
                 JOIN site_revisions r ON r.id = p.active_draft_rev \
                 WHERE p.file = ?1",
                params![file],
                |r| r.get(0),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            });
        Ok(row?)
    })
    .await
}

/// Return every non-null pointer row.
pub async fn list_pointers(gate: &DbGate) -> Result<Vec<PointerRow>, DbError> {
    gate.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT file, active_draft_rev, last_pushed_rev, last_verified_live_rev, updated_at \
             FROM site_pointers ORDER BY file",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(PointerRow {
                file: r.get(0)?,
                active_draft_rev: r.get(1)?,
                last_pushed_rev: r.get(2)?,
                last_verified_live_rev: r.get(3)?,
                updated_at: r.get(4)?,
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

/// Return revisions for `file` most-recent-first, up to `limit`.
pub async fn list_revisions(
    gate: &DbGate,
    file: &str,
    limit: i64,
) -> Result<Vec<RevisionRow>, DbError> {
    let file = file.to_string();
    gate.with_conn(move |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, file, created_at, author, content_json \
             FROM site_revisions WHERE file = ?1 \
             ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![file, limit], |r| {
            let content: String = r.get(4)?;
            Ok(RevisionRow {
                id: r.get(0)?,
                file: r.get(1)?,
                created_at: r.get(2)?,
                author: r.get(3)?,
                preview: truncate_preview(&content),
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

/// Load a specific revision's raw JSON.
pub async fn load_revision(gate: &DbGate, rev_id: i64) -> Result<String, DbError> {
    gate.with_conn(move |conn| {
        let row: String = conn.query_row(
            "SELECT content_json FROM site_revisions WHERE id = ?1",
            params![rev_id],
            |r| r.get(0),
        )?;
        Ok(row)
    })
    .await
}

/// Restore `rev_id` for its file by creating a NEW revision whose
/// content copies the old one. We never mutate history.
///
/// Returns the newly-inserted revision id.
pub async fn restore_revision(
    gate: &DbGate,
    rev_id: i64,
    author: Option<&str>,
) -> Result<i64, DbError> {
    let author = author.map(|s| s.to_string());
    gate.with_conn(move |conn| {
        let (file, content): (String, String) = conn.query_row(
            "SELECT file, content_json FROM site_revisions WHERE id = ?1",
            params![rev_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        conn.execute(
            "INSERT INTO site_revisions (file, content_json, author) VALUES (?1, ?2, ?3)",
            params![
                file,
                content,
                author.unwrap_or_else(|| format!("restored from rev {rev_id}"))
            ],
        )?;
        let new_id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO site_pointers (file, active_draft_rev, updated_at) \
             VALUES (?1, ?2, datetime('now')) \
             ON CONFLICT(file) DO UPDATE SET \
                active_draft_rev = excluded.active_draft_rev, \
                updated_at = datetime('now')",
            params![file, new_id],
        )?;
        Ok(new_id)
    })
    .await
}

/// Advance `last_pushed_rev` for every file that was included in the
/// latest publish.
pub async fn mark_pushed(gate: &DbGate, files: &[String]) -> Result<(), DbError> {
    let files: Vec<String> = files.to_vec();
    gate.with_conn(move |conn| {
        for file in &files {
            conn.execute(
                "UPDATE site_pointers SET \
                    last_pushed_rev = active_draft_rev, \
                    updated_at = datetime('now') \
                 WHERE file = ?1",
                params![file],
            )?;
        }
        Ok(())
    })
    .await
}

/// Advance `last_verified_live_rev` for every file that was
/// confirmed live on GitHub Pages.
pub async fn mark_verified_live(gate: &DbGate, files: &[String]) -> Result<(), DbError> {
    let files: Vec<String> = files.to_vec();
    gate.with_conn(move |conn| {
        for file in &files {
            conn.execute(
                "UPDATE site_pointers SET \
                    last_verified_live_rev = last_pushed_rev, \
                    updated_at = datetime('now') \
                 WHERE file = ?1",
                params![file],
            )?;
        }
        Ok(())
    })
    .await
}

fn truncate_preview(content: &str) -> String {
    const MAX: usize = 240;
    if content.len() <= MAX {
        return content.to_string();
    }
    // Clip on char boundary.
    let mut end = MAX;
    while !content.is_char_boundary(end) && end > 0 {
        end -= 1;
    }
    format!("{}…", &content[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_preview_respects_char_boundaries() {
        let short = "hello";
        assert_eq!(truncate_preview(short), "hello");
        let long: String = "a".repeat(500);
        let p = truncate_preview(&long);
        assert!(p.ends_with('…'));
        assert!(p.chars().count() <= 241); // 240 + ellipsis
    }
}
