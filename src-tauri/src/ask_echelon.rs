// Ask Echelon — natural-language → SQL over the app's SQLite DB.
//
// Design constraints (from feature spec, non-negotiable):
//   • No writes. Ever. We open the DB with SQLITE_OPEN_READ_ONLY so even a
//     validator bypass cannot mutate data.
//   • SQL AST validation before execution: only a single SELECT (or WITH ...
//     SELECT). No PRAGMA / ATTACH / DDL / DML.
//   • Row cap enforced server-side (LIMIT 500) even if the LLM omitted it.
//   • Optional PII redaction on sample rows sent to the LLM.
//
// Two-shot LLM pipeline:
//   1) SQL generation call — temperature 0.0, chat/completions on gpt-4.1
//      (already deployed at ai-nse.openai.azure.com and reused across the app).
//   2) Summary call — temperature 0.3, given the executed rows, produces a
//      1-2 sentence prose summary + chart hint (bar|line|pie|none).

use rusqlite::{Connection, OpenFlags, types::ValueRef};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlparser::ast::{SetExpr, Statement};
use sqlparser::dialect::SQLiteDialect;
use sqlparser::parser::Parser;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const AZURE_ENDPOINT: &str = "https://ai-nse.openai.azure.com";
const CHAT_DEPLOY: &str = "gpt-4.1";
const CHAT_API_VER: &str = "2025-04-01-preview";
const HARD_ROW_CAP: usize = 500;
const SAMPLE_ROWS_PER_TABLE: usize = 3;

// ─── Args / result types ────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct AskEchelonArgs {
    pub azure_ai_key: String,
    pub question: String,
    pub redact: bool,
    /// Optional whitelist of table names the model is allowed to see. Empty
    /// or missing means "all user tables". The Rust side ALWAYS excludes
    /// sqlite_* internals; this is for the Settings-level "which tables can
    /// the AI see?" toggle we might add later.
    pub allowed_tables: Option<Vec<String>>,
}

#[derive(Serialize)]
pub struct AskEchelonResult {
    pub sql: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub summary: String,
    pub chart_hint: String, // "bar" | "line" | "pie" | "none"
    pub elapsed_ms: u64,
    pub truncated: bool,
}

// ─── Entry point ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn ask_echelon(app: AppHandle, args: AskEchelonArgs) -> Result<AskEchelonResult, String> {
    let started = Instant::now();
    let db_path = resolve_db_path(&app)?;

    if args.question.trim().is_empty() {
        return Err("Question is empty.".to_string());
    }
    if args.azure_ai_key.trim().is_empty() {
        return Err("Azure AI key is not configured. Set it in Configuration → Identity.".to_string());
    }

    // Build schema context in Rust (fresh each call — schema is tiny, cache
    // would only save a few ms and adds a stale-cache footgun during dev).
    let schema_ctx = build_schema_context(&db_path, args.redact, args.allowed_tables.as_ref())?;

    // ── Step 1: Ask the model for SQL ───────────────────────────────────
    let sql_raw = generate_sql(&args.azure_ai_key, &args.question, &schema_ctx).await?;
    let sql = validate_and_normalize_sql(&sql_raw)?;

    // ── Step 2: Execute against a read-only connection ──────────────────
    let (columns, rows, truncated) = execute_readonly(&db_path, &sql)?;

    // ── Step 3: Summarise ───────────────────────────────────────────────
    let (summary, chart_hint) = summarize(
        &args.azure_ai_key, &args.question, &sql, &columns, &rows, args.redact,
    ).await.unwrap_or_else(|_| {
        // A summary failure should not fail the whole query — the user still
        // gets the table.
        ("".to_string(), "none".to_string())
    });

    Ok(AskEchelonResult {
        sql,
        columns,
        rows,
        summary,
        chart_hint,
        elapsed_ms: started.elapsed().as_millis() as u64,
        truncated,
    })
}

// ─── DB path resolution ─────────────────────────────────────────────────

fn resolve_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    // tauri-plugin-sql stores at app_data_dir/echelon.db (matches the
    // `sqlite:echelon.db` URL used elsewhere in the app).
    let dir = app.path().app_data_dir().map_err(|e| format!("app_data_dir: {e}"))?;
    let p = dir.join("echelon.db");
    if !p.exists() {
        return Err(format!("DB not found at {}", p.display()));
    }
    Ok(p)
}

// ─── Schema context builder ─────────────────────────────────────────────

fn build_schema_context(
    db_path: &PathBuf, redact: bool, allowed: Option<&Vec<String>>,
) -> Result<String, String> {
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    ).map_err(|e| format!("open-ro: {e}"))?;

    // Enumerate user tables (skip internal + tauri-plugin-sql housekeeping).
    let mut stmt = conn
        .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%\\_' ESCAPE '\\' ORDER BY name")
        .map_err(|e| format!("prep-master: {e}"))?;
    let table_iter = stmt.query_map([], |r| {
        let name: String = r.get(0)?;
        let sql: Option<String> = r.get(1)?;
        Ok((name, sql.unwrap_or_default()))
    }).map_err(|e| format!("query-master: {e}"))?;

    let mut tables: Vec<(String, String)> = Vec::new();
    for row in table_iter {
        let (name, sql) = row.map_err(|e| format!("scan-master: {e}"))?;
        if name.starts_with("_") { continue; }
        if let Some(list) = allowed {
            if !list.is_empty() && !list.iter().any(|t| t.eq_ignore_ascii_case(&name)) {
                continue;
            }
        }
        tables.push((name, sql));
    }

    let mut out = String::new();
    out.push_str("You are querying a SQLite database for a BC daycare admin app.\n\n");
    out.push_str("### Tables (CREATE statements)\n");
    for (_, sql) in &tables {
        if !sql.is_empty() {
            out.push_str(sql);
            out.push_str(";\n\n");
        }
    }

    // Sample rows — up to N per table, PII-redacted if requested.
    out.push_str("\n### Sample rows (up to 3 per table");
    if redact { out.push_str(", PII redacted"); }
    out.push_str(")\n");
    for (name, _) in &tables {
        let sql = format!("SELECT * FROM \"{}\" ORDER BY RANDOM() LIMIT {}", name, SAMPLE_ROWS_PER_TABLE);
        let sampled = sample_rows_json(&conn, &sql, redact);
        match sampled {
            Ok(rows_json) if !rows_json.is_empty() => {
                out.push_str(&format!("\n{name}:\n"));
                for r in rows_json {
                    out.push_str(&format!("  {}\n", r));
                }
            }
            _ => {}
        }
    }

    Ok(out)
}

fn is_pii_column(col: &str) -> bool {
    // Case-insensitive heuristic. Anything that could identify a family gets
    // redacted before we send sample rows to the LLM.
    //
    // Waitlist columns (v0.8.0) are covered by these substring rules:
    //   parent_email → matches "email" and "parent"
    //   phone        → matches "phone"
    //   parent_name  → matches "parent" and "name"
    //   child_name   → matches "child_name" and "name"
    // No new patterns required, but keep this in mind when adding tables.
    let c = col.to_lowercase();
    let hits = [
        "child_name", "student_name", "name",
        "father", "mother", "parent",
        "email", "phone", "mobile",
        "address", "postal",
        "sin", "birth", "dob",
        "emergency_contact",
        "notes",
    ];
    hits.iter().any(|h| c == *h || c.contains(h))
}

fn placeholder_for(col: &str) -> Value {
    let c = col.to_lowercase();
    if c.contains("email") { Value::String("<email>".into()) }
    else if c.contains("phone") || c.contains("mobile") { Value::String("<phone>".into()) }
    else if c.contains("address") || c.contains("postal") { Value::String("<address>".into()) }
    else if c.contains("sin") { Value::String("<sin>".into()) }
    else if c.contains("birth") || c.contains("dob") { Value::String("<dob>".into()) }
    else if c.contains("father") || c.contains("mother") || c.contains("parent") { Value::String("<parent>".into()) }
    else { Value::String("<name>".into()) }
}

fn sample_rows_json(conn: &Connection, sql: &str, redact: bool) -> Result<Vec<String>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| format!("prep-sample: {e}"))?;
    let col_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let col_count = col_names.len();
    let mut rows_iter = stmt.query([]).map_err(|e| format!("query-sample: {e}"))?;
    let mut out: Vec<String> = Vec::new();
    while let Some(row) = rows_iter.next().map_err(|e| format!("next-sample: {e}"))? {
        let mut obj = serde_json::Map::new();
        for i in 0..col_count {
            let col = &col_names[i];
            let v = value_from_row(row, i);
            let final_v = if redact && is_pii_column(col) && !matches!(v, Value::Null) {
                placeholder_for(col)
            } else {
                v
            };
            obj.insert(col.clone(), final_v);
        }
        out.push(serde_json::to_string(&Value::Object(obj)).unwrap_or_default());
    }
    Ok(out)
}

fn value_from_row(row: &rusqlite::Row, i: usize) -> Value {
    match row.get_ref(i) {
        Ok(ValueRef::Null) => Value::Null,
        Ok(ValueRef::Integer(v)) => Value::from(v),
        Ok(ValueRef::Real(v)) => serde_json::Number::from_f64(v)
            .map(Value::Number).unwrap_or(Value::Null),
        Ok(ValueRef::Text(bytes)) => Value::String(String::from_utf8_lossy(bytes).into_owned()),
        Ok(ValueRef::Blob(_)) => Value::String("<blob>".into()),
        Err(_) => Value::Null,
    }
}

// ─── LLM: SQL generation ────────────────────────────────────────────────

async fn generate_sql(
    api_key: &str, question: &str, schema_ctx: &str,
) -> Result<String, String> {
    let system = "You are a SQL expert. Given a natural-language question and the schema of a SQLite database, return EXACTLY ONE SQLite-compatible SELECT statement that answers the question. Rules:\n\
        • Return ONLY the SQL. No prose, no code fences, no comments.\n\
        • Read-only: SELECT or WITH ... SELECT. NEVER INSERT/UPDATE/DELETE/DROP/ALTER/PRAGMA/ATTACH/CREATE/REPLACE.\n\
        • Do not end with a semicolon and do not chain multiple statements.\n\
        • Use SQLite date functions (strftime, date, julianday) — the DB stores dates as TEXT in YYYY-MM-DD.\n\
        • Prefer explicit column lists over SELECT *.\n\
        • If aggregating over time, GROUP BY strftime('%Y-%m', <date>) etc.\n\
        • Add LIMIT 500 unless the question is a single-row aggregate (COUNT/SUM/AVG).\n\
        • The 'voided' flag on receipts means the receipt is cancelled — exclude WHERE voided=0 for revenue.\n\
        • Refunds are receipts with is_refund=1; their amount is stored positive but nets negative in revenue.\n";
    let user = format!(
        "SCHEMA:\n{}\n\nQUESTION:\n{}\n\nReturn one SQLite SELECT statement:",
        schema_ctx, question
    );
    let body = json!({
        "messages": [
            {"role":"system", "content": system},
            {"role":"user",   "content": user}
        ],
        "temperature": 0.0,
        "max_completion_tokens": 2000
    });
    call_chat(api_key, body).await
}

// ─── LLM: summary + chart hint ──────────────────────────────────────────

async fn summarize(
    api_key: &str, question: &str, sql: &str,
    columns: &[String], rows: &[Vec<Value>], redact: bool,
) -> Result<(String, String), String> {
    // Send at most 25 rows to the summary model. Redact PII cells if the
    // toggle is on (same heuristic as sample rows).
    let mut sample: Vec<Value> = Vec::new();
    for r in rows.iter().take(25) {
        let mut obj = serde_json::Map::new();
        for (i, col) in columns.iter().enumerate() {
            let v = r.get(i).cloned().unwrap_or(Value::Null);
            let out = if redact && is_pii_column(col) && !matches!(v, Value::Null) {
                placeholder_for(col)
            } else { v };
            obj.insert(col.clone(), out);
        }
        sample.push(Value::Object(obj));
    }
    let system = "You summarise SQL query results for a daycare admin. Reply with a single JSON object: \
        {\"summary\": \"1-2 short sentences answering the user's question, referencing counts/sums/names where useful\", \
        \"chart\": \"bar\"|\"line\"|\"pie\"|\"none\"}. \
        Pick 'bar' for grouped categorical counts, 'line' for time-series, 'pie' for share of a small total, 'none' when a chart adds no value. Reply with ONLY the JSON.";
    let user = json!({
        "question": question,
        "sql": sql,
        "row_count": rows.len(),
        "columns": columns,
        "rows_sample": sample
    }).to_string();
    let body = json!({
        "messages": [
            {"role":"system","content": system},
            {"role":"user","content": user}
        ],
        "temperature": 0.3,
        "max_completion_tokens": 500
    });
    let raw = call_chat(api_key, body).await?;
    let cleaned = strip_code_fence(&raw);
    let v: Value = serde_json::from_str(&cleaned)
        .map_err(|e| format!("summary parse: {e} :: {}", cleaned.chars().take(200).collect::<String>()))?;
    let summary = v["summary"].as_str().unwrap_or("").trim().to_string();
    let chart = v["chart"].as_str().unwrap_or("none").trim().to_lowercase();
    let chart = match chart.as_str() {
        "bar" | "line" | "pie" | "none" => chart,
        _ => "none".to_string(),
    };
    Ok((summary, chart))
}

// ─── Shared Azure chat/completions helper (2 retries, 500ms backoff) ────

async fn call_chat(api_key: &str, body: Value) -> Result<String, String> {
    let url = format!(
        "{AZURE_ENDPOINT}/openai/deployments/{CHAT_DEPLOY}/chat/completions?api-version={CHAT_API_VER}"
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let mut last_err: Option<String> = None;
    for attempt in 0..3 {
        if attempt > 0 { tokio::time::sleep(Duration::from_millis(500 * attempt as u64)).await; }
        let resp = client.post(&url)
            .header("api-key", api_key)
            .header("Content-Type", "application/json")
            .json(&body)
            .send().await;
        let resp = match resp {
            Ok(r) => r,
            Err(e) => { last_err = Some(format!("send: {e}")); continue; }
        };
        let status = resp.status();
        let text = match resp.text().await {
            Ok(t) => t,
            Err(e) => { last_err = Some(format!("read: {e}")); continue; }
        };
        if !status.is_success() {
            last_err = Some(format!("http {status}"));
            // 4xx = don't retry
            if status.is_client_error() { break; }
            continue;
        }
        let v: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(e) => { last_err = Some(format!("json: {e}")); continue; }
        };
        let content = v["choices"][0]["message"]["content"].as_str().unwrap_or("");
        if content.is_empty() {
            last_err = Some("empty completion".into());
            continue;
        }
        return Ok(content.to_string());
    }
    Err(last_err.unwrap_or_else(|| "unknown chat error".into()))
}

fn strip_code_fence(s: &str) -> String {
    let t = s.trim();
    if let Some(rest) = t.strip_prefix("```") {
        // Skip an optional language tag on the first line.
        let rest = rest.strip_prefix("json").or_else(|| rest.strip_prefix("sql")).unwrap_or(rest);
        let rest = rest.trim_start_matches('\n');
        if let Some(end) = rest.rfind("```") {
            return rest[..end].trim().to_string();
        }
    }
    t.to_string()
}

// ─── SQL validation ─────────────────────────────────────────────────────

fn validate_and_normalize_sql(raw: &str) -> Result<String, String> {
    let cleaned = strip_code_fence(raw);
    let cleaned = cleaned.trim().trim_end_matches(';').trim().to_string();

    // Cheap pre-parse rejects: statement separators, comments (they let the
    // model smuggle in additional statements or comment-out the LIMIT clause
    // we might append). We treat these as prompt injection.
    if cleaned.contains(';') {
        return Err("Generated SQL contains multiple statements; refused.".into());
    }
    if cleaned.contains("--") || cleaned.contains("/*") || cleaned.contains("*/") {
        return Err("Generated SQL contains comments; refused.".into());
    }

    let dialect = SQLiteDialect {};
    let statements = Parser::parse_sql(&dialect, &cleaned)
        .map_err(|e| format!("SQL parse error: {e}"))?;
    if statements.len() != 1 {
        return Err(format!("Expected 1 statement, got {}.", statements.len()));
    }
    // Only Query (SELECT / WITH ... SELECT) is allowed. Anything else — even
    // things sqlparser considers benign like EXPLAIN — is rejected here so
    // the LLM has no side-channel to touch the DB.
    let query = match &statements[0] {
        Statement::Query(q) => q,
        _ => return Err("Only SELECT statements are allowed.".into()),
    };
    // Reject INSERT/UPDATE/DELETE nested inside a WITH clause (CTE INSERT is
    // a thing in some dialects). sqlparser expresses the inner form on
    // SetExpr; anything not Select or SetOperation is a mutation.
    fn check_set_expr(expr: &SetExpr) -> Result<(), String> {
        match expr {
            SetExpr::Select(_) => Ok(()),
            SetExpr::Query(q) => check_set_expr(&q.body),
            SetExpr::SetOperation { left, right, .. } => {
                check_set_expr(left)?;
                check_set_expr(right)
            }
            SetExpr::Values(_) => Ok(()), // VALUES-only "query" is read-only
            SetExpr::Insert(_) | SetExpr::Update(_) | SetExpr::Table(_) => {
                Err("Non-SELECT set expression in query.".into())
            }
        }
    }
    check_set_expr(&query.body)?;

    // Also ensure any CTEs are themselves SELECTs.
    if let Some(with) = &query.with {
        for cte in &with.cte_tables {
            check_set_expr(&cte.query.body)?;
        }
    }

    // Enforce LIMIT 500. If the query already has a LIMIT lower than the cap,
    // leave it alone; otherwise wrap. We wrap as a subquery so that any
    // ORDER BY in the inner query is preserved.
    let with_limit = ensure_limit(&cleaned)?;
    Ok(with_limit)
}

fn ensure_limit(sql: &str) -> Result<String, String> {
    // Cheap textual check for a trailing LIMIT. We already ran through
    // sqlparser above so we know it's a single valid SELECT; this is just
    // best-effort — if it's missing we append one. This is textual because
    // sqlparser doesn't stringify LIMIT-less queries perfectly across
    // dialects.
    let lower = sql.to_lowercase();
    let has_limit = lower.rfind("limit ").map(|pos| {
        // ensure there's a number-ish thing after it, not "limit" appearing
        // inside a column alias or string literal (we already banned strings
        // with ; and --).
        let after = &sql[pos + 6..];
        after.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false)
    }).unwrap_or(false);
    if has_limit {
        Ok(sql.to_string())
    } else {
        Ok(format!("SELECT * FROM ({}) LIMIT {}", sql, HARD_ROW_CAP))
    }
}

// ─── Read-only execution ────────────────────────────────────────────────

fn execute_readonly(
    db_path: &PathBuf, sql: &str,
) -> Result<(Vec<String>, Vec<Vec<Value>>, bool), String> {
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    ).map_err(|e| format!("open-ro: {e}"))?;

    // SQLITE_OPEN_READ_ONLY already prevents any write at the SQLite layer,
    // and sqlparser validation above already restricted the statement kind.
    // We rely on those two together — the connection flag is the ultimate
    // guarantee.

    let mut stmt = conn.prepare(sql).map_err(|e| format!("prep: {e}"))?;
    let col_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let col_count = col_names.len();
    let mut rows_iter = stmt.query([]).map_err(|e| format!("query: {e}"))?;

    let mut out: Vec<Vec<Value>> = Vec::new();
    let mut truncated = false;
    while let Some(row) = rows_iter.next().map_err(|e| format!("next: {e}"))? {
        if out.len() >= HARD_ROW_CAP {
            truncated = true;
            break;
        }
        let mut r: Vec<Value> = Vec::with_capacity(col_count);
        for i in 0..col_count { r.push(value_from_row(row, i)); }
        out.push(r);
    }
    Ok((col_names, out, truncated))
}

// ─── Save a query as a report ───────────────────────────────────────────
// Frontend does this via tauri-plugin-sql; kept here as a stub for future
// server-side operations (audit log, share, etc.).
