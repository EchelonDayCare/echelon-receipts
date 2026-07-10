// Migration checksum self-heal.
//
// tauri-plugin-sql (via sqlx) stores a sha384 checksum of each migration's SQL
// bytes in the `_sqlx_migrations` table. If a migration file is edited after
// having been applied to a live DB, sqlx refuses to open the DB with
// "migration X was previously applied but has been modified" and every
// Database.load() call from the frontend throws — the app renders but no
// query ever succeeds.
//
// We shipped exactly one such edit in commit 64597f2 (008_staff.sql renamed
// `gemini_api_key_set` to `azure_ai_key_set`), and any user upgrading from a
// pre-64597f2 build will hit this wall the first time they open the DMG.
// This module runs BEFORE the SQL plugin opens a connection and rewrites the
// stored checksum for every already-applied migration to match the current
// file's sha384. It NEVER re-runs a migration and NEVER touches any user data.
//
// Long-term hygiene: don't edit shipped migration files. Add a new migration
// with the schema change instead. This heal exists so we can safely ship the
// DMG without stranding existing installs.
//
// Currently DORMANT — not called from lib.rs. Kept in-tree so we can flip
// the switch quickly if a future edit to a shipped migration slips through.
#![allow(dead_code)]

use std::fs;
use std::path::PathBuf;
use sha2::{Digest, Sha384};
use rusqlite::{Connection, OpenFlags, params};
use tauri::Manager;

/// (version, sha384-of-current-SQL-bytes) for every migration we ship.
/// Kept in lockstep with the Migration list in lib.rs — a mismatch here would
/// mean we forgot to update the heal after adding a migration.
fn expected_checksums() -> Vec<(i64, Vec<u8>)> {
    let files: [(i64, &str); 12] = [
        (1, include_str!("../migrations/001_initial.sql")),
        (2, include_str!("../migrations/002_pdf_folder.sql")),
        (3, include_str!("../migrations/003_email.sql")),
        (4, include_str!("../migrations/004_annual_receipts.sql")),
        (5, include_str!("../migrations/005_subsidies.sql")),
        (6, include_str!("../migrations/006_void_audit.sql")),
        (7, include_str!("../migrations/007_issuer_snapshot.sql")),
        (8, include_str!("../migrations/008_staff.sql")),
        (9, include_str!("../migrations/009_staff_credentials.sql")),
        (10, include_str!("../migrations/010_child_attendance.sql")),
        (11, include_str!("../migrations/011_no_lunch.sql")),
        (12, include_str!("../migrations/012_graduation_renders.sql")),
    ];
    files
        .iter()
        .map(|(v, sql)| {
            let mut h = Sha384::new();
            h.update(sql.as_bytes());
            (*v, h.finalize().to_vec())
        })
        .collect()
}

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("app_data_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir app_data_dir: {e}"))?;
    Ok(dir.join("echelon.db"))
}

pub fn heal(app: &tauri::AppHandle) -> Result<(), String> {
    let path = db_path(app)?;
    if !path.exists() {
        // Fresh install — no DB yet, sqlx will create it and apply every
        // migration from scratch. Nothing to heal.
        return Ok(());
    }

    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| format!("open db for heal: {e}"))?;

    // If the migrations tracker table doesn't exist, this DB has never had
    // migrations applied (either brand new or from a build that predates the
    // plugin). Let sqlx handle it — nothing to heal.
    let has_tracker: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| format!("probe tracker: {e}"))?;
    if has_tracker == 0 {
        return Ok(());
    }

    let expected = expected_checksums();
    let mut healed = 0usize;
    for (version, expected_ck) in expected {
        // Only touch rows that already exist AND were successfully applied.
        // A row with success=0 means the migration crashed mid-way; sqlx will
        // retry on next open and we must not lie about its checksum.
        let stored: Option<(Vec<u8>, i64)> = conn
            .query_row(
                "SELECT checksum, success FROM _sqlx_migrations WHERE version = ?1",
                params![version],
                |r| Ok((r.get::<_, Vec<u8>>(0)?, r.get::<_, i64>(1)?)),
            )
            .ok();
        let Some((stored_ck, success)) = stored else { continue };
        if success == 0 {
            continue;
        }
        if stored_ck != expected_ck {
            conn.execute(
                "UPDATE _sqlx_migrations SET checksum = ?1 WHERE version = ?2",
                params![expected_ck, version],
            )
            .map_err(|e| format!("update checksum v{version}: {e}"))?;
            healed += 1;
            eprintln!("[migration_heal] rewrote checksum for v{version}");
        }
    }
    if healed > 0 {
        eprintln!("[migration_heal] healed {healed} migration checksum(s)");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Build a DB with a `_sqlx_migrations` table populated with the given
    /// (version, checksum, success) triples so we can test the heal in isolation.
    fn make_tracker_db(dir: &TempDir, rows: &[(i64, Vec<u8>, i64)]) -> PathBuf {
        let path = dir.path().join("echelon.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute(
            "CREATE TABLE _sqlx_migrations (
                version BIGINT PRIMARY KEY,
                description TEXT NOT NULL,
                installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                success BOOLEAN NOT NULL,
                checksum BLOB NOT NULL,
                execution_time BIGINT NOT NULL
            )",
            [],
        )
        .unwrap();
        for (v, ck, ok) in rows {
            conn.execute(
                "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
                 VALUES (?1, 'x', ?2, ?3, 0)",
                params![v, ok, ck],
            )
            .unwrap();
        }
        path
    }

    fn heal_at(path: &PathBuf) -> Result<(), String> {
        // Bypass AppHandle by inlining the heal body against the given path.
        // Keeps the test hermetic (no tauri runtime needed).
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(|e| format!("open: {e}"))?;
        let has_tracker: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations'",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if has_tracker == 0 {
            return Ok(());
        }
        for (version, expected_ck) in expected_checksums() {
            let stored: Option<(Vec<u8>, i64)> = conn
                .query_row(
                    "SELECT checksum, success FROM _sqlx_migrations WHERE version = ?1",
                    params![version],
                    |r| Ok((r.get::<_, Vec<u8>>(0)?, r.get::<_, i64>(1)?)),
                )
                .ok();
            let Some((stored_ck, success)) = stored else { continue };
            if success == 0 || stored_ck == expected_ck {
                continue;
            }
            conn.execute(
                "UPDATE _sqlx_migrations SET checksum = ?1 WHERE version = ?2",
                params![expected_ck, version],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn stored_checksum(path: &PathBuf, version: i64) -> Option<Vec<u8>> {
        let conn = Connection::open(path).unwrap();
        conn.query_row(
            "SELECT checksum FROM _sqlx_migrations WHERE version = ?1",
            params![version],
            |r| r.get::<_, Vec<u8>>(0),
        )
        .ok()
    }

    #[test]
    fn expected_matches_committed_files() {
        // Every migration in the constant list must exist and be readable.
        // Regenerating expected_checksums() must succeed and produce 11 rows.
        let ck = expected_checksums();
        assert_eq!(ck.len(), 11);
        for (v, h) in &ck {
            assert!(*v >= 1 && *v <= 11);
            assert_eq!(h.len(), 48, "sha384 must be 48 bytes for v{v}");
        }
    }

    #[test]
    fn heals_mismatched_checksum() {
        let tmp = TempDir::new().unwrap();
        let expected = expected_checksums();
        let good_v9 = expected.iter().find(|(v, _)| *v == 9).unwrap().1.clone();
        let bad_v8 = vec![0xDE; 48]; // deliberately wrong for v8
        let path = make_tracker_db(&tmp, &[(8, bad_v8.clone(), 1), (9, good_v9.clone(), 1)]);

        heal_at(&path).unwrap();

        let v8 = stored_checksum(&path, 8).unwrap();
        let v9 = stored_checksum(&path, 9).unwrap();
        let expected_v8 = expected.iter().find(|(v, _)| *v == 8).unwrap().1.clone();
        assert_eq!(v8, expected_v8, "v8 should be rewritten to match file");
        assert_eq!(v9, good_v9, "v9 was already correct, must not be touched");
    }

    #[test]
    fn skips_failed_migrations() {
        // A migration that crashed mid-way (success=0) must NOT be healed.
        // Rewriting its checksum would trick sqlx into thinking a partial
        // apply succeeded, leaving the DB half-migrated forever.
        let tmp = TempDir::new().unwrap();
        let bad = vec![0xAB; 48];
        let path = make_tracker_db(&tmp, &[(8, bad.clone(), 0)]);

        heal_at(&path).unwrap();

        assert_eq!(stored_checksum(&path, 8).unwrap(), bad, "success=0 rows must be left alone");
    }

    #[test]
    fn ignores_unknown_versions() {
        // A DB from a future build with migration v99 must not crash the heal.
        // The heal only touches versions in expected_checksums().
        let tmp = TempDir::new().unwrap();
        let bad_future = vec![0xCC; 48];
        let path = make_tracker_db(&tmp, &[(99, bad_future.clone(), 1)]);

        heal_at(&path).unwrap();

        assert_eq!(stored_checksum(&path, 99).unwrap(), bad_future, "v99 untouched");
    }

    #[test]
    fn tolerates_missing_tracker() {
        // Fresh DB without _sqlx_migrations table — heal should be a no-op.
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("echelon.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute("CREATE TABLE unrelated (x INTEGER)", []).unwrap();
        }
        heal_at(&path).unwrap();
    }
}

