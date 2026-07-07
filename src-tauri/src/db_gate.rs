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

    pub async fn is_open(&self) -> bool {
        self.inner.lock().await.is_some()
    }

    /// SELECT-style query. Rows are returned as `[{ "col": <json>, ... }]`.
    /// Matches the JSON shape tauri-plugin-sql's `select()` returns so
    /// the frontend db.ts shim can be a straight swap.
    pub async fn select(
        &self,
        sql: &str,
        args: &[Value],
    ) -> Result<Vec<Map<String, Value>>, DbError> {
        let guard = self.inner.lock().await;
        let conn = guard.as_ref().ok_or(DbError::Locked)?;
        let mut stmt = conn.prepare(sql)?;
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
        Ok(out)
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
        let rows_affected = conn.execute(sql, params_from_iter(rusqlite_args.iter()))?;
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
    async fn open_encrypted_without_feature_fails_cleanly() {
        // Feature is not enabled in the default build — confirm we get
        // the specific error instead of silently opening a plain DB.
        let d = tempfile::tempdir().unwrap();
        let gate = DbGate::new();
        let mdk = Mdk::generate();
        let err = gate
            .open_encrypted(&d.path().join("enc.db"), &mdk)
            .await
            .unwrap_err();
        assert!(matches!(err, DbError::SqlCipherUnavailable));
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
