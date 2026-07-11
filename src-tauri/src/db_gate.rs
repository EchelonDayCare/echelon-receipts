// Day 5 scaffolding: Rust-side DB gate.
//
// Once complete (Day 5b), this module fully replaces
// `@tauri-apps/plugin-sql`. The frontend will call two Tauri commands
// (`db_query` and `db_execute`) that route through a single connection
// held here behind a Tokio mutex.
//
// Two open modes:
//   * open_plaintext(path)             - pre-migration (v1.x compat)
//   * open_encrypted(path, mdk_hex)    - v2.0.0 SQLCipher (needs
//                                        rusqlite "bundled-sqlcipher-
//                                        vendored-openssl" feature)
//
// The pool is intentionally single-connection. tauri-plugin-sql used
// sqlx multi-connection SqlitePool which surfaced intermittent
// "database is locked" errors on macOS because per-connection PRAGMAs
// (busy_timeout, foreign_keys) didn't propagate. A single connection
// serialises writes, matches JS single-threadedness, and lets us
// zeroize the SQLCipher key cleanly on lock.
//
// Locking is atomic: `is_unlocked()` and connection presence are
// checked under the same Mutex acquisition to eliminate the TOCTOU
// gap Opus flagged in the architecture review.

use std::path::Path;
use std::sync::Arc;

use rusqlite::types::ValueRef;
use rusqlite::{params_from_iter, Connection};
use serde_json::{Map, Value};
use tokio::sync::Mutex;

use crate::security::Mdk;

// ────────────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("db is locked (no active connection)")]
    Locked,

    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("unsupported json value at index {0}")]
    UnsupportedArg(usize),

    #[error("sqlcipher not compiled in (rusqlite bundled-sqlcipher feature required)")]
    SqlCipherUnavailable,
}

impl serde::Serialize for DbError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

// ────────────────────────────────────────────────────────────────────────
// Gate
// ────────────────────────────────────────────────────────────────────────

/// Handle held in Tauri app state. Cheap to clone — the actual
/// connection lives behind an Arc<Mutex<...>>.
#[derive(Clone, Default)]
pub struct DbGate {
    inner: Arc<Mutex<Option<Connection>>>,
}

impl DbGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// Open an unencrypted SQLite DB. Used during v1.x → v2.0.0
    /// migration; replaced by open_encrypted() once the DB is
    /// SQLCipher-encrypted.
    pub async fn open_plaintext(&self, path: &Path) -> Result<(), DbError> {
        let mut guard = self.inner.lock().await;
        if let Some(old) = guard.take() {
            drop(old);
        }
        let conn = Connection::open(path)?;
        apply_startup_pragmas(&conn, None)?;
        *guard = Some(conn);
        Ok(())
    }

    /// Open a SQLCipher-encrypted DB with the supplied master key.
    ///
    /// Uses `PRAGMA key = "x'<hex>'"` (raw key syntax) which does NOT
    /// run Argon2 or PBKDF2 — we already did KDF via
    /// security::unwrap_mdk. The hex form avoids Opus's B5 (bytes
    /// containing NUL breaking passphrase parsing).
    ///
    /// Fails cleanly at compile time when the rusqlite bundled-sqlcipher
    /// feature isn't enabled, so nothing silently opens a plain-SQLite
    /// DB thinking it's encrypted.
    pub async fn open_encrypted(&self, path: &Path, mdk: &Mdk) -> Result<(), DbError> {
        if !cfg!(feature = "sqlcipher") {
            return Err(DbError::SqlCipherUnavailable);
        }
        let mut guard = self.inner.lock().await;
        if let Some(old) = guard.take() {
            drop(old);
        }
        let conn = Connection::open(path)?;
        // Encode key on the fly and drop the hex buffer immediately.
        // Using a scoped zeroizing string prevents lingering plaintext
        // hex representations in the heap.
        {
            let hex = zeroize::Zeroizing::new(hex_lower(mdk.as_bytes()));
            let key_pragma = format!("PRAGMA key = \"x'{}'\"", &*hex);
            let key_pragma = zeroize::Zeroizing::new(key_pragma);
            conn.execute_batch(&key_pragma)?;
        }
        apply_startup_pragmas(&conn, Some(SqlCipherOpts::default()))?;
        // Sanity ping to ensure the key is correct — a wrong key
        // succeeds at PRAGMA time but fails on the first read.
        conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))?;
        *guard = Some(conn);
        Ok(())
    }

    /// Close and zeroise the connection. Called on lock, sleep, or
    /// explicit sign-out. The SQLCipher page cache is freed with the
    /// connection so no plaintext pages remain in process memory.
    pub async fn close(&self) {
        let mut guard = self.inner.lock().await;
        if let Some(conn) = guard.take() {
            let _ = conn.close();
        }
    }

    /// Run a closure with the live connection. Blocks other DB users for
    /// the duration of the closure (the DbGate is a single-connection
    /// mutex). Used by cross-cutting features (vault ZIP export etc.)
    /// that need to read/write via rusqlite APIs the JS layer can't
    /// express — instead of opening a second `Connection::open` on the
    /// same file, which would bypass the SQLCipher key and fail on an
    /// encrypted DB.
    pub async fn with_conn<F, R>(&self, f: F) -> Result<R, DbError>
    where
        F: FnOnce(&Connection) -> Result<R, DbError>,
    {
        let guard = self.inner.lock().await;
        let conn = guard.as_ref().ok_or(DbError::Locked)?;
        f(conn)
    }

    pub async fn is_open(&self) -> bool {
        self.inner.lock().await.is_some()
    }

    /// Force any pending WAL frames to be checkpointed back into the
    /// main DB and truncate the WAL file to zero length. Called right
    /// before close-and-migrate so recent transactions are guaranteed
    /// to be in the main file that sqlcipher_export reads from.
    pub async fn checkpoint_wal(&self) -> Result<(), DbError> {
        let guard = self.inner.lock().await;
        let conn = guard.as_ref().ok_or(DbError::Locked)?;
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        Ok(())
    }

    /// Export the live database (encrypted or plaintext) to `dst` as a
    /// portable plaintext SQLite file. Uses SQLCipher's `sqlcipher_export`
    /// which walks the sqlite_master and copies schema + all rows into
    /// the attached destination with an empty key (⇒ plain SQLite).
    ///
    /// This is the ONLY correct way to hand a SQLCipher-encrypted DB to
    /// a machine that can't decrypt it: a raw file copy of `echelon.db`
    /// yields opaque ciphertext bytes that `restore.rs` will reject.
    ///
    /// Callers MUST hold the DB lock via the app's normal write path
    /// and MUST wipe `dst` on failure — this function overwrites but
    /// doesn't clean up.
    pub async fn export_plaintext_to(&self, dst: &Path) -> Result<(), DbError> {
        let guard = self.inner.lock().await;
        let conn = guard.as_ref().ok_or(DbError::Locked)?;
        // Checkpoint first so every committed transaction is in the
        // main file (sqlcipher_export reads main, not WAL frames the
        // way SQLite normally does at query time).
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        // Remove any stale destination — sqlcipher_export appends to an
        // existing DB, which would silently mix old + new rows.
        if dst.exists() {
            std::fs::remove_file(dst)?;
        }
        let dst_str = dst.to_string_lossy().replace('\'', "''");
        // Empty KEY '' ⇒ plain SQLite output. This works whether the
        // source is encrypted or plaintext; sqlcipher_export is defined
        // when the bundled-sqlcipher feature is compiled in.
        let attach = format!("ATTACH DATABASE '{}' AS plain_export KEY ''", dst_str);
        conn.execute_batch(&attach)?;
        // Best-effort DETACH on failure so we don't leave the handle
        // dangling. The subsequent operation is idempotent.
        let export_res = conn.execute_batch("SELECT sqlcipher_export('plain_export')");
        let detach_res = conn.execute_batch("DETACH DATABASE plain_export");
        export_res?;
        detach_res?;
        Ok(())
    }

    /// Apply embedded schema migrations idempotently. Called at
    /// startup. Backfills from `_sqlx_migrations` (the tracking table
    /// tauri-plugin-sql used in v1.x) so users upgrading from v1.8.1
    /// don't re-run migrations that already ran under the old plugin.
    pub async fn run_migrations(
        &self,
        migrations: &[(i64, &str, &str)],
    ) -> Result<(), DbError> {
        let guard = self.inner.lock().await;
        let conn = guard.as_ref().ok_or(DbError::Locked)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS _migrations (\
                 version INTEGER PRIMARY KEY,\
                 description TEXT NOT NULL,\
                 applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\
             )",
        )?;
        // Backfill from legacy plugin-sql tracking table if present.
        let has_legacy: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master \
                 WHERE type='table' AND name='_sqlx_migrations'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if has_legacy > 0 {
            let mut stmt = conn.prepare(
                "SELECT version, description FROM _sqlx_migrations \
                 WHERE success = 1",
            )?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let v: i64 = row.get(0)?;
                let d: String = row.get(1)?;
                conn.execute(
                    "INSERT OR IGNORE INTO _migrations(version, description) \
                     VALUES(?, ?)",
                    rusqlite::params![v, d],
                )?;
            }
        }
        // Apply anything not yet recorded, in ascending version order.
        let mut sorted: Vec<_> = migrations.iter().collect();
        sorted.sort_by_key(|(v, _, _)| *v);
        for (version, description, sql) in sorted {
            let already: i64 = conn.query_row(
                "SELECT count(*) FROM _migrations WHERE version = ?",
                rusqlite::params![version],
                |r| r.get(0),
            )?;
            if already > 0 {
                continue;
            }
            conn.execute_batch(sql)?;
            conn.execute(
                "INSERT INTO _migrations(version, description) VALUES(?, ?)",
                rusqlite::params![version, description],
            )?;
        }
        Ok(())
    }

    /// SELECT-style query. Rows are returned as `[{ "col": <json>, ... }]`.
    /// Matches the JSON shape tauri-plugin-sql's `select()` returns so
    /// the frontend db.ts shim can be a straight swap.
    pub async fn select(
        &self,
        sql: &str,
        args: &[Value],
    ) -> Result<Vec<Map<String, Value>>, DbError> {
        let (_cols, rows) = self.select_with_columns(sql, args).await?;
        Ok(rows)
    }

    /// Like `select`, but also returns the column-name list from the
    /// prepared statement. Ask Echelon uses this so empty result sets
    /// still emit headers and column order follows the SELECT clause
    /// even when there are zero rows (the row loop can't derive column
    /// metadata after the fact).
    pub async fn select_with_columns(
        &self,
        sql: &str,
        args: &[Value],
    ) -> Result<(Vec<String>, Vec<Map<String, Value>>), DbError> {
        let guard = self.inner.lock().await;
        let conn = guard.as_ref().ok_or(DbError::Locked)?;
        let mut stmt = conn.prepare_cached(sql)?;
        let col_names: Vec<String> =
            stmt.column_names().iter().map(|s| s.to_string()).collect();
        let rusqlite_args = json_args_to_sql(args)?;
        let mut rows = stmt.query(params_from_iter(rusqlite_args.iter()))?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            let mut map = Map::with_capacity(col_names.len());
            for (i, name) in col_names.iter().enumerate() {
                map.insert(name.clone(), value_ref_to_json(row.get_ref(i)?));
            }
            out.push(map);
        }
        Ok((col_names, out))
    }

    /// INSERT/UPDATE/DELETE/CREATE/DROP/PRAGMA. Returns lastInsertId +
    /// rowsAffected, matching tauri-plugin-sql's `execute()` response.
    ///
    /// Supports either a single statement or a `;`-separated batch of
    /// statements. Multi-statement batches ignore `args` (matches
    /// existing frontend usage — schema migrations only).
    pub async fn execute(
        &self,
        sql: &str,
        args: &[Value],
    ) -> Result<ExecuteResult, DbError> {
        let guard = self.inner.lock().await;
        let conn = guard.as_ref().ok_or(DbError::Locked)?;
        if args.is_empty() && has_multiple_statements(sql) {
            conn.execute_batch(sql)?;
            return Ok(ExecuteResult {
                last_insert_id: 0,
                rows_affected: 0,
            });
        }
        let rusqlite_args = json_args_to_sql(args)?;
        let mut stmt = conn.prepare_cached(sql)?;
        let rows_affected = stmt.execute(params_from_iter(rusqlite_args.iter()))?;
        Ok(ExecuteResult {
            last_insert_id: conn.last_insert_rowid().max(0) as u64,
            rows_affected: rows_affected as u64,
        })
    }
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
pub struct ExecuteResult {
    #[serde(rename = "lastInsertId")]
    pub last_insert_id: u64,
    #[serde(rename = "rowsAffected")]
    pub rows_affected: u64,
}

#[derive(Debug, Default)]
struct SqlCipherOpts;

/// PRAGMAs applied on every open. When SQLCipher is in use we also pin
/// cipher_page_size / cipher_hmac_algorithm to a compatibility profile
/// so future SQLCipher upgrades don't silently change the on-disk
/// format under an existing DB.
fn apply_startup_pragmas(
    conn: &Connection,
    sqlcipher_opts: Option<SqlCipherOpts>,
) -> Result<(), rusqlite::Error> {
    if sqlcipher_opts.is_some() {
        conn.execute_batch(
            "\
             PRAGMA cipher_compatibility = 4;\
             PRAGMA cipher_page_size = 4096;\
             PRAGMA cipher_hmac_algorithm = HMAC_SHA512;\
             ",
        )?;
    }
    conn.execute_batch(
        "\
         PRAGMA journal_mode = WAL;\
         PRAGMA synchronous = NORMAL;\
         PRAGMA foreign_keys = ON;\
         PRAGMA busy_timeout = 5000;\
         PRAGMA temp_store = MEMORY;\
         PRAGMA cache_size = -65536;\
         PRAGMA mmap_size = 268435456;\
         ",
    )?;
    Ok(())
}

fn has_multiple_statements(sql: &str) -> bool {
    // Cheap heuristic: at least one `;` followed by more non-whitespace.
    let trimmed = sql.trim_end().trim_end_matches(';');
    trimmed.contains(';')
}

fn hex_lower(bytes: &[u8]) -> String {
    const CHARS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(CHARS[(b >> 4) as usize] as char);
        out.push(CHARS[(b & 0x0f) as usize] as char);
    }
    out
}

/// Convert `[serde_json::Value]` bind args into `Box<dyn ToSql>` values.
/// Numbers, strings, null, bool, and small integer-typed arrays are
/// supported. Arrays of ints are treated as BLOBs so binary columns
/// (image thumbnails, PDF blobs) work from JS.
fn json_args_to_sql(
    args: &[Value],
) -> Result<Vec<Box<dyn rusqlite::ToSql>>, DbError> {
    let mut out: Vec<Box<dyn rusqlite::ToSql>> = Vec::with_capacity(args.len());
    for (idx, v) in args.iter().enumerate() {
        let boxed: Box<dyn rusqlite::ToSql> = match v {
            Value::Null => Box::new(Option::<i64>::None),
            Value::Bool(b) => Box::new(*b as i64),
            Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    Box::new(i)
                } else if let Some(f) = n.as_f64() {
                    Box::new(f)
                } else {
                    return Err(DbError::UnsupportedArg(idx));
                }
            }
            Value::String(s) => Box::new(s.clone()),
            Value::Array(arr) => {
                let mut bytes = Vec::with_capacity(arr.len());
                for elem in arr {
                    let b = elem
                        .as_u64()
                        .and_then(|u| u8::try_from(u).ok())
                        .ok_or(DbError::UnsupportedArg(idx))?;
                    bytes.push(b);
                }
                Box::new(bytes)
            }
            Value::Object(_) => return Err(DbError::UnsupportedArg(idx)),
        };
        out.push(boxed);
    }
    Ok(out)
}

fn value_ref_to_json(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => serde_json::Number::from_f64(f)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        ValueRef::Text(t) => {
            String::from_utf8(t.to_vec()).map(Value::String).unwrap_or(Value::Null)
        }
        ValueRef::Blob(b) => {
            Value::Array(b.iter().map(|byte| Value::from(*byte)).collect())
        }
    }
}

// ────────────────────────────────────────────────────────────────────────
// Tauri commands
// ────────────────────────────────────────────────────────────────────────
//
// Wired into the Tauri builder in Day 5b at the same time the frontend
// db.ts shim starts calling invoke("db_query" | "db_execute", ...).

#[tauri::command]
pub async fn db_query(
    state: tauri::State<'_, DbGate>,
    sql: String,
    args: Vec<Value>,
) -> Result<Vec<Map<String, Value>>, DbError> {
    state.select(&sql, &args).await
}

#[tauri::command]
pub async fn db_execute(
    state: tauri::State<'_, DbGate>,
    sql: String,
    args: Vec<Value>,
) -> Result<ExecuteResult, DbError> {
    state.execute(&sql, &args).await
}

#[tauri::command]
pub async fn db_is_open(state: tauri::State<'_, DbGate>) -> Result<bool, DbError> {
    Ok(state.is_open().await)
}

#[tauri::command]
pub async fn db_close(state: tauri::State<'_, DbGate>) -> Result<(), DbError> {
    state.close().await;
    Ok(())
}

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn opened_gate() -> (DbGate, tempfile::TempDir) {
        let d = tempfile::tempdir().unwrap();
        let gate = DbGate::new();
        gate.open_plaintext(&d.path().join("t.db")).await.unwrap();
        gate.execute(
            "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, qty INTEGER, cost REAL)",
            &[],
        )
        .await
        .unwrap();
        (gate, d)
    }

    #[tokio::test]
    async fn insert_and_select() {
        let (gate, _d) = opened_gate().await;
        let r = gate
            .execute(
                "INSERT INTO items(name, qty, cost) VALUES(?, ?, ?)",
                &[json!("widget"), json!(3), json!(1.5)],
            )
            .await
            .unwrap();
        assert_eq!(r.rows_affected, 1);
        assert_eq!(r.last_insert_id, 1);

        let rows = gate
            .select("SELECT id, name, qty, cost FROM items", &[])
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("name").unwrap(), &json!("widget"));
        assert_eq!(rows[0].get("qty").unwrap(), &json!(3));
        assert_eq!(rows[0].get("cost").unwrap(), &json!(1.5));
    }

    #[tokio::test]
    async fn null_and_bool_bindings() {
        let (gate, _d) = opened_gate().await;
        gate.execute(
            "INSERT INTO items(name, qty) VALUES(?, ?)",
            &[json!("null-qty"), json!(null)],
        )
        .await
        .unwrap();
        gate.execute(
            "INSERT INTO items(name, qty) VALUES(?, ?)",
            &[json!("bool"), json!(true)],
        )
        .await
        .unwrap();
        let rows = gate
            .select("SELECT name, qty FROM items ORDER BY id", &[])
            .await
            .unwrap();
        assert_eq!(rows[0].get("qty").unwrap(), &json!(null));
        assert_eq!(rows[1].get("qty").unwrap(), &json!(1));
    }

    #[tokio::test]
    async fn blob_round_trip() {
        let d = tempfile::tempdir().unwrap();
        let gate = DbGate::new();
        gate.open_plaintext(&d.path().join("t.db")).await.unwrap();
        gate.execute("CREATE TABLE b (data BLOB)", &[]).await.unwrap();
        let bytes = vec![0u8, 1, 2, 255, 128];
        gate.execute(
            "INSERT INTO b(data) VALUES(?)",
            &[Value::Array(bytes.iter().map(|b| json!(*b)).collect())],
        )
        .await
        .unwrap();
        let rows = gate.select("SELECT data FROM b", &[]).await.unwrap();
        let got = rows[0].get("data").unwrap().as_array().unwrap();
        let got_bytes: Vec<u8> = got.iter().map(|v| v.as_u64().unwrap() as u8).collect();
        assert_eq!(got_bytes, bytes);
    }

    #[tokio::test]
    async fn multi_statement_batch_without_args() {
        let (gate, _d) = opened_gate().await;
        gate.execute(
            "INSERT INTO items(name) VALUES('a'); INSERT INTO items(name) VALUES('b');",
            &[],
        )
        .await
        .unwrap();
        let rows = gate.select("SELECT count(*) AS n FROM items", &[]).await.unwrap();
        assert_eq!(rows[0].get("n").unwrap(), &json!(2));
    }

    #[tokio::test]
    async fn locked_when_closed() {
        let (gate, _d) = opened_gate().await;
        gate.close().await;
        assert!(!gate.is_open().await);
        let err = gate.select("SELECT 1", &[]).await.unwrap_err();
        assert!(matches!(err, DbError::Locked));
    }

    #[tokio::test]
    async fn reopen_replaces_previous_connection() {
        let d = tempfile::tempdir().unwrap();
        let gate = DbGate::new();
        gate.open_plaintext(&d.path().join("a.db")).await.unwrap();
        gate.execute("CREATE TABLE a (x INT)", &[]).await.unwrap();
        gate.open_plaintext(&d.path().join("b.db")).await.unwrap();
        // Table `a` was in the previous DB; new DB should not have it.
        let err = gate.select("SELECT * FROM a", &[]).await.unwrap_err();
        assert!(matches!(err, DbError::Sqlite(_)));
    }

    #[tokio::test]
    async fn unsupported_arg_object() {
        let (gate, _d) = opened_gate().await;
        let err = gate
            .execute(
                "INSERT INTO items(name) VALUES(?)",
                &[json!({"nope": true})],
            )
            .await
            .unwrap_err();
        assert!(matches!(err, DbError::UnsupportedArg(_)));
    }

    #[tokio::test]
    async fn open_encrypted_round_trip() {
        // SQLCipher is compiled in (default feature). Confirm we can
        // create -> write -> reopen with the same key.
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("enc.db");
        let mdk = Mdk::generate();
        let gate = DbGate::new();
        gate.open_encrypted(&path, &mdk).await.unwrap();
        gate.execute("CREATE TABLE k (v INTEGER)", &[]).await.unwrap();
        gate.execute("INSERT INTO k(v) VALUES(42)", &[]).await.unwrap();
        gate.close().await;

        // Reopen with same key.
        gate.open_encrypted(&path, &mdk).await.unwrap();
        let rows = gate.select("SELECT v FROM k", &[]).await.unwrap();
        assert_eq!(rows[0].get("v").unwrap(), &json!(42));
        gate.close().await;

        // Wrong key must be rejected.
        let wrong = Mdk::generate();
        let err = gate.open_encrypted(&path, &wrong).await.unwrap_err();
        assert!(matches!(err, DbError::Sqlite(_)));

        // File header must not be plain SQLite magic.
        let header = std::fs::read(&path).unwrap();
        assert!(!header.starts_with(b"SQLite format 3\0"));
    }

    #[tokio::test]
    async fn run_migrations_applies_pending_and_is_idempotent() {
        let d = tempfile::tempdir().unwrap();
        let gate = DbGate::new();
        gate.open_plaintext(&d.path().join("m.db")).await.unwrap();
        let migs = vec![
            (1i64, "one", "CREATE TABLE m1 (x INT);"),
            (2, "two", "CREATE TABLE m2 (y INT);"),
        ];
        gate.run_migrations(&migs).await.unwrap();
        gate.execute("INSERT INTO m1(x) VALUES(1)", &[]).await.unwrap();
        gate.execute("INSERT INTO m2(y) VALUES(2)", &[]).await.unwrap();

        // Second call is a no-op — must not recreate tables or wipe data.
        gate.run_migrations(&migs).await.unwrap();
        let r1 = gate.select("SELECT count(*) AS n FROM m1", &[]).await.unwrap();
        assert_eq!(r1[0].get("n").unwrap(), &json!(1));
    }

    #[tokio::test]
    async fn run_migrations_backfills_from_legacy_sqlx_tracker() {
        let d = tempfile::tempdir().unwrap();
        let gate = DbGate::new();
        gate.open_plaintext(&d.path().join("legacy.db")).await.unwrap();
        // Simulate an existing v1.x install: _sqlx_migrations exists
        // and records that migrations 1 and 2 already ran. Their tables
        // exist too, so re-running them would fail.
        gate.execute(
            "CREATE TABLE _sqlx_migrations (\
                 version BIGINT PRIMARY KEY,\
                 description TEXT NOT NULL,\
                 installed_on TIMESTAMP,\
                 success BOOLEAN NOT NULL,\
                 checksum BLOB NOT NULL,\
                 execution_time BIGINT NOT NULL)",
            &[],
        )
        .await
        .unwrap();
        gate.execute("CREATE TABLE m1 (x INT)", &[]).await.unwrap();
        gate.execute("CREATE TABLE m2 (y INT)", &[]).await.unwrap();
        gate.execute(
            "INSERT INTO _sqlx_migrations(version, description, success, checksum, execution_time) \
             VALUES(1, 'one', 1, x'00', 0), (2, 'two', 1, x'00', 0)",
            &[],
        )
        .await
        .unwrap();

        let migs = vec![
            (1i64, "one", "CREATE TABLE m1 (x INT);"),
            (2, "two", "CREATE TABLE m2 (y INT);"),
            (3, "three", "CREATE TABLE m3 (z INT);"),
        ];
        // Should backfill 1 and 2 from _sqlx_migrations (skipping
        // re-execution) and apply only 3.
        gate.run_migrations(&migs).await.unwrap();
        gate.execute("INSERT INTO m3(z) VALUES(9)", &[]).await.unwrap();
        let r = gate.select("SELECT count(*) AS n FROM _migrations", &[]).await.unwrap();
        assert_eq!(r[0].get("n").unwrap(), &json!(3));
    }

    #[test]
    fn multi_statement_detector() {
        assert!(has_multiple_statements("SELECT 1; SELECT 2"));
        assert!(has_multiple_statements("SELECT 1; SELECT 2;"));
        assert!(!has_multiple_statements("SELECT 1"));
        assert!(!has_multiple_statements("SELECT 1;"));
        assert!(!has_multiple_statements("SELECT 1;   "));
    }
}
