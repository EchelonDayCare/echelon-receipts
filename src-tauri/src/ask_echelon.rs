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

use serde::{Deserialize, Serialize};
use serde_json::{json, Value, Map};
use sqlparser::ast::{SetExpr, Statement};
use sqlparser::dialect::SQLiteDialect;
use sqlparser::parser::Parser;
use std::time::{Duration, Instant};
use crate::db_gate::DbGate;

const AZURE_ENDPOINT: &str = "https://ai-nse.openai.azure.com";
const CHAT_DEPLOY: &str = "gpt-4.1";
const CHAT_API_VER: &str = "2025-04-01-preview";
const HARD_ROW_CAP: usize = 500;
const SAMPLE_ROWS_PER_TABLE: usize = 3;

// ─── Args / result types ────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct AskEchelonArgs {
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
pub async fn ask_echelon(
    gate: tauri::State<'_, DbGate>,
    args: AskEchelonArgs,
) -> Result<AskEchelonResult, String> {
    let started = Instant::now();

    if args.question.trim().is_empty() {
        return Err("Question is empty.".to_string());
    }
    if !gate.is_open().await {
        return Err("Database is locked. Unlock the app before asking a question.".to_string());
    }
    // H-7: resolve the Azure AI key server-side instead of accepting it as a
    // plaintext IPC argument.
    let azure_ai_key = crate::secrets::get_secret("azure_ai_key")?;

    // ── Step 0: Route "how do I…" questions to the UI-nav assistant.
    // Data questions ("how much…", "how many…", "who owes…") stay in the
    // SQL path. Pure how-to questions ("how do I add a student?") deserve
    // grounded UI-navigation steps, not SQL over the schema.
    if is_howto_question(&args.question) {
        let (summary, _) = howto_answer(&azure_ai_key, &args.question).await
            .unwrap_or_else(|e| (format!("Sorry — I couldn't produce steps for that. ({e})"), "none".to_string()));
        return Ok(AskEchelonResult {
            sql: String::new(),
            columns: Vec::new(),
            rows: Vec::new(),
            summary,
            chart_hint: "none".to_string(),
            elapsed_ms: started.elapsed().as_millis() as u64,
            truncated: false,
        });
    }

    // Build schema context via the app's live DB connection (SQLCipher-
    // encrypted after v2.0.0). Opening our own rusqlite handle to the file
    // would fail with "file is not a database" for encrypted DBs.
    let (schema_ctx, user_tables) = build_schema_context(&gate, args.redact, args.allowed_tables.as_ref()).await?;

    // ── Step 1: Ask the model for SQL ───────────────────────────────────
    let sql_raw = generate_sql(&azure_ai_key, &args.question, &schema_ctx).await?;
    let sql = validate_and_normalize_sql(&sql_raw)?;

    // ── Step 1b: Scope check.
    // Ask Echelon is intentionally scoped to (a) the app's data and (b) the
    // app's features (via howto_answer, earlier). A question like "when did
    // WWII happen?" can still coax the model into writing valid SQL like
    // `SELECT '1939' AS answer` — syntactically fine, semantically nonsense.
    // We refuse any SQL that doesn't touch at least one real user table.
    if !sql_references_a_user_table(&sql, &user_tables) {
        let summary = "I can only answer questions about your daycare data (receipts, attendance, staff hours, expenses, credentials, etc.) or how to use this app (\"how do I add a student?\"). Try one of those.".to_string();
        return Ok(AskEchelonResult {
            sql: String::new(),
            columns: Vec::new(),
            rows: Vec::new(),
            summary,
            chart_hint: "none".to_string(),
            elapsed_ms: started.elapsed().as_millis() as u64,
            truncated: false,
        });
    }

    // ── Step 2: Execute against the same live connection.
    // SQL AST validation above guarantees this is a single SELECT (or
    // WITH ... SELECT), so reusing the read-write gate is safe. See
    // `validate_and_normalize_sql` for the argument.
    let (columns, rows, truncated) = execute_readonly(&gate, &sql).await?;

    // ── Step 3: Summarise ───────────────────────────────────────────────
    let (summary, chart_hint) = summarize(
        &azure_ai_key, &args.question, &sql, &columns, &rows, args.redact,
    ).await.unwrap_or_else(|_| {
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

// ─── Schema context builder ─────────────────────────────────────────────

async fn build_schema_context(
    gate: &DbGate, redact: bool, allowed: Option<&Vec<String>>,
) -> Result<(String, Vec<String>), String> {
    // Enumerate user tables (skip internal + tauri-plugin-sql housekeeping).
    let master = gate
        .select(
            "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%\\_' ESCAPE '\\' ORDER BY name",
            &[],
        )
        .await
        .map_err(|e| format!("prep-master: {e}"))?;

    let mut tables: Vec<(String, String)> = Vec::new();
    for row in master {
        let name = row.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let sql = row.get("sql").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if name.is_empty() { continue; }
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
        let sampled = sample_rows_json(gate, &sql, redact).await;
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

    let table_names: Vec<String> = tables.into_iter().map(|(n, _)| n).collect();
    Ok((out, table_names))
}

// C-2: this used to be a PII *blocklist* — redact only columns whose name
// matched a known-bad pattern. Blocklists silently miss new columns (e.g.
// `recipients`, `body`, `recipient_label`, `message_body`, `wa_me_url`,
// `attendees_text`, `status_note`, `email_to`, `email_body`, `phone` variants,
// `wa_number` were all sent to the LLM in plaintext). We now fail CLOSED: a
// column is only exempt from redaction if it is on this explicit ALLOWLIST of
// non-identifying numeric/enum/id/date columns. Everything else — any column
// not named here — is redacted by default, present or future.
// Value-shape check: even if a column *name* looks safe (e.g. `id`), a hostile
// query can smuggle PII through it via aliasing: `SELECT email AS id ...`.
// So we ONLY trust the column-name allowlist when the value itself also looks
// shape-safe (short, no obvious PII markers). Anything longer or with `@`,
// spaces (beyond an ISO date's T/Z), or extended chars → redact regardless.
fn is_safe_value_shape(v: &str) -> bool {
    if v.len() > 40 { return false; }
    if v.contains('@') { return false; }
    // Allow: ASCII alnum, dash, underscore, dot, colon, plus, T, Z, slash.
    // Deliberately NO space — that lets "Alice Bob" through when aliased as
    // a safe column. SQLite dates rendered "2026-07-06 21:59:21" will fail
    // this check (fine — they redact to a placeholder, which is safe).
    for ch in v.chars() {
        let ok = ch.is_ascii_alphanumeric()
            || matches!(ch, '-' | '_' | '.' | ':' | '+' | 'T' | 'Z' | '/');
        if !ok { return false; }
    }
    true
}

fn should_redact(v: &Value, col: &str, redact: bool) -> bool {
    if !redact { return false; }
    let Value::String(s) = v else { return false; };
    if !is_safe_column(col) { return true; }
    // Column name is on the allowlist, but the value must also *look* safe.
    !is_safe_value_shape(s)
}

fn is_safe_column(col: &str) -> bool {
    let c = col.to_lowercase();

    const SAFE_EXACT: &[&str] = &[
        "id", "uuid", "version", "status", "state", "kind", "type",
        "category", "priority", "role", "channel", "event_type",
        "chart_hint", "deleted_at", "created_at", "updated_at",
        "updated_by", "start_time", "end_time", "published",
        "confirmed", "cancelled", "acknowledged_at", "published_at",
        "dedup_key", "entity_type", "entity_id", "sequence",
        "order_index", "grade", "band", "score", "weight",
        "mime_type", "size_bytes", "ref_count", "blob_key",
        "legacy_id", "fiscal_year", "school_year", "term",
        "currency", "voided", "is_refund", "auto_cleared_at",
        "read_at", "snoozed_until", "dismissed_at", "date", "amount",
        "pending_amount", "hourly_rate", "count", "total", "sum", "avg",
        "chart", "elapsed_ms", "truncated",
    ];
    if SAFE_EXACT.contains(&c.as_str()) {
        return true;
    }

    // Suffix rules for generated / derived / audit columns.
    c.ends_with("_id")
        || c.ends_with("_at")
        || c.ends_with("_cents")
        || c.ends_with("_count")
        || c.ends_with("_index")
        || c.ends_with("_ms")
        || c.ends_with("_date")
}

fn placeholder_for(col: &str) -> Value {
    let c = col.to_lowercase();
    if c.contains("email") { Value::String("<email>".into()) }
    else if c.contains("phone") || c.contains("mobile") || c.contains("wa_number") { Value::String("<phone>".into()) }
    else if c.contains("address") || c.contains("postal") { Value::String("<address>".into()) }
    else if c.contains("sin") { Value::String("<sin>".into()) }
    else if c.contains("birth") || c.contains("dob") { Value::String("<dob>".into()) }
    else if c.contains("father") || c.contains("mother") || c.contains("parent") { Value::String("<parent>".into()) }
    else if c.contains("name") { Value::String("<name>".into()) }
    else { Value::String("<redacted>".into()) }
}

async fn sample_rows_json(gate: &DbGate, sql: &str, redact: bool) -> Result<Vec<String>, String> {
    let rows = gate.select(sql, &[]).await.map_err(|e| format!("query-sample: {e}"))?;
    let mut out: Vec<String> = Vec::with_capacity(rows.len());
    for row in rows {
        let mut obj: Map<String, Value> = Map::new();
        for (col, v) in row.iter() {
            let final_v = if should_redact(v, col, redact) {
                placeholder_for(col)
            } else {
                v.clone()
            };
            obj.insert(col.clone(), final_v);
        }
        out.push(serde_json::to_string(&Value::Object(obj)).unwrap_or_default());
    }
    Ok(out)
}

// ─── How-to routing: classifier + UI-grounded answerer ─────────────────
//
// The Ask Echelon SQL path is useless for questions like "how do I add a
// student?" because the answer isn't in the database — it's in the UI.
// We route those questions to a second prompt seeded with the actual app
// navigation map so the answer is grounded in real steps the user can
// follow.

fn is_howto_question(q: &str) -> bool {
    let l = q.to_lowercase();
    let l = l.trim();
    // Purely data-shaped questions must stay in the SQL path.
    if l.starts_with("how many") || l.starts_with("how much") { return false; }
    // Data-shape signals that override any nav prefix — "where is the biggest expense",
    // "where's the highest revenue", etc. should route to SQL, not to UI-nav.
    let data_signals = [
        "most", "highest", "largest", "top", "biggest", "lowest", "smallest",
        "outstanding", "owing", "revenue", "expense", "expenses", "balance",
        "count", "total", "sum", "average", "avg",
    ];
    for sig in &data_signals {
        // Word-boundary-ish check: surround with spaces so "top" doesn't match "topic".
        let padded = format!(" {} ", sig);
        let l_padded = format!(" {} ", l);
        if l_padded.contains(&padded) { return false; }
    }
    // "how do I / how can I / how to" → UI steps.
    if l.starts_with("how do i") || l.starts_with("how can i") || l.starts_with("how to") { return true; }
    // "where do I / where can I / where do you" — require a UI-verb signal.
    // Dropped "where is the", "where's the", "where to" because they collide with
    // data questions like "where is the biggest expense coming from?".
    if l.starts_with("where do i") || l.starts_with("where can i") || l.starts_with("where do you")
        { return true; }
    // Explicit UI-shaped verbs at the start.
    for verb in &[
        "how do you", "how does one",
        "how i can", "steps to", "walk me through",
        "guide me", "show me how",
    ] {
        if l.starts_with(verb) { return true; }
    }
    false
}

// Static navigation map — kept in one place so we can keep it in sync
// with App.tsx routes. If you add a top-level feature, add a bullet here.
const UI_NAV_MAP: &str = "\
Top-level nav (left sidebar):\n\
  Students → Today / This Month / New Receipt / Attendance / History / Roster / Reports / Aging / Annual Receipts / Deposits\n\
  Staff → Hours / Schedule / Credentials / Meeting Notes\n\
  Expenses → Dashboard / Add Expense / All / Recurring / Import Statement / Reports\n\
  Reports → Overview / Monthly / Aging / Subsidy / Enrollment / Attendance / Credentials / Drills / AGM\n\
  Communications → Compose / Templates / History / Directory / Scheduled\n\
  Waitlist → Overview / List / Enrolled / Archived\n\
  Vault (document library), Organizer (calendar/AI notes), Ask Echelon\n\
  Config (Settings) → Identity / Receipts & Email / Folders / Staff / Backups / Security / Stat Holidays / Notifications / Waitlist / About\n\
\n\
Common tasks and where to do them:\n\
  Add / edit a student: Students → Roster → \"+ Add Student\" (top-right).\n\
    Fields include name, DOB, parent contacts, start date, monthly fee. Save.\n\
  Record a receipt / payment: Students → New Receipt. Pick the student, amount, method, date, then Save. A PDF preview appears.\n\
  Email a receipt: after saving, click \"Email\" on the preview (requires SMTP set up under Config → Receipts & Email).\n\
  Print a receipt: Students → History → open the receipt → Print (uses native OS print dialog on both Mac and Windows).\n\
  Void a receipt: Students → History → open receipt → \"Void\" (you'll be asked for a reason).\n\
  Mark attendance for the month: Students → Attendance → pick the year+month at top → click a day cell to cycle P → A → blank.\n\
  Upload a paper attendance sheet: Students → Attendance → \"Upload sheet\" → either \"Import from Downloads\" (picks the newest scan) or choose manually. Review the extracted grid before saving.\n\
  Mark a specific day open or closed: Students → Attendance → \"Centre Calendar\" (top-right of the month) → click the day → toggle Open/Closed.\n\
  Change which stat holidays apply: Config → Stat Holidays → tick/untick the 12 BC holidays (year-on-year).\n\
  Add a staff member: Config → Staff → \"+ Add Staff\". Then Staff → Hours will show them.\n\
  Log staff hours from a sign-in sheet: Staff → Hours → \"Upload sheet\". Same dual-button flow as attendance.\n\
  Build a staff schedule: Staff → Schedule → click a cell to add a shift. Publish week to lock changes.\n\
  Create meeting notes: Staff → Meeting Notes → \"+ New meeting\". Or paste raw notes into the AI panel to auto-fill title/attendees/actions.\n\
  Amend saved meeting notes with AI: open the meeting → click \"✨ Amend with AI\" next to Notes.\n\
  Enter an expense: Expenses → Add Expense. For monthly bills use Expenses → Recurring.\n\
  Import a Visa / credit-card statement: Expenses → Import Statement → upload PDF/CSV → review → Save.\n\
  Run the annual (tax) receipt for a family: Students → Annual Receipts → pick year → per-student PDF.\n\
  Compose a bulk message to parents: Communications → Compose → pick audience → send now or schedule.\n\
  Add a family to the waitlist: Waitlist → List → \"+ Add family\".\n\
  Back up your database to email: Config → Backups → \"Send cloud backup now\" (needs a passphrase set on the same tab).\n\
  Restore from backup: Config → Backups → \"Restore from file\" (creates a safety copy of the current DB first).\n\
  Change PIN: Config → Security → \"Change PIN\".\n\
  Set up email (SMTP): Config → Receipts & Email → enter host / port / from address / password. Use \"Send test email\".\n\
  Set up Azure AI (needed for OCR + statement import): Config → Staff → \"Azure AI Foundry key\".\n\
";

async fn howto_answer(api_key: &str, question: &str) -> Result<(String, String), String> {
    let system = format!(
        "You answer 'how do I…' questions about the Echelon Receipts desktop app.\n\
         \n\
         GROUND RULES — non-negotiable:\n\
         - Answer with the EXACT UI navigation path from the app map below. Never invent screens, buttons, menus or SQL.\n\
         - Format the answer as numbered steps. Keep it to 3-8 concise steps.\n\
         - Use the arrow notation for menus, e.g. 'Students → Roster → + Add Student'.\n\
         - Reference real button labels in quotes when they help ('Save', 'Upload sheet', '✨ Amend with AI').\n\
         - If the requested feature is NOT in the app map, say so plainly and suggest the closest existing feature — do not guess.\n\
         - If the question has NOTHING to do with this daycare app (general knowledge, world facts, unrelated software, jokes, personal questions), reply with EXACTLY this sentence and nothing else: \"I can only help with features of this Echelon Receipts app. Try 'how do I add a student?' or 'how do I email a receipt?'.\"\n\
         - Do NOT mention SQL, tables, columns, JSON, or code. This is an end-user answer.\n\
         - No preamble. Start directly with step 1.\n\
         \n\
         APP MAP:\n{}",
        UI_NAV_MAP
    );
    let body = json!({
        "messages": [
            {"role":"system","content": system},
            {"role":"user","content": question}
        ],
        "temperature": 0.2,
        "max_completion_tokens": 500
    });
    let raw = call_chat(api_key, body).await?;
    let cleaned = strip_code_fence(&raw).trim().to_string();
    Ok((cleaned, "none".to_string()))
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
        • Refunds are receipts with is_refund=1; their amount is stored positive but nets negative in revenue.\n\
        • SCOPE: only answer questions about the schema below. If the question is unrelated (general knowledge, world facts, jokes, unrelated apps), return the literal SQL `SELECT 1 WHERE 0` — the caller will detect it and refuse politely. NEVER invent tables or hardcode literal answers to non-data questions.\n";
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
            let out = if should_redact(&v, col, redact) {
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

    // Enforce LIMIT 500. Rather than trying to detect an existing top-level
    // LIMIT textually (which can be bypassed by `LIMIT 999999` or by LIMIT
    // hiding inside a CTE/subquery), we ALWAYS wrap. Any inner LIMIT is
    // preserved by the subquery so semantics like `LIMIT 10` still hold —
    // the outer LIMIT 500 is a hard ceiling. SQLite pushes LIMIT down when
    // it can, so this is cheap for well-formed queries and safe for hostile
    // ones.
    let with_limit = format!("SELECT * FROM ({}) LIMIT {}", &cleaned, HARD_ROW_CAP);
    Ok(with_limit)
}

// Kept for tests only — production path uses the always-wrap logic above.
#[cfg(test)]
#[allow(dead_code)]
fn ensure_limit(sql: &str) -> Result<String, String> {
    Ok(format!("SELECT * FROM ({}) LIMIT {}", sql, HARD_ROW_CAP))
}

// Scope guard — returns true iff the (already validated) SQL text mentions
// at least one real user table from `tables`. Prevents the model from
// answering off-topic questions with hardcoded literals like
// `SELECT 'World War 2 started in 1939' AS answer`, which is syntactically
// a valid SELECT but has nothing to do with the daycare's data.
//
// Match is a case-insensitive whole-word check against the SQL text. False
// positives here (a table name buried in a string literal) are harmless —
// the query would then also reference that table via FROM.
fn sql_references_a_user_table(sql: &str, tables: &[String]) -> bool {
    if tables.is_empty() { return false; }
    let lower = sql.to_lowercase();
    for t in tables {
        let t_lower = t.to_lowercase();
        // Bracket the table name with non-identifier characters so `students`
        // doesn't spuriously match inside `students_archive` on either side.
        for (idx, _) in lower.match_indices(&t_lower) {
            let before_ok = idx == 0 || !is_ident_char(lower.as_bytes()[idx - 1] as char);
            let end = idx + t_lower.len();
            let after_ok = end == lower.len() || !is_ident_char(lower.as_bytes()[end] as char);
            if before_ok && after_ok { return true; }
        }
    }
    false
}

fn is_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

// ─── Read-only execution ────────────────────────────────────────────────
//
// The SQL AST validator above guarantees this is a single SELECT (or WITH
// ... SELECT) with no comments, no PRAGMA/ATTACH/DDL/DML, wrapped in an
// outer LIMIT 500. Any hostile input has already been rejected. Reusing
// the app's live DbGate connection (which may be SQLCipher-encrypted) is
// therefore safe — we no longer need our own read-only rusqlite handle.

async fn execute_readonly(
    gate: &DbGate, sql: &str,
) -> Result<(Vec<String>, Vec<Vec<Value>>, bool), String> {
    let (columns, rows) = gate
        .select_with_columns(sql, &[])
        .await
        .map_err(|e| format!("query: {e}"))?;
    let mut out: Vec<Vec<Value>> = Vec::with_capacity(rows.len().min(HARD_ROW_CAP));
    let mut truncated = false;
    for row in rows {
        if out.len() >= HARD_ROW_CAP {
            truncated = true;
            break;
        }
        let r: Vec<Value> = columns
            .iter()
            .map(|c| row.get(c).cloned().unwrap_or(Value::Null))
            .collect();
        out.push(r);
    }
    Ok((columns, out, truncated))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_guard_rejects_literal_answer_sql() {
        let tables = vec!["students".to_string(), "receipts".to_string(), "staff".to_string()];
        // The exact off-topic SQL the model produced for "when did WWII happen?"
        assert!(!sql_references_a_user_table(
            "SELECT 'World War 2 started on September 1, 1939' AS answer",
            &tables
        ));
        assert!(!sql_references_a_user_table(
            "SELECT * FROM (SELECT 1 WHERE 0) LIMIT 500",
            &tables
        ));
        assert!(!sql_references_a_user_table("SELECT 42", &tables));
    }

    #[test]
    fn scope_guard_accepts_real_queries() {
        let tables = vec!["students".to_string(), "receipts".to_string(), "staff".to_string()];
        assert!(sql_references_a_user_table("SELECT COUNT(*) FROM students", &tables));
        assert!(sql_references_a_user_table("SELECT * FROM (SELECT * FROM receipts WHERE voided=0) LIMIT 500", &tables));
        assert!(sql_references_a_user_table("select s.name from Students s join staff st on 1=1", &tables));
    }

    #[test]
    fn scope_guard_word_boundaries() {
        // "students" must not spuriously match inside "students_archive_v2".
        let tables = vec!["students".to_string()];
        assert!(sql_references_a_user_table("SELECT * FROM students WHERE id=1", &tables));
        // The bracketing check: an SQL that only references a different table
        // with a similar prefix should NOT satisfy the guard.
        assert!(!sql_references_a_user_table("SELECT 'students_archive_v2 is not on the schema' AS a", &tables));
    }

    #[test]
    fn scope_guard_empty_tables_refuses_all() {
        // Fail closed — a schema with zero user tables means every query is
        // off-topic by construction.
        assert!(!sql_references_a_user_table("SELECT * FROM anything", &[]));
    }

    // ── select_with_columns: order preservation + empty-set headers ─────
    #[tokio::test]
    async fn execute_readonly_preserves_column_order() {
        let d = tempfile::tempdir().unwrap();
        let gate = crate::db_gate::DbGate::new();
        gate.open_plaintext(&d.path().join("t.db")).await.unwrap();
        gate.execute(
            "CREATE TABLE t(z INT, a INT, m INT); INSERT INTO t VALUES(1,2,3);",
            &[],
        )
        .await
        .unwrap();
        let (cols, rows, _) = execute_readonly(&gate, "SELECT z, a, m FROM t")
            .await
            .unwrap();
        assert_eq!(cols, vec!["z".to_string(), "a".to_string(), "m".to_string()]);
        assert_eq!(rows.len(), 1);
    }

    #[tokio::test]
    async fn execute_readonly_emits_headers_on_empty_result() {
        let d = tempfile::tempdir().unwrap();
        let gate = crate::db_gate::DbGate::new();
        gate.open_plaintext(&d.path().join("t.db")).await.unwrap();
        gate.execute("CREATE TABLE t(x INT, y TEXT)", &[]).await.unwrap();
        let (cols, rows, _) = execute_readonly(&gate, "SELECT x, y FROM t WHERE 1=0")
            .await
            .unwrap();
        assert_eq!(cols, vec!["x".to_string(), "y".to_string()]);
        assert!(rows.is_empty());
    }

    // ── C-8: SQL validation must survive adversarial inputs ──────────────
    #[test]
    fn rejects_multiple_statements() {
        assert!(validate_and_normalize_sql("SELECT 1; SELECT 2").is_err());
        assert!(validate_and_normalize_sql("SELECT 1;DROP TABLE receipts").is_err());
    }

    #[test]
    fn rejects_comments_used_to_smuggle_or_hide_a_limit_bypass() {
        assert!(validate_and_normalize_sql("SELECT * FROM receipts -- LIMIT 1").is_err());
        assert!(validate_and_normalize_sql("SELECT * FROM receipts /* LIMIT 1000000 */").is_err());
        assert!(validate_and_normalize_sql("/* comment */ SELECT * FROM receipts").is_err());
    }

    #[test]
    fn rejects_non_select_statements() {
        assert!(validate_and_normalize_sql("DROP TABLE receipts").is_err());
        assert!(validate_and_normalize_sql("DELETE FROM receipts").is_err());
        assert!(validate_and_normalize_sql("UPDATE receipts SET amount = 0").is_err());
        assert!(validate_and_normalize_sql("PRAGMA table_info(receipts)").is_err());
        assert!(validate_and_normalize_sql("ATTACH DATABASE 'x' AS y").is_err());
        assert!(validate_and_normalize_sql("INSERT INTO receipts (id) VALUES (1)").is_err());
    }

    #[test]
    fn accepts_benign_union_of_two_selects() {
        assert!(validate_and_normalize_sql("SELECT * FROM receipts UNION SELECT * FROM receipts").is_ok());
    }

    #[test]
    fn accepts_plain_select_and_with_cte() {
        assert!(validate_and_normalize_sql("SELECT id, amount FROM receipts WHERE voided = 0").is_ok());
        assert!(validate_and_normalize_sql(
            "WITH recent AS (SELECT * FROM receipts) SELECT * FROM recent"
        ).is_ok());
    }

    #[test]
    fn appends_limit_when_missing_and_preserves_an_existing_lower_limit() {
        let with_added = validate_and_normalize_sql("SELECT * FROM receipts").unwrap();
        assert!(with_added.contains("LIMIT 500"));

        let with_existing = validate_and_normalize_sql("SELECT * FROM receipts LIMIT 10").unwrap();
        assert!(with_existing.contains("LIMIT 10"));
    }

    #[test]
    fn strips_code_fences_from_llm_output_before_validating() {
        let fenced = "```sql\nSELECT * FROM receipts\n```";
        assert!(validate_and_normalize_sql(fenced).is_ok());
    }

    // ── C-2: PII allowlist must fail closed ──────────────────────────────
    #[test]
    fn allowlist_covers_ids_dates_and_enums_but_not_free_text() {
        for safe in ["id", "student_id", "created_at", "updated_at", "status", "version", "amount", "amount_cents"] {
            assert!(is_safe_column(safe), "{safe} should be on the allowlist");
        }
        for unsafe_col in [
            "recipients", "body", "recipient_label", "message_body", "wa_me_url",
            "attendees_text", "status_note", "email_to", "email_body", "phone",
            "wa_number", "name", "notes", "address", "some_new_column_nobody_thought_of",
        ] {
            assert!(!is_safe_column(unsafe_col), "{unsafe_col} must be redacted by default (fail closed)");
        }
    }

    // ── C-2 follow-up: alias bypass must also fail closed ────────────────
    #[test]
    fn value_shape_check_blocks_alias_bypass() {
        // Column *name* is on the allowlist (id) but the *value* is clearly
        // an email — must still redact.
        let v_email = Value::String("alice@example.com".into());
        assert!(should_redact(&v_email, "id", true), "email aliased as `id` must redact");

        // Long free-text value under a safe-looking alias.
        let v_text = Value::String("This is a message body pretending to be a status".into());
        assert!(should_redact(&v_text, "status", true), "long text aliased as `status` must redact");

        // Value with spaces beyond ISO date shape → redact.
        let v_name = Value::String("Alice Bob Carol".into());
        assert!(should_redact(&v_name, "id", true), "multi-word name aliased as `id` must redact");

        // Legitimate short safe values pass.
        let v_id = Value::String("abc-123".into());
        assert!(!should_redact(&v_id, "id", true), "short id-shaped value on safe col passes");
        let v_iso = Value::String("2026-07-06T21:59:21".into());
        assert!(!should_redact(&v_iso, "created_at", true), "ISO timestamp on safe col passes");
        let v_status = Value::String("active".into());
        assert!(!should_redact(&v_status, "status", true), "short enum on safe col passes");

        // Non-string values are never redacted (numbers/nulls).
        let v_num = json!(42);
        assert!(!should_redact(&v_num, "amount", true));
        assert!(!should_redact(&Value::Null, "email", true));

        // redact=false disables everything.
        assert!(!should_redact(&v_email, "id", false));
    }

    // ── C-8 follow-up: LIMIT always wraps, cannot be bypassed ────────────
    #[test]
    fn limit_always_wraps_regardless_of_inner_limit() {
        let out = validate_and_normalize_sql("SELECT * FROM receipts LIMIT 999999").unwrap();
        assert!(out.contains("SELECT * FROM (") && out.contains(&format!("LIMIT {}", HARD_ROW_CAP)),
            "existing huge LIMIT must still be wrapped: {out}");
        let out2 = validate_and_normalize_sql("SELECT COUNT(*) FROM receipts").unwrap();
        assert!(out2.contains(&format!("LIMIT {}", HARD_ROW_CAP)));
    }
}

// ─── Save a query as a report ───────────────────────────────────────────
// Frontend does this via tauri-plugin-sql; kept here as a stub for future
// server-side operations (audit log, share, etc.).
