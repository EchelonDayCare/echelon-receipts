use crate::db_gate::{DbError, DbGate};
use chrono::NaiveDate;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

pub struct SqlGuard<'a>(&'a Connection);
impl<'a> SqlGuard<'a> {
    pub fn new(c: &'a Connection) -> Result<Self, DbError> {
        let has_config:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='finance_config')",[],|r|r.get(0))?;
        let enabled = has_config
            && c.query_row("SELECT EXISTS(SELECT 1 FROM finance_config)", [], |r| {
                r.get::<_, bool>(0)
            })?;
        c.authorizer(Some(move |ctx: rusqlite::hooks::AuthContext<'_>| {
            use rusqlite::hooks::{AuthAction as A, Authorization as R};
            let protected = |name: &str| {
                name.get(..8)
                    .is_some_and(|p| p.eq_ignore_ascii_case("finance_"))
            };
            let source = |name: &str| {
                enabled
                    && (name.eq_ignore_ascii_case("receipts")
                        || name.eq_ignore_ascii_case("expenses"))
            };
            let trusted = matches!(
                ctx.accessor,
                Some(
                    "finance_receipts_insert"
                        | "finance_receipts_update"
                        | "finance_expenses_insert"
                        | "finance_expenses_update"
                        | "finance_invalidate"
                )
            );
            let denied = match ctx.action {
                A::Insert { table_name }
                | A::Delete { table_name }
                | A::Update { table_name, .. } => protected(table_name) && !trusted,
                A::DropTable { table_name } | A::DropTempTable { table_name } => {
                    protected(table_name) || source(table_name)
                }
                A::CreateTable { table_name }
                | A::CreateTempTable { table_name }
                | A::AlterTable { table_name, .. } => protected(table_name) || source(table_name),
                A::CreateTrigger { trigger_name, .. }
                | A::DropTrigger { trigger_name, .. }
                | A::CreateTempTrigger { trigger_name, .. }
                | A::DropTempTrigger { trigger_name, .. } => protected(trigger_name),
                A::DropView { view_name }
                | A::CreateView { view_name }
                | A::CreateTempView { view_name }
                | A::DropTempView { view_name } => protected(view_name),
                A::Pragma {
                    pragma_name,
                    pragma_value: Some(value),
                } => {
                    [
                        "writable_schema",
                        "ignore_check_constraints",
                        "recursive_triggers",
                    ]
                    .contains(&pragma_name.to_ascii_lowercase().as_str())
                        || (pragma_name.eq_ignore_ascii_case("foreign_keys")
                            && !matches!(value, "ON" | "on" | "1"))
                }
                _ => false,
            };
            if denied {
                R::Deny
            } else {
                R::Allow
            }
        }));
        Ok(Self(c))
    }
}
impl Drop for SqlGuard<'_> {
    fn drop(&mut self) {
        self.0.authorizer(
            None::<fn(rusqlite::hooks::AuthContext<'_>) -> rusqlite::hooks::Authorization>,
        );
    }
}

fn invalid(message: impl Into<String>) -> DbError {
    DbError::InvalidOperation(message.into())
}
fn date(s: &str) -> Result<(), DbError> {
    if s.len() != 10 || NaiveDate::parse_from_str(s, "%Y-%m-%d").is_err() {
        return Err(invalid("Use a valid YYYY-MM-DD date."));
    }
    Ok(())
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, DbError> {
    v[key]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.len() <= 2000)
        .ok_or_else(|| invalid(format!("Missing or invalid {key}.")))
}
fn number(v: &Value, key: &str) -> Result<i64, DbError> {
    v[key]
        .as_i64()
        .filter(|n| n.unsigned_abs() <= 9_000_000_000_000)
        .ok_or_else(|| invalid(format!("Invalid integer {key}.")))
}
fn rows(conn: &Connection, sql: &str, args: &[&dyn rusqlite::ToSql]) -> Result<Value, DbError> {
    let mut stmt = conn.prepare(sql)?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let values = stmt
        .query_map(args, |row| {
            let mut obj = serde_json::Map::new();
            for (i, name) in names.iter().enumerate() {
                let value = match row.get_ref(i)? {
                    rusqlite::types::ValueRef::Null => Value::Null,
                    rusqlite::types::ValueRef::Integer(n) => json!(n),
                    rusqlite::types::ValueRef::Real(n) => json!(n),
                    rusqlite::types::ValueRef::Text(s) => json!(String::from_utf8_lossy(s)),
                    _ => Value::Null,
                };
                obj.insert(name.clone(), value);
            }
            Ok(Value::Object(obj))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!(values))
}
fn audit(c: &Connection, action: &str, detail: &str) -> Result<(), DbError> {
    if action != "export_report" {
        c.execute("UPDATE finance_report_exports SET superseded=1", [])?;
    }
    c.execute(
        "INSERT INTO finance_audit(action,detail) VALUES(?,?)",
        params![action, detail],
    )?;
    Ok(())
}
fn account(c: &Connection, code: &str) -> Result<String, DbError> {
    c.query_row(
        "SELECT kind FROM finance_accounts WHERE code=?",
        [code],
        |r| r.get(0),
    )
    .optional()?
    .ok_or_else(|| invalid("Account does not exist."))
}
fn post(
    c: &Connection,
    day: &str,
    desc: &str,
    debit: &str,
    credit: &str,
    cents: i64,
    source: &str,
    source_id: &str,
    reversal: Option<i64>,
) -> Result<i64, DbError> {
    date(day)?;
    account(c, debit)?;
    account(c, credit)?;
    if cents <= 0 || cents > 9_000_000_000_000 || debit == credit {
        return Err(invalid("Invalid journal amount or identical accounts."));
    }
    c.execute("INSERT INTO finance_entries(date,description,debit,credit,cents,source,source_id,reversal_of)
        VALUES(?,?,?,?,?,?,?,?)", params![day, desc, debit, credit, cents, source, source_id, reversal])?;
    Ok(c.last_insert_rowid())
}

pub fn validate_restore(c: &Connection) -> Result<(), DbError> {
    let has_finance: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='finance_config')",
        [],
        |r| r.get(0),
    )?;
    if !has_finance {
        return Ok(());
    }
    let active: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM finance_config)", [], |r| {
        r.get(0)
    })?;
    if !active {
        return Ok(());
    }
    let bad:i64=c.query_row("SELECT
      (SELECT COUNT(*) FROM finance_entries e WHERE e.reversal_of IS NOT NULL AND NOT EXISTS
        (SELECT 1 FROM finance_entries o WHERE o.id=e.reversal_of AND e.debit=o.credit AND e.credit=o.debit AND e.cents=o.cents))
      +(SELECT COUNT(*) FROM finance_active_entries e WHERE
        (e.source='receipt' AND NOT EXISTS(SELECT 1 FROM receipts r WHERE CAST(r.id AS TEXT)=e.source_id AND r.voided=0
          AND CAST(round(r.amount*100) AS INTEGER)=e.cents))
        OR (e.source='expense' AND NOT EXISTS(SELECT 1 FROM expenses x WHERE CAST(x.id AS TEXT)=e.source_id
          AND CAST(round(abs(x.amount)*100) AS INTEGER)=e.cents)))
      +(SELECT COUNT(*) FROM receipts r WHERE r.date>=(SELECT start_date FROM finance_config) AND r.voided=0 AND r.amount>0
        AND (SELECT COUNT(*) FROM finance_active_entries e WHERE e.source='receipt' AND e.source_id=CAST(r.id AS TEXT))<>1)
      +(SELECT COUNT(*) FROM expenses x WHERE x.date>=(SELECT start_date FROM finance_config) AND x.amount<>0
        AND (SELECT COUNT(*) FROM finance_active_entries e WHERE e.source='expense' AND e.source_id=CAST(x.id AS TEXT))<>1)
      +(SELECT COUNT(*) FROM finance_lines l WHERE abs(l.cents)<(SELECT COALESCE(SUM(a.cents),0) FROM finance_allocations a WHERE a.line_id=l.id))
      +(SELECT COUNT(*) FROM finance_allocations a WHERE NOT EXISTS(SELECT 1 FROM finance_active_entries e WHERE e.id=a.entry_id))",
      [],|r|r.get(0))?;
    if bad > 0 {
        return Err(invalid(
            "Backup has inconsistent source journals, reversals or allocations; restore refused.",
        ));
    }
    let structured:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='finance_funding_receipts')",[],|r|r.get(0))?;
    if structured {
        let orphaned:i64=c.query_row("SELECT COUNT(*) FROM finance_active_entries e WHERE e.id IN
            (SELECT entry_id FROM finance_funding_releases UNION ALL SELECT entry_id FROM finance_funding_refunds)
            AND NOT EXISTS(SELECT 1 FROM finance_active_entries parent WHERE parent.id=CAST(e.source_id AS INTEGER))",
            [],|r|r.get(0))?;
        if orphaned > 0 {
            return Err(invalid(
                "Backup has funding activity without an active original remittance.",
            ));
        }
        for f in funding_rows(c, "9999-12-31")?
            .as_array()
            .ok_or_else(|| invalid("Invalid funding history."))?
        {
            let received = number(f, "received_cents")?;
            let released = number(f, "released_cents")?;
            let refunded = number(f, "refunded_cents")?;
            if released + refunded > received
                || (f["treatment"] != "liability_until_release" && released > 0)
            {
                return Err(invalid(
                    "Backup funding releases/refunds exceed or contradict the original remittance.",
                ));
            }
        }
        let bad_exports: i64 = c.query_row(
            "SELECT COUNT(*) FROM finance_report_exports WHERE NOT json_valid(payload)",
            [],
            |r| r.get(0),
        )?;
        if bad_exports > 0 {
            return Err(invalid("Backup contains an invalid saved report payload."));
        }
    }
    for trigger in [
        "finance_receipts_insert",
        "finance_receipts_update",
        "finance_receipts_delete",
        "finance_expenses_insert",
        "finance_expenses_update",
        "finance_expenses_delete",
        "finance_entry_no_update",
        "finance_entry_no_delete",
    ] {
        let exists: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?)",
            [trigger],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(invalid(format!(
                "Backup is missing accounting guard {trigger}; restore refused."
            )));
        }
    }
    Ok(())
}

pub fn init(c: &Connection) -> Result<(), DbError> {
    // REPLACE must run DELETE guards too; otherwise unique-key conflicts can
    // remove posted sources without invoking their immutable-history checks.
    c.execute_batch("PRAGMA recursive_triggers=ON;")?;
    c.execute_batch("CREATE TABLE IF NOT EXISTS finance_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);")?;
    let version: i64 = c
        .query_row("SELECT version FROM finance_schema WHERE id=1", [], |r| {
            r.get(0)
        })
        .optional()?
        .unwrap_or(0);
    if version == 7 {
        return Ok(());
    }
    if version > 7 {
        return Err(invalid(
            "This accounting database requires a newer app version.",
        ));
    }
    let tx = c.unchecked_transaction()?;
    let c = &*tx;
    let names = {
        let mut stmt = c.prepare(
            "SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'finance_*'",
        )?;
        let names = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        names
    };
    for name in names {
        c.execute_batch(&format!("DROP TRIGGER \"{}\"", name.replace('"', "\"\"")))?;
    }
    c.execute_batch(include_str!("finance.sql"))?;
    let has_review = {
        let mut stmt = c.prepare("PRAGMA table_info(finance_config)")?;
        let names = stmt
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        names.iter().any(|name| name == "reviewed_entry_id")
    };
    if !has_review {
        c.execute_batch(
            "ALTER TABLE finance_config ADD COLUMN reviewed_entry_id INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    for (table, kind, fields) in [
        ("receipts", "receipt", "date,amount,voided,is_refund"),
        ("expenses", "expense", "date,amount,category,payment_method"),
    ] {
        let active = if table == "receipts" {
            "AND NEW.voided=0"
        } else {
            ""
        };
        let negative_check = if table == "receipts" {
            "OR NEW.amount<0 OR NEW.voided IS NULL OR NEW.voided NOT IN (0,1) OR NEW.is_refund IS NULL OR NEW.is_refund NOT IN (0,1)"
        } else {
            ""
        };
        let void_check = if table == "expenses" {
            "OR EXISTS(SELECT 1 FROM finance_expense_voids WHERE expense_id=OLD.id)"
        } else {
            ""
        };
        let amount = if table == "receipts" {
            "CASE WHEN NEW.is_refund=1 THEN -NEW.amount ELSE NEW.amount END"
        } else {
            "NEW.amount"
        };
        let (debit, credit) = if table == "receipts" {
            ("'receipts_pending'", "'parent_fees'")
        } else {
            ("COALESCE((SELECT code FROM finance_accounts WHERE code=NEW.category AND kind='expense'),'expense:'||NEW.category)", "CASE WHEN NEW.payment_method IN ('Visa Credit Card','Mastercard')
                THEN 'card:'||NEW.payment_method ELSE 'payments_pending' END")
        };
        let category = if table == "expenses" {
            "INSERT OR IGNORE INTO finance_accounts(code,name,kind) SELECT 'expense:'||NEW.category,NEW.category,'expense'
             WHERE NOT EXISTS(SELECT 1 FROM finance_accounts WHERE code=NEW.category AND kind='expense');"
        } else {
            ""
        };
        let guard_fields = if table == "receipts" {
            "OLD.date IS NOT NEW.date OR OLD.amount IS NOT NEW.amount OR OLD.voided IS NOT NEW.voided OR OLD.is_refund IS NOT NEW.is_refund"
        } else {
            "OLD.date IS NOT NEW.date OR OLD.amount IS NOT NEW.amount OR OLD.category IS NOT NEW.category OR OLD.payment_method IS NOT NEW.payment_method"
        };
        let insert = format!(
            "
            {category}
            INSERT INTO finance_entries(date,description,debit,credit,cents,source,source_id)
            SELECT NEW.date,'{kind} #'||NEW.id,
              CASE WHEN ({amount})>=0 THEN {debit} ELSE {credit} END,
              CASE WHEN ({amount})>=0 THEN {credit} ELSE {debit} END,
              CAST(round(abs(NEW.amount)*100) AS INTEGER),'{kind}',CAST(NEW.id AS TEXT)
            WHERE NEW.date >= (SELECT start_date FROM finance_config WHERE id=1)
              AND NEW.amount<>0 {active};"
        );
        c.execute_batch(&format!("
            CREATE TRIGGER IF NOT EXISTS finance_{table}_insert AFTER INSERT ON {table}
            WHEN EXISTS(SELECT 1 FROM finance_config) BEGIN {insert} END;
            CREATE TRIGGER IF NOT EXISTS finance_{table}_validate BEFORE INSERT ON {table}
            WHEN EXISTS(SELECT 1 FROM finance_config) AND
              (NEW.date < (SELECT start_date FROM finance_config) OR
               NEW.date <= (SELECT closed_through FROM finance_config) OR
               NEW.date IS NULL OR NEW.amount IS NULL OR abs(NEW.amount)>90000000000 OR
               abs(NEW.amount*100-round(NEW.amount*100))>0.0001
               OR date(NEW.date,'+0 days') IS NULL OR date(NEW.date,'+0 days')<>NEW.date {negative_check})
            BEGIN SELECT RAISE(ABORT,'Financial date/amount invalid or outside the open accounting period.'); END;
            CREATE TRIGGER IF NOT EXISTS finance_{table}_id BEFORE UPDATE OF id ON {table}
            WHEN EXISTS(SELECT 1 FROM finance_config) AND NEW.id<>OLD.id
            BEGIN SELECT RAISE(ABORT,'Financial source identifiers cannot be changed.'); END;
            CREATE TRIGGER IF NOT EXISTS finance_{table}_delete BEFORE DELETE ON {table}
            WHEN EXISTS(SELECT 1 FROM finance_entries WHERE source='{kind}' AND source_id=CAST(OLD.id AS TEXT))
            BEGIN SELECT RAISE(ABORT,'Posted source cannot be deleted. Reverse or void it after unmatching.'); END;
            CREATE TRIGGER IF NOT EXISTS finance_{table}_guard BEFORE UPDATE OF {fields} ON {table}
            WHEN EXISTS(SELECT 1 FROM finance_config) AND ({guard_fields}) AND
              (OLD.date < (SELECT start_date FROM finance_config) OR
               NEW.date < (SELECT start_date FROM finance_config) OR
               OLD.date <= (SELECT closed_through FROM finance_config) OR
               NEW.date <= (SELECT closed_through FROM finance_config) OR
               NEW.date IS NULL OR NEW.amount IS NULL OR abs(NEW.amount)>90000000000 OR
               abs(NEW.amount*100-round(NEW.amount*100))>0.0001 OR
               date(NEW.date,'+0 days') IS NULL OR date(NEW.date,'+0 days')<>NEW.date {negative_check} {void_check} OR
               EXISTS(SELECT 1 FROM finance_allocations WHERE (kind='{kind}' AND source_id=CAST(OLD.id AS TEXT))
                 OR entry_id IN (SELECT id FROM finance_active_entries WHERE source='{kind}' AND source_id=CAST(OLD.id AS TEXT))))
            BEGIN SELECT RAISE(ABORT,'Financial record is matched, closed, historical or invalid. Unmatch/reopen before correction.'); END;
            CREATE TRIGGER IF NOT EXISTS finance_{table}_update AFTER UPDATE OF {fields} ON {table}
            WHEN EXISTS(SELECT 1 FROM finance_config) AND ({guard_fields})
            BEGIN
              INSERT INTO finance_entries(date,description,debit,credit,cents,source,source_id,reversal_of)
              SELECT date,'Correction: '||description,credit,debit,cents,'reversal',CAST(id AS TEXT),id
              FROM finance_active_entries WHERE source='{kind}' AND source_id=CAST(OLD.id AS TEXT);
              {insert}
            END;"))?;
    }
    c.execute(
        "INSERT OR REPLACE INTO finance_schema(id,version) VALUES(1,7)",
        [],
    )?;
    tx.commit()?;
    Ok(())
}

fn snapshot(c: &Connection) -> Result<Value, DbError> {
    Ok(json!({
        "config": rows(c,"SELECT * FROM finance_config", &[])?,
        "policies": rows(c,"SELECT p.* FROM finance_funding_policies p WHERE id=(SELECT MAX(id)
            FROM finance_funding_policies q WHERE q.program=p.program) ORDER BY program",&[])?,
        "funding": funding_rows(c,"9999-12-31")?,
        "exports":rows(c,"SELECT id,date_from,date_to,superseded,created_at FROM finance_report_exports ORDER BY id DESC LIMIT 50",&[])?,
        "purchase_batches":rows(c,"SELECT import_batch_id AS id,COUNT(*) AS count,CAST(round(SUM(amount)*100) AS INTEGER) AS cents,
            MIN(date) AS date_from,MAX(date) AS date_to FROM expenses WHERE import_batch_id IS NOT NULL AND amount<>0
            GROUP BY import_batch_id ORDER BY MAX(date) DESC",&[])?,
        "accounts": rows(c,"SELECT a.*,COALESCE(SUM(m.cents),0) AS balance_cents FROM finance_accounts a
            LEFT JOIN finance_movements m ON m.account=a.code GROUP BY a.code ORDER BY a.kind,a.name",&[])?,
        "statements": rows(c,"SELECT s.id,s.account,s.date_from,s.date_to,s.opening_cents,s.closing_cents,
            CASE WHEN EXISTS(SELECT 1 FROM finance_statement_voids v WHERE v.statement_id=s.id) THEN 'withdrawn' ELSE s.status END AS status,
            s.source_name,s.source_hash,s.created_at,a.name AS account_name,
            (SELECT COUNT(*) FROM finance_lines l WHERE l.statement_id=s.id AND
             abs(l.cents)<>(SELECT COALESCE(SUM(x.cents),0) FROM finance_allocations x WHERE x.line_id=l.id)) AS unresolved
            FROM finance_statements s JOIN finance_accounts a ON a.code=s.account ORDER BY date_to DESC,s.id DESC",&[])?,
        "legacy": rows(c,"SELECT 'receipts' AS source,COUNT(*) AS count,MIN(date) AS earliest,MAX(date) AS latest
            FROM receipts UNION ALL SELECT 'expenses',COUNT(*),MIN(date),MAX(date) FROM expenses",&[])?,
    }))
}

#[derive(Deserialize)]
pub struct FinanceRequest {
    pub op: String,
    #[serde(default)]
    pub data: Value,
}

pub fn run(c: &Connection, request: FinanceRequest) -> Result<Value, DbError> {
    init(c)?;
    if request.op == "snapshot" || request.op == "init" {
        return snapshot(c);
    }
    let tx = c.unchecked_transaction()?;
    let c = &*tx;
    let v = &request.data;
    if !["preview", "configure", "undo_import", "void_expense"].contains(&request.op.as_str()) {
        let enabled: bool =
            c.query_row("SELECT EXISTS(SELECT 1 FROM finance_config)", [], |r| {
                r.get(0)
            })?;
        if !enabled {
            return Err(invalid("Enable accounting before posting or reconciling."));
        }
    }
    let result = match request.op.as_str() {
        "preview" => {
            let start=text(v,"start_date")?;date(start)?;
            rows(c,"SELECT 'receipts' AS source,COUNT(*) AS count,
                CAST(round(COALESCE(SUM(CASE WHEN is_refund=1 THEN -amount ELSE amount END),0)*100) AS INTEGER) AS cents
                FROM receipts WHERE date>=? AND voided=0
                UNION ALL SELECT 'expenses',COUNT(*),CAST(round(COALESCE(SUM(amount),0)*100) AS INTEGER)
                FROM expenses WHERE date>=?",&[&start,&start])?
        }
        "configure" => {
            let start = text(v,"start_date")?;
            date(start)?;
            if !start.ends_with("-09-01") { return Err(invalid("Start on September 1 of the initial fiscal year.")); }
            if c.query_row("SELECT COUNT(*) FROM finance_config", [], |r| r.get::<_,i64>(0))? > 0 {
                return Err(invalid("Accounting is already enabled. Cutover cannot be reset each year."));
            }
            if v["confirm_preview"] != true { return Err(invalid("Confirm the migration preview and safety backup first.")); }
            // Fail rather than coercing invalid or fractional-cent legacy money.
            for table in ["receipts","expenses"] {
                let bad:i64=c.query_row(&format!("SELECT COUNT(*) FROM {table} WHERE date>=? AND
                    (amount IS NULL OR abs(amount)>90000000000 OR
                     abs(amount*100-round(amount*100))>0.0001 OR date NOT GLOB '????-??-??'
                     OR date(date,'+0 days') IS NULL OR date(date,'+0 days')<>date
                     {})",if table=="receipts"{"OR amount<0"}else{""}),[start],|r|r.get(0))?;
                if bad>0 { return Err(invalid(format!("{table} has {bad} invalid monetary/date records. Correct before cutover."))); }
            }
            c.execute("INSERT INTO finance_config(id,start_date) VALUES(1,?)",[start])?;
            c.execute_batch("INSERT OR IGNORE INTO finance_accounts SELECT DISTINCT 'expense:'||category,category,'expense' FROM expenses;")?;
            c.execute("INSERT INTO finance_entries(date,description,debit,credit,cents,source,source_id)
                SELECT date,'receipt #'||id,CASE WHEN is_refund=1 THEN 'parent_fees' ELSE 'receipts_pending' END,
                CASE WHEN is_refund=1 THEN 'receipts_pending' ELSE 'parent_fees' END,CAST(round(amount*100) AS INTEGER),'receipt',CAST(id AS TEXT)
                FROM receipts WHERE date>=? AND voided=0 AND amount>0",[start])?;
            c.execute("INSERT INTO finance_entries(date,description,debit,credit,cents,source,source_id)
                SELECT date,'expense #'||id,
                CASE WHEN amount>0 THEN 'expense:'||category ELSE CASE WHEN payment_method IN ('Visa Credit Card','Mastercard')
                  THEN 'card:'||payment_method ELSE 'payments_pending' END END,
                CASE WHEN amount>0 THEN CASE WHEN payment_method IN ('Visa Credit Card','Mastercard')
                  THEN 'card:'||payment_method ELSE 'payments_pending' END ELSE 'expense:'||category END,
                CAST(round(abs(amount)*100) AS INTEGER),'expense',CAST(id AS TEXT)
                FROM expenses WHERE date>=? AND amount<>0",[start])?;
            audit(c,"enable",start)?;
            snapshot(c)?
        }
        "account" => {
            let name=text(v,"name")?;
            let kind=text(v,"kind")?;
            if !["bank","card","income","expense","asset","liability"].contains(&kind) {
                return Err(invalid("Select a supported account kind."));
            }
            let code=format!("user:{}",c.query_row("SELECT COALESCE(MAX(rowid),0)+1 FROM finance_accounts",[],|r|r.get::<_,i64>(0))?);
            c.execute("INSERT INTO finance_accounts VALUES(?,?,?)",params![code,name,kind])?;
            audit(c,"account",&code)?;
            snapshot(c)?
        }
        "opening" => {
            let code=text(v,"account")?;
            let kind=account(c,code)?;
            if !["bank","card","asset","liability","clearing"].contains(&kind.as_str()) { return Err(invalid("Opening balance needs a balance-sheet account.")); }
            let start:String=c.query_row("SELECT start_date FROM finance_config",[],|r|r.get(0))?;
            let amount=number(v,"cents")?;
            let evidence=text(v,"reason")?;
            let prior=rows(c,"SELECT * FROM finance_openings WHERE account=?",&[&code])?;
            let existing=rows(c,"SELECT id,cents,debit,credit FROM finance_active_entries WHERE source='opening' AND source_id=?",&[&code])?;
            for entry in existing.as_array().ok_or_else(||invalid("Invalid opening history."))? {
                let id=number(entry,"id")?;
                let linked:i64=c.query_row("SELECT COUNT(*) FROM finance_allocations WHERE entry_id=?",[id],|r|r.get(0))?;
                if linked>0{return Err(invalid("Unmatch opening entry allocations before correcting."));}
                post(c,&start,"Opening correction",text(entry,"credit")?,text(entry,"debit")?,
                    number(entry,"cents")?,"reversal",&id.to_string(),Some(id))?;
            }
            c.execute("INSERT INTO finance_openings(account,cents,evidence) VALUES(?,?,?)
                ON CONFLICT(account) DO UPDATE SET cents=excluded.cents,evidence=excluded.evidence,created_at=datetime('now')",params![code,amount,evidence])?;
            if amount!=0 {
                let (dr,cr)=if amount>0 {(code,"opening")}else{("opening",code)};
                post(c,&start,"Confirmed opening balance",dr,cr,amount.abs(),"opening",code,None)?;
            }
            c.execute("UPDATE finance_config SET opening_confirmed=0",[])?;
            audit(c,"opening",&format!("{code}: {amount}; evidence: {evidence}; prior: {prior}"))?;
            snapshot(c)?
        }
        "confirm_opening" => {
            text(v,"reason")?;
            let banks:i64=c.query_row("SELECT COUNT(*) FROM finance_accounts WHERE kind='bank'",[],|r|r.get(0))?;
            let missing:i64=c.query_row("SELECT COUNT(*) FROM finance_accounts a WHERE a.kind='bank'
                AND NOT EXISTS(SELECT 1 FROM finance_openings o WHERE o.account=a.code)",[],|r|r.get(0))?;
            if banks==0||missing>0{return Err(invalid("Create the bank accounts and record their verified opening balances first (including zero balances)."));}
            c.execute("UPDATE finance_config SET opening_confirmed=1",[])?;
            audit(c,"confirm_opening",text(v,"reason")?)?;
            snapshot(c)?
        }
        "confirm_funding" => {
            text(v,"reason")?;
            let confirmed:i64=c.query_row("SELECT COUNT(*) FROM finance_funding_policies p
                WHERE program IN ('CCFRI','ACCB','MCCB') AND treatment<>'unresolved'
                AND id=(SELECT MAX(id) FROM finance_funding_policies q WHERE q.program=p.program)",[],|r|r.get(0))?;
            if confirmed!=3{return Err(invalid("Record a reviewed policy (or not-applicable evidence) for CCFRI, ACCB and MCCB first."));}
            let unresolved:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM finance_funding_policies p
                WHERE treatment='unresolved' AND id=(SELECT MAX(id) FROM finance_funding_policies q WHERE q.program=p.program))",[],|r|r.get(0))?;
            if unresolved{return Err(invalid("An additional funding program remains unresolved."));}
            c.execute("UPDATE finance_config SET funding_confirmed=1",[])?;
            audit(c,"confirm_funding",text(v,"reason")?)?;
            snapshot(c)?
        }
        "funding_policy" => {
            let program=text(v,"program")?;
            let treatment=text(v,"treatment")?;
            if !["CCFRI","ACCB","MCCB","Other"].contains(&program)
                || !["unresolved","cash_income","liability_until_release","not_applicable"].contains(&treatment){
                return Err(invalid("Choose a supported funding program and treatment."));
            }
            c.execute("INSERT INTO finance_funding_policies(program,treatment,rule,evidence) VALUES(?,?,?,?)",
                params![program,treatment,text(v,"rule")?,text(v,"reason")?])?;
            c.execute("UPDATE finance_config SET funding_confirmed=0",[])?;
            audit(c,"funding_policy",&v.to_string())?;
            snapshot(c)?
        }
        "confirm_classification" => {
            let reason=text(v,"reason")?;
            c.execute("UPDATE finance_config SET reviewed_entry_id=(SELECT COALESCE(MAX(id),0) FROM finance_entries)",[])?;
            audit(c,"confirm_classification",reason)?;
            snapshot(c)?
        }
        "stage" => stage(c,v)?,
        "withdraw_statement" => {
            let id=number(v,"statement_id")?;
            let reason=text(v,"reason")?;
            let line:Option<i64>=c.query_row("SELECT id FROM finance_lines WHERE statement_id=? LIMIT 1",[id],|r|r.get(0)).optional()?;
            if let Some(line)=line{editable_line(c,line)?;}else{
                let status:String=c.query_row("SELECT status FROM finance_statements WHERE id=?",[id],|r|r.get(0))?;
                if status!="review"{return Err(invalid("Reopen the statement before withdrawing."));}
            }
            let linked:i64=c.query_row("SELECT COUNT(*) FROM finance_allocations a JOIN finance_lines l ON l.id=a.line_id WHERE l.statement_id=?",[id],|r|r.get(0))?;
            if linked>0{return Err(invalid("Unmatch all allocations before withdrawing a statement."));}
            c.execute("INSERT INTO finance_statement_voids(statement_id,reason) VALUES(?,?)",params![id,reason])?;
            audit(c,"withdraw_statement",&format!("{id}: {reason}"))?;
            snapshot(c)?
        }
        "lines" => {
            let id=number(v,"statement_id")?;
            json!({"lines":rows(c,"SELECT l.*,abs(l.cents)-COALESCE(SUM(a.cents),0) AS remaining
                FROM finance_lines l LEFT JOIN finance_allocations a ON a.line_id=l.id
                WHERE l.statement_id=? GROUP BY l.id ORDER BY l.ordinal",&[&id])?,
                "allocations":rows(c,"SELECT a.*,e.description FROM finance_allocations a JOIN finance_entries e ON e.id=a.entry_id
                 JOIN finance_lines l ON l.id=a.line_id WHERE l.statement_id=?",&[&id])?})
        }
        "source" => {
            let id=number(v,"statement_id")?;
            c.query_row("SELECT source_name,source_b64 FROM finance_statements WHERE id=?",[id],
                |r|Ok(json!({"name":r.get::<_,String>(0)?,"base64":r.get::<_,String>(1)?})))?
        }
        "candidates" => {
            let kind=text(v,"kind")?;
            if let Some(line)=v["line_id"].as_i64(){
                let (bank,day,signed,_)=editable_line(c,line)?;
                let used:i64=c.query_row("SELECT COALESCE(SUM(cents),0) FROM finance_allocations WHERE line_id=?",[line],|r|r.get(0))?;
                let remaining=signed.abs()-used;
                if kind=="existing"{
                    rows(c,"SELECT * FROM (SELECT e.*,e.cents-COALESCE((SELECT SUM(a.cents) FROM finance_allocations a
                        JOIN finance_lines l ON l.id=a.line_id JOIN finance_statements s ON s.id=l.statement_id
                        WHERE a.entry_id=e.id AND s.account=?),0) AS remaining,
                        abs(julianday(e.date)-julianday(?)) AS days_apart
                        FROM finance_active_entries e WHERE e.source<>'opening' AND
                        ((e.debit=? AND ?>0) OR (e.credit=? AND ?<0))) WHERE remaining>0
                        ORDER BY (remaining=?) DESC,days_apart,id",&[&bank,&day,&bank,&signed,&bank,&signed,&remaining])?
                }else{
                    if !["receipt","expense"].contains(&kind){return Err(invalid("Invalid source type."));}
                    let pending=if kind=="receipt"{"receipts_pending"}else{"payments_pending"};
                    rows(c,"SELECT * FROM (SELECT e.*,e.cents-COALESCE((SELECT SUM(a.cents) FROM finance_allocations a
                        WHERE a.kind=e.source AND a.source_id=e.source_id),0) AS remaining,
                        abs(julianday(e.date)-julianday(?)) AS days_apart
                        FROM finance_active_entries e WHERE e.source=? AND
                        ((e.debit=? AND ?>0) OR (e.credit=? AND ?<0))) WHERE remaining>0
                        ORDER BY (remaining=?) DESC,days_apart,id",&[&day,&kind,&pending,&signed,&pending,&signed,&remaining])?
                }
            } else {
            if !["receipt","expense"].contains(&kind) {return Err(invalid("Invalid source type."));}
            rows(c,"SELECT e.*,e.cents-COALESCE((SELECT SUM(a.cents) FROM finance_allocations a
                WHERE a.kind=e.source AND a.source_id=e.source_id),0) AS remaining
                FROM finance_active_entries e WHERE e.source=? ORDER BY e.date DESC,e.id DESC",&[&kind])?
            }
        }
        "deposit_batches" => {
            rows(c,"SELECT d.id,d.deposit_date,SUM(e.cents-COALESCE((SELECT SUM(a.cents)
                FROM finance_allocations a WHERE a.kind='receipt' AND a.source_id=e.source_id),0)) AS remaining
                FROM deposits d JOIN receipts r ON r.deposit_id=d.id JOIN finance_active_entries e
                ON e.source='receipt' AND e.source_id=CAST(r.id AS TEXT)
                WHERE d.voided=0 AND e.debit='receipts_pending' GROUP BY d.id HAVING remaining>0 ORDER BY d.deposit_date,d.id",&[])?
        }
        "allocate_batch" => {
            let batch=number(v,"batch_id")?;
            let line=number(v,"line_id")?;
            let mut amount=number(v,"cents")?;
            if amount<=0{return Err(invalid("Batch allocation must be positive."));}
            let sources=rows(c,"SELECT e.source_id,e.cents-COALESCE((SELECT SUM(a.cents) FROM finance_allocations a
                WHERE a.kind='receipt' AND a.source_id=e.source_id),0) AS remaining FROM receipts r
                JOIN deposits d ON d.id=r.deposit_id JOIN finance_active_entries e ON e.source='receipt' AND e.source_id=CAST(r.id AS TEXT)
                WHERE d.id=? AND d.voided=0 AND e.debit='receipts_pending' ORDER BY r.id",&[&batch])?;
            for source in sources.as_array().ok_or_else(||invalid("Invalid deposit batch."))?{
                let part=amount.min(number(source,"remaining")?);
                if part<=0{continue;}
                allocate(c,&json!({"line_id":line,"kind":"receipt","source_id":text(source,"source_id")?,"cents":part}))?;
                amount-=part;
                if amount==0{break;}
            }
            if amount!=0{return Err(invalid("Deposit batch has insufficient unallocated receipts. No allocations were saved."));}
            audit(c,"allocate_batch",&v.to_string())?;
            json!({"ok":true})
        }
        "allocate" => allocate(c,v)?,
        "funding_release" => {
            let id=number(v,"receipt_id")?;
            let amount=number(v,"cents")?;
            let (program,liability,total,received):(String,String,i64,String)=c.query_row("SELECT f.program,e.credit,e.cents,e.date
                FROM finance_funding_receipts f JOIN finance_active_entries e ON e.id=f.entry_id WHERE f.entry_id=?",[id],
                |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
            if account(c,&liability)?!="liability"{return Err(invalid("This remittance is already income; it cannot be released again."));}
            let day=text(v,"date")?;
            if day<received.as_str(){return Err(invalid("Release date cannot precede receipt date."));}
            funding_date(c,id,day)?;
            let used=funding_used(c,id)?;
            if amount<=0||amount>total-used{return Err(invalid("Release exceeds the remaining restricted/deferred funding."));}
            let evidence=text(v,"reason")?;
            let entry=post(c,day,evidence,&liability,&format!("funding_income:{program}"),amount,"funding_release",&id.to_string(),None)?;
            c.execute("INSERT INTO finance_funding_releases(entry_id,receipt_id,evidence) VALUES(?,?,?)",params![entry,id,evidence])?;
            audit(c,"funding_release",&v.to_string())?;
            snapshot(c)?
        }
        "export_report" => {
            let r=report(c,v)?;
            c.execute("INSERT INTO finance_report_exports(date_from,date_to,payload) VALUES(?,?,?)",
                params![text(v,"from")?,text(v,"to")?,r.to_string()])?;
            let id=c.last_insert_rowid();
            audit(c,"export_report",&id.to_string())?;
            json!({"id":id,"report":r})
        }
        "saved_report" => {
            let id=number(v,"id")?;
            let (payload,superseded):(String,bool)=c.query_row("SELECT payload,superseded FROM finance_report_exports WHERE id=?",[id],|r|Ok((r.get(0)?,r.get(1)?)))?;
            json!({"id":id,"superseded":superseded,"report":serde_json::from_str::<Value>(&payload).map_err(|e|invalid(format!("Saved report is corrupt: {e}")))?})
        }
        "undo_import" => {
            let batch=text(v,"batch_id")?;
            let active:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM finance_config)",[],|r|r.get(0))?;
            if !active {
                let count=c.execute("DELETE FROM expenses WHERE import_batch_id=?",[batch])?;
                audit(c,"undo_unposted_import",batch)?;
                json!({"count":count})
            } else {
                let reason=text(v,"reason")?;
                let originals=rows(c,"SELECT * FROM expenses WHERE import_batch_id=? AND amount<>0",&[&batch])?;
                let originals=originals.as_array().ok_or_else(||invalid("Invalid expense batch."))?;
                for original in originals {void_expense(c,number(original,"id")?,reason)?;}
                audit(c,"reverse_import",&format!("{batch}: {reason}"))?;
                json!({"count":originals.len()})
            }
        }
        "void_expense" => {
            let id=number(v,"id")?;
            let active:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM finance_config)",[],|r|r.get(0))?;
            if active{void_expense(c,id,text(v,"reason")?)?;}
            else if c.execute("DELETE FROM expenses WHERE id=?",[id])?!=1{return Err(invalid("Expense not found."));}
            audit(c,"void_expense",&v.to_string())?;
            json!({"ok":true})
        }
        "unmatch" => {
            let id=number(v,"allocation_id")?;
            let (entry,line,kind):(i64,i64,String)=c.query_row("SELECT entry_id,line_id,kind FROM finance_allocations WHERE id=?",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
            editable_line(c,line)?;
            let other:i64=c.query_row("SELECT COUNT(*) FROM finance_allocations WHERE entry_id=? AND id<>?",params![entry,id],|r|r.get(0))?;
            if kind!="existing" && other>0 {return Err(invalid("Unmatch the linked counterpart first."));}
            let funding_dependants:i64=c.query_row("SELECT COUNT(*) FROM finance_active_entries e WHERE e.id IN
                (SELECT entry_id FROM finance_funding_releases WHERE receipt_id=? UNION ALL
                 SELECT entry_id FROM finance_funding_refunds WHERE receipt_id=?)",params![entry,entry],|r|r.get(0))?;
            if funding_dependants>0{return Err(invalid("Reverse releases and unmatch funding refunds before unmatching the original remittance."));}
            c.execute("DELETE FROM finance_allocations WHERE id=?",[id])?;
            if kind!="existing" {
                c.execute("INSERT INTO finance_entries(date,description,debit,credit,cents,source,source_id,reversal_of)
                   SELECT date,'Unmatch: '||description,credit,debit,cents,'reversal',CAST(id AS TEXT),id FROM finance_active_entries WHERE id=?",[entry])?;
            }
            audit(c,"unmatch",&id.to_string())?;
            json!({"ok":true})
        }
        "reconcile" => reconcile(c,v)?,
        "reopen" => {
            let id=number(v,"statement_id")?;
            let reason=text(v,"reason")?;
            let through:Option<String>=c.query_row("SELECT closed_through FROM finance_config",[],|r|r.get(0))?;
            if through.is_some() { return Err(invalid("Reopen the accounting period before changing a reconciled statement.")); }
            // Conservative: reopening evidence invalidates all account reconciliations.
            c.execute("UPDATE finance_statements SET status='review'",[])?;
            audit(c,"reopen_statements",&format!("{id}: {reason}; all statements require revalidation"))?;
            snapshot(c)?
        }
        "report" => report(c,v)?,
        "review_outstanding" => {
            let id=number(v,"entry_id")?;let through=text(v,"through")?;date(through)?;
            let evidence=text(v,"reason")?;let amount=number(v,"cents")?;
            let sources=outstanding_rows(c,through)?;
            if !sources.as_array().ok_or_else(||invalid("Invalid source review."))?.iter()
                .any(|e|e["id"]==id && e["remaining"]==amount && amount>0){
                return Err(invalid("The outstanding amount changed or is not a pending source at this date. Reload the report."));
            }
            let closed:Option<String>=c.query_row("SELECT closed_through FROM finance_config",[],|r|r.get(0))?;
            if closed.as_deref().is_some_and(|d|through<=d){return Err(invalid("Reopen the period before changing outstanding-item approvals."));}
            c.execute("INSERT INTO finance_outstanding_reviews(entry_id,through_date,cents,evidence) VALUES(?,?,?,?)",params![id,through,amount,evidence])?;
            audit(c,"review_outstanding",&v.to_string())?;
            json!({"ok":true})
        }
        "journal" => {
            if [text(v,"debit")?,text(v,"credit")?].iter().any(|s|s.starts_with("funding_income:")||s.starts_with("funding_liability:")){
                return Err(invalid("Use funding receipt/release/refund controls to preserve remittance evidence."));
            }
            let entry=post(c,text(v,"date")?,text(v,"description")?,text(v,"debit")?,text(v,"credit")?,
                number(v,"cents")?,"adjustment",text(v,"description")?,None)?;
            audit(c,"adjustment",&entry.to_string())?;
            json!({"id":entry})
        }
        "reverse" => {
            let id=number(v,"entry_id")?;let reason=text(v,"reason")?;
            let linked:i64=c.query_row("SELECT COUNT(*) FROM finance_allocations WHERE entry_id=?",[id],|r|r.get(0))?;
            if linked>0{return Err(invalid("Unmatch all statement allocations before reversing."));}
            let (dr,cr,cents,source):(String,String,i64,String)=c.query_row(
                "SELECT debit,credit,cents,source FROM finance_active_entries WHERE id=?",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
            if !["adjustment","funding_release"].contains(&source.as_str()){return Err(invalid("Correct this event through its original receipt, expense, opening-balance or statement workflow."));}
            let original_day:String=c.query_row("SELECT date FROM finance_entries WHERE id=?",[id],|r|r.get(0))?;
            if text(v,"date")?<original_day.as_str(){return Err(invalid("Reversal date cannot precede the original entry."));}
            let new_id=post(c,text(v,"date")?,reason,&cr,&dr,cents,"reversal",&id.to_string(),Some(id))?;
            audit(c,"reverse",&format!("{id}: {reason}"))?;
            json!({"id":new_id})
        }
        "close_period" => {
            let through=text(v,"through")?;
            date(through)?;
            let previous:Option<String>=c.query_row("SELECT closed_through FROM finance_config",[],|r|r.get(0))?;
            if previous.as_deref().is_some_and(|p|through<p){return Err(invalid("Closing cannot move the lock backwards. Use reopen period with a reason."));}
            let start:String=c.query_row("SELECT start_date FROM finance_config",[],|r|r.get(0))?;
            let r=report(c,&json!({"from":start,"to":through}))?;
            if r["provisional"]!=false { return Err(invalid("Resolve report warnings before closing the accounting period.")); }
            c.execute("UPDATE finance_config SET closed_through=?", [through])?;
            audit(c,"close_period",through)?;
            snapshot(c)?
        }
        "reopen_period" => {
            let reason=text(v,"reason")?;
            c.execute("UPDATE finance_config SET closed_through=NULL",[])?;
            c.execute("UPDATE finance_report_exports SET superseded=1",[])?;
            audit(c,"reopen_period",reason)?;
            snapshot(c)?
        }
        _ => return Err(invalid("Unknown finance operation.")),
    };
    tx.commit()?;
    Ok(result)
}

fn stage(c: &Connection, v: &Value) -> Result<Value, DbError> {
    let code = text(v, "account")?;
    if !["bank", "card"].contains(&account(c, code)?.as_str()) {
        return Err(invalid("Statements need a bank or card account."));
    }
    let from = text(v, "date_from")?;
    let to = text(v, "date_to")?;
    date(from)?;
    date(to)?;
    let start: String = c.query_row("SELECT start_date FROM finance_config", [], |r| r.get(0))?;
    if from < start.as_str() || from > to {
        return Err(invalid(
            "Statement period must be on/after cutover and ordered.",
        ));
    }
    let opening = number(v, "opening_cents")?;
    let closing = number(v, "closing_cents")?;
    let hash = text(v, "source_hash")?;
    let source_name = text(v, "source_name")?;
    let source_b64 = v["source_b64"]
        .as_str()
        .filter(|s| s.len() <= 28 * 1024 * 1024)
        .ok_or_else(|| invalid("Original statement evidence is missing or too large."))?;
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(source_b64)
        .map_err(|_| invalid("Invalid statement evidence."))?;
    let calculated = Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    if hash != calculated {
        return Err(invalid(
            "Source statement checksum does not match its evidence.",
        ));
    }
    let lines = v["lines"]
        .as_array()
        .filter(|a| a.len() <= 10000)
        .ok_or_else(|| invalid("Statement needs at most 10000 transaction lines."))?;
    let mut sum = 0i64;
    for line in lines {
        let day = text(line, "date")?;
        date(day)?;
        if day < from || day > to {
            return Err(invalid("Transaction date outside statement period."));
        }
        text(line, "description")?;
        let n = number(line, "cents")?;
        if n == 0 {
            return Err(invalid("Statement lines cannot be zero."));
        }
        sum = sum
            .checked_add(n)
            .ok_or_else(|| invalid("Statement total overflow."))?;
    }
    if opening.checked_add(sum) != Some(closing) {
        return Err(invalid(
            "Opening balance plus signed transactions does not equal closing balance.",
        ));
    }
    let repeated: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM finance_statements WHERE account=? AND source_hash=?)",
        params![code, hash],
        |r| r.get(0),
    )?;
    if repeated {
        return Err(invalid("This source file is already retained. For a withdrawn import, prepare a corrected CSV; the original remains archived."));
    }
    let overlap: i64 = c.query_row(
        "SELECT COUNT(*) FROM finance_statements s WHERE account=? AND date_from<=? AND date_to>=?
        AND NOT EXISTS(SELECT 1 FROM finance_statement_voids v WHERE v.statement_id=s.id)",
        params![code, to, from],
        |r| r.get(0),
    )?;
    if overlap > 0 {
        return Err(invalid("This account already has an overlapping statement. Review the existing import; duplicates are not staged."));
    }
    c.execute("INSERT INTO finance_statements(account,date_from,date_to,opening_cents,closing_cents,source_hash,source_name,source_b64) VALUES(?,?,?,?,?,?,?,?)",
        params![code,from,to,opening,closing,hash,source_name,source_b64])?;
    let id = c.last_insert_rowid();
    for (i, line) in lines.iter().enumerate() {
        if let Some(bank_id) = line["bank_id"].as_str().filter(|s| !s.is_empty()) {
            let exists:i64=c.query_row("SELECT COUNT(*) FROM finance_lines l JOIN finance_statements s ON s.id=l.statement_id WHERE s.account=? AND l.bank_id=?
                AND NOT EXISTS(SELECT 1 FROM finance_statement_voids v WHERE v.statement_id=s.id)",
                params![code,bank_id],|r|r.get(0))?;
            if exists > 0 {
                return Err(invalid(
                    "A bank transaction ID is already imported for this account.",
                ));
            }
        }
        c.execute("INSERT INTO finance_lines(statement_id,date,description,cents,bank_id,ordinal) VALUES(?,?,?,?,?,?)",
            params![id,text(line,"date")?,text(line,"description")?,number(line,"cents")?,line["bank_id"].as_str(),i as i64])?;
    }
    audit(c, "stage", &format!("Statement {id}"))?;
    snapshot(c)
}

fn editable_line(c: &Connection, id: i64) -> Result<(String, String, i64, String), DbError> {
    let (account,day,amount,status):(String,String,i64,String)=c.query_row(
        "SELECT s.account,l.date,l.cents,s.status FROM finance_lines l JOIN finance_statements s ON s.id=l.statement_id WHERE l.id=?",
        [id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
    let withdrawn: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM finance_statement_voids v JOIN finance_lines l
        ON l.statement_id=v.statement_id WHERE l.id=?)",
        [id],
        |r| r.get(0),
    )?;
    if withdrawn {
        return Err(invalid(
            "Withdrawn statement evidence is archived and cannot be matched.",
        ));
    }
    let closed: Option<String> =
        c.query_row("SELECT closed_through FROM finance_config", [], |r| {
            r.get(0)
        })?;
    if status != "review" || closed.as_ref().is_some_and(|d| day <= *d) {
        return Err(invalid(
            "Reopen the statement/accounting period before editing.",
        ));
    }
    Ok((account, day, amount, status))
}
fn funding_used(c: &Connection, id: i64) -> Result<i64, DbError> {
    Ok(c.query_row(
        "SELECT COALESCE(SUM(cents),0) FROM finance_active_entries WHERE id IN
        (SELECT entry_id FROM finance_funding_releases WHERE receipt_id=? UNION ALL
         SELECT entry_id FROM finance_funding_refunds WHERE receipt_id=?)",
        params![id, id],
        |r| r.get(0),
    )?)
}
fn funding_date(c: &Connection, id: i64, day: &str) -> Result<(), DbError> {
    date(day)?;
    let last: Option<String> = c.query_row(
        "SELECT MAX(date) FROM finance_entries WHERE id IN
        (SELECT entry_id FROM finance_funding_releases WHERE receipt_id=? UNION ALL
         SELECT entry_id FROM finance_funding_refunds WHERE receipt_id=?) OR reversal_of IN
        (SELECT entry_id FROM finance_funding_releases WHERE receipt_id=? UNION ALL
         SELECT entry_id FROM finance_funding_refunds WHERE receipt_id=?)",
        params![id, id, id, id],
        |r| r.get(0),
    )?;
    if last.as_deref().is_some_and(|last| day < last) {
        return Err(invalid(
            "Funding changes must not predate the remittance's latest release, refund or reversal.",
        ));
    }
    Ok(())
}
fn void_expense(c: &Connection, id: i64, reason: &str) -> Result<(), DbError> {
    let originals = rows(c, "SELECT * FROM expenses WHERE id=?", &[&id])?;
    let original = originals
        .get(0)
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("Expense not found."))?;
    let old: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM finance_expense_voids WHERE expense_id=?)",
        [id],
        |r| r.get(0),
    )?;
    if old {
        return Err(invalid("This expense is already voided."));
    }
    c.execute(
        "UPDATE expenses SET amount=0,source_txn_hash=NULL,
        notes=COALESCE(notes,'')||char(10)||'Void: '||? WHERE id=?",
        params![reason, id],
    )?;
    c.execute(
        "INSERT INTO finance_expense_voids(expense_id,original_record,reason) VALUES(?,?,?)",
        params![id, json!(original).to_string(), reason],
    )?;
    Ok(())
}
fn funding_rows(c: &Connection, through: &str) -> Result<Value, DbError> {
    rows(c,"SELECT f.*,e.date,e.cents AS received_cents,p.treatment,
        COALESCE((SELECT SUM(r.cents) FROM finance_entries r JOIN finance_funding_releases x ON x.entry_id=r.id
          WHERE x.receipt_id=f.entry_id AND r.date<=? AND NOT EXISTS
            (SELECT 1 FROM finance_entries v WHERE v.reversal_of=r.id AND v.date<=?)),0) AS released_cents,
        COALESCE((SELECT SUM(r.cents) FROM finance_entries r JOIN finance_funding_refunds x ON x.entry_id=r.id
          WHERE x.receipt_id=f.entry_id AND r.date<=? AND NOT EXISTS
            (SELECT 1 FROM finance_entries v WHERE v.reversal_of=r.id AND v.date<=?)),0) AS refunded_cents
        FROM finance_funding_receipts f JOIN finance_entries e ON e.id=f.entry_id
        JOIN finance_funding_policies p ON p.id=f.policy_id WHERE e.date<=? AND NOT EXISTS
          (SELECT 1 FROM finance_entries v WHERE v.reversal_of=e.id AND v.date<=?)
        ORDER BY e.date,e.id",&[&through,&through,&through,&through,&through,&through])
}
fn outstanding_rows(c: &Connection, through: &str) -> Result<Value, DbError> {
    rows(c,"SELECT x.*,EXISTS(SELECT 1 FROM finance_outstanding_reviews r WHERE r.entry_id=x.id
        AND r.through_date=? AND r.cents=x.remaining) AS approved FROM
        (SELECT e.*,e.cents-COALESCE((SELECT SUM(a.cents) FROM finance_allocations a
          JOIN finance_lines l ON l.id=a.line_id WHERE a.kind=e.source AND a.source_id=e.source_id AND l.date<=?),0) AS remaining
         FROM finance_active_entries e WHERE e.date<=? AND e.source IN ('receipt','expense')
           AND (e.debit IN ('receipts_pending','payments_pending') OR e.credit IN ('receipts_pending','payments_pending'))) x
        WHERE remaining>0 ORDER BY date,id",&[&through,&through,&through])
}
fn allocate(c: &Connection, v: &Value) -> Result<Value, DbError> {
    let line = number(v, "line_id")?;
    let (bank, day, signed, _) = editable_line(c, line)?;
    let amount = number(v, "cents")?;
    let used: i64 = c.query_row(
        "SELECT COALESCE(SUM(cents),0) FROM finance_allocations WHERE line_id=?",
        [line],
        |r| r.get(0),
    )?;
    if amount <= 0 || amount > signed.abs() - used {
        return Err(invalid(
            "Allocation exceeds the remaining statement amount.",
        ));
    }
    let kind = text(v, "kind")?;
    let mut source_id = None;
    let entry = match kind {
        "funding" => {
            if signed <= 0 || account(c, &bank)? != "bank" {
                return Err(invalid("Funding receipts require a bank deposit. Use the refund action for repayments."));
            }
            let program = text(v, "program")?;
            let (policy, treatment): (i64, String) = c.query_row(
                "SELECT id,treatment FROM finance_funding_policies
                WHERE program=? ORDER BY id DESC LIMIT 1",
                [program],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            if !["cash_income", "liability_until_release"].contains(&treatment.as_str()) {
                return Err(invalid("Funding policy is unresolved or not applicable. Leave the line unresolved until reviewed."));
            }
            let first = text(v, "period_from")?;
            let last = text(v, "period_to")?;
            date(first)?;
            date(last)?;
            if first > last {
                return Err(invalid("Funding service period must be ordered."));
            }
            let reference = text(v, "reference")?;
            let evidence = text(v, "reason")?;
            let income = format!("funding_income:{program}");
            let liability = format!("funding_liability:{program}");
            c.execute(
                "INSERT OR IGNORE INTO finance_accounts VALUES(?,?,'income')",
                params![income, format!("{program} funding income")],
            )?;
            c.execute(
                "INSERT OR IGNORE INTO finance_accounts VALUES(?,?,'liability')",
                params![liability, format!("{program} deferred/restricted funding")],
            )?;
            let credit = if treatment == "cash_income" {
                &income
            } else {
                &liability
            };
            let entry = post(
                c,
                &day,
                reference,
                &bank,
                credit,
                amount,
                "funding",
                &line.to_string(),
                None,
            )?;
            c.execute("INSERT INTO finance_funding_receipts(entry_id,policy_id,program,period_from,period_to,reference,evidence)
                VALUES(?,?,?,?,?,?,?)",params![entry,policy,program,first,last,reference,evidence])?;
            entry
        }
        "funding_refund" => {
            if signed >= 0 || account(c, &bank)? != "bank" {
                return Err(invalid("Funding refunds require a bank withdrawal."));
            }
            let id = number(v, "receipt_id")?;
            funding_date(c, id, &day)?;
            let (credit, total, received): (String, i64, String) = c.query_row(
                "SELECT e.credit,e.cents,e.date FROM finance_active_entries e
                JOIN finance_funding_receipts f ON f.entry_id=e.id WHERE e.id=?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?;
            if day < received || amount > total - funding_used(c, id)? {
                return Err(invalid("Refund predates or exceeds the unrefunded/unreleased funding. Reverse applicable releases first."));
            }
            let evidence = text(v, "reason")?;
            let entry = post(
                c,
                &day,
                evidence,
                &credit,
                &bank,
                amount,
                "funding_refund",
                &id.to_string(),
                None,
            )?;
            c.execute(
                "INSERT INTO finance_funding_refunds(entry_id,receipt_id,evidence) VALUES(?,?,?)",
                params![entry, id, evidence],
            )?;
            entry
        }
        "receipt" | "expense" => {
            if kind == "receipt" && account(c, &bank)? != "bank" {
                return Err(invalid(
                    "Match parent receipts to a bank statement, not a credit card.",
                ));
            }
            let source = text(v, "source_id")?;
            let (id,dr,cr,total):(i64,String,String,i64)=c.query_row("SELECT id,debit,credit,cents FROM finance_active_entries WHERE source=? AND source_id=?",params![kind,source],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
            let pending = if kind == "receipt" {
                "receipts_pending"
            } else {
                "payments_pending"
            };
            let direction = if dr == pending {
                1
            } else if cr == pending {
                -1
            } else {
                0
            };
            if direction == 0 || signed.signum() != direction {
                return Err(invalid("This source has no compatible pending cash movement. Match a card settlement separately."));
            }
            let used:i64=c.query_row("SELECT COALESCE(SUM(cents),0) FROM finance_allocations WHERE kind=? AND source_id=?",params![kind,source],|r|r.get(0))?;
            if amount > total - used {
                return Err(invalid("Source amount already allocated."));
            }
            source_id = Some(source.to_string());
            let (debit, credit) = if signed > 0 {
                (bank.as_str(), pending)
            } else {
                (pending, bank.as_str())
            };
            post(
                c,
                &day,
                &format!("Clear {kind} #{source} (entry {id})"),
                debit,
                credit,
                amount,
                "settlement",
                &line.to_string(),
                None,
            )?
        }
        "existing" => {
            let id = number(v, "entry_id")?;
            let movement: i64 = c.query_row(
                "SELECT CASE WHEN debit=? THEN cents WHEN credit=? THEN -cents ELSE 0 END
                FROM finance_active_entries WHERE id=? AND source<>'opening'",
                params![bank, bank, id],
                |r| r.get(0),
            )?;
            let used:i64=c.query_row("SELECT COALESCE(SUM(a.cents),0) FROM finance_allocations a
                JOIN finance_lines l ON l.id=a.line_id JOIN finance_statements s ON s.id=l.statement_id
                WHERE a.entry_id=? AND s.account=?",params![id,bank],|r|r.get(0))?;
            if movement.signum() != signed.signum() || amount > movement.abs() - used {
                return Err(invalid(
                    "Entry has no remaining compatible account movement.",
                ));
            }
            id
        }
        "new" | "transfer" => {
            let other = text(v, "account")?;
            let other_kind = account(c, other)?;
            if other.starts_with("funding_income:") || other.starts_with("funding_liability:") {
                return Err(invalid(
                    "Use the funding allocation controls for program accounts.",
                ));
            }
            if other == bank
                || (kind == "transfer"
                    && !["bank", "card", "asset", "liability"].contains(&other_kind.as_str()))
                || (kind == "new"
                    && !["income", "expense", "asset", "liability"].contains(&other_kind.as_str()))
            {
                return Err(invalid("Choose a compatible counterpart account."));
            }
            if kind == "new" && other_kind == "expense" {
                let category = other.strip_prefix("expense:").unwrap_or(other);
                let expense_amount = if signed < 0 { amount } else { -amount };
                c.execute("INSERT INTO expenses(date,category,vendor,amount,payment_method,reference,notes)
                    VALUES(?,?,?,?,'Other',?,?)",params![day,category,text(v,"description")?,
                    expense_amount as f64/100.0,format!("Statement line #{line}"),
                    format!("Created during reconciliation of {bank}. Match the existing purchase; do not import it again.")])?;
                let expense_id = c.last_insert_rowid();
                return allocate(
                    c,
                    &json!({"line_id":line,"kind":"expense","source_id":expense_id.to_string(),"cents":amount}),
                );
            } else {
                let (dr, cr) = if signed > 0 {
                    (bank.as_str(), other)
                } else {
                    (other, bank.as_str())
                };
                post(
                    c,
                    &day,
                    text(v, "description")?,
                    dr,
                    cr,
                    amount,
                    kind,
                    &line.to_string(),
                    None,
                )?
            }
        }
        _ => {
            return Err(invalid(
                "Choose match receipt, match expense, existing entry, new item or transfer.",
            ))
        }
    };
    let allocation_kind = if ["funding", "funding_refund"].contains(&kind) {
        "new"
    } else {
        kind
    };
    c.execute(
        "INSERT INTO finance_allocations(line_id,entry_id,cents,kind,source_id) VALUES(?,?,?,?,?)",
        params![line, entry, amount, allocation_kind, source_id],
    )?;
    audit(c, "allocate", &format!("{line} -> {entry}: {amount}"))?;
    Ok(json!({"ok":true}))
}
fn reconcile(c: &Connection, v: &Value) -> Result<Value, DbError> {
    let id = number(v, "statement_id")?;
    let withdrawn: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM finance_statement_voids WHERE statement_id=?)",
        [id],
        |r| r.get(0),
    )?;
    if withdrawn {
        return Err(invalid("Withdrawn statements cannot be reconciled."));
    }
    let (code,from,to,opening,closing):(String,String,String,i64,i64)=c.query_row(
        "SELECT account,date_from,date_to,opening_cents,closing_cents FROM finance_statements WHERE id=?",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?;
    let pending: i64 = c.query_row(
        "SELECT COUNT(*) FROM finance_lines l WHERE statement_id=? AND abs(cents)<>
        (SELECT COALESCE(SUM(a.cents),0) FROM finance_allocations a WHERE a.line_id=l.id)",
        [id],
        |r| r.get(0),
    )?;
    let before:i64=c.query_row("SELECT COALESCE(SUM(cents),0) FROM finance_movements WHERE account=? AND (date<? OR
        (date=? AND id IN (SELECT e.id FROM finance_entries e WHERE e.source='opening'
          OR EXISTS(SELECT 1 FROM finance_entries o WHERE o.id=e.reversal_of AND o.source='opening'))))",params![code,from,from],|r|r.get(0))?;
    let end: i64 = c.query_row(
        "SELECT COALESCE(SUM(cents),0) FROM finance_movements WHERE account=? AND date<=?",
        params![code, to],
        |r| r.get(0),
    )?;
    if pending != 0 || before != opening || end != closing {
        return Err(invalid(format!("Cannot reconcile: {pending} unresolved lines; book opening {before} vs statement {opening}; book closing {end} vs statement {closing} cents.")));
    }
    c.execute(
        "UPDATE finance_statements SET status='reconciled' WHERE id=?",
        [id],
    )?;
    audit(c, "reconcile", &id.to_string())?;
    snapshot(c)
}
fn report(c: &Connection, v: &Value) -> Result<Value, DbError> {
    let from = text(v, "from")?;
    let to = text(v, "to")?;
    date(from)?;
    date(to)?;
    let start: Option<String> = c
        .query_row("SELECT start_date FROM finance_config", [], |r| r.get(0))
        .optional()?;
    let start = start.ok_or_else(|| invalid("Enable accounting before running ledger reports."))?;
    if from < start.as_str() || from > to {
        return Err(invalid(
            "Report range must be on/after cutover and ordered.",
        ));
    }
    let categories=rows(c,"SELECT a.code,a.name,a.kind,COALESCE(SUM(m.cents),0) AS balance_cents
        FROM finance_accounts a LEFT JOIN finance_movements m ON m.account=a.code AND m.date BETWEEN ? AND ?
        WHERE a.kind IN ('income','expense') GROUP BY a.code ORDER BY a.kind,a.name",&[&from,&to])?;
    let totals = rows(
        c,
        "SELECT substr(m.date,1,7) AS month,
        SUM(CASE WHEN a.kind='income' THEN -m.cents ELSE 0 END) AS income_cents,
        SUM(CASE WHEN a.kind='expense' THEN m.cents ELSE 0 END) AS expense_cents
        FROM finance_movements m JOIN finance_accounts a ON a.code=m.account
        WHERE m.date BETWEEN ? AND ? GROUP BY substr(m.date,1,7) ORDER BY month",
        &[&from, &to],
    )?;
    let mut warnings = Vec::new();
    let (opening, funding): (bool, bool) = c.query_row(
        "SELECT opening_confirmed,funding_confirmed FROM finance_config",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if !opening {
        warnings.push("Opening balances and outstanding items have not been confirmed.");
    }
    if !funding {
        warnings.push("Funding recognition rules/remittance allocations are not confirmed.");
    }
    let unreviewed: i64 = c.query_row(
        "SELECT COUNT(*) FROM finance_entries WHERE date<=?
        AND id>(SELECT reviewed_entry_id FROM finance_config)",
        [to],
        |r| r.get(0),
    )?;
    if unreviewed > 0 {
        warnings.push("New/converted journals need classification review: paid versus unpaid, funding, card timing, capital, payroll and taxes.");
    }
    let bank_count: i64 = c.query_row(
        "SELECT COUNT(*) FROM finance_accounts WHERE kind='bank'",
        [],
        |r| r.get(0),
    )?;
    if bank_count == 0 {
        warnings.push("No bank account is configured.");
    }
    let missing_openings:i64=c.query_row("SELECT COUNT(*) FROM finance_accounts a WHERE
        (a.kind='bank' OR (a.kind='card' AND EXISTS(SELECT 1 FROM finance_movements m WHERE m.account=a.code)))
        AND NOT EXISTS(SELECT 1 FROM finance_openings o WHERE o.account=a.code)",[],|r|r.get(0))?;
    if missing_openings > 0 {
        warnings.push(
            "Bank/card opening balances are missing (record zero explicitly where appropriate).",
        );
    }
    let pending: i64 = c.query_row(
        "SELECT COUNT(*) FROM finance_statements s WHERE date_from<=? AND status<>'reconciled'
        AND NOT EXISTS(SELECT 1 FROM finance_statement_voids v WHERE v.statement_id=s.id)",
        [to],
        |r| r.get(0),
    )?;
    if pending > 0 {
        warnings.push("Imported statements remain unreconciled.");
    }
    let outstanding = outstanding_rows(c, to)?;
    let items = outstanding
        .as_array()
        .ok_or_else(|| invalid("Invalid outstanding items."))?;
    if items.iter().any(|e| e["approved"] != 1) {
        warnings.push("Individual source payments remain unmatched and need period-specific outstanding-item evidence, even if their balances offset.");
    }
    for code in ["receipts_pending", "payments_pending"] {
        let expected = items
            .iter()
            .try_fold(0i64, |sum, e| -> Result<i64, DbError> {
                let value = number(e, "remaining")?;
                Ok(sum
                    + if e["debit"] == code {
                        value
                    } else if e["credit"] == code {
                        -value
                    } else {
                        0
                    })
            })?;
        let actual: i64 = c.query_row(
            "SELECT COALESCE(SUM(cents),0) FROM finance_movements WHERE account=? AND date<=?",
            params![code, to],
            |r| r.get(0),
        )?;
        if expected != actual {
            warnings.push("Clearing contains movements not explained by individual outstanding source payments.");
            break;
        }
    }
    let mut stmt = c.prepare(
        "SELECT code FROM finance_accounts a WHERE a.kind='bank'
        OR (a.kind='card' AND EXISTS(SELECT 1 FROM finance_movements m WHERE m.account=a.code))",
    )?;
    let accounts = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut missing_coverage = false;
    for code in accounts {
        let mut next = start.clone();
        let mut stmt=c.prepare("SELECT date_from,date_to FROM finance_statements s
            WHERE account=? AND status='reconciled' AND NOT EXISTS(SELECT 1 FROM finance_statement_voids v WHERE v.statement_id=s.id)
            ORDER BY date_from")?;
        let periods = stmt
            .query_map([code], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (first, last) in periods {
            if last < next {
                continue;
            }
            if first > next {
                break;
            }
            next = NaiveDate::parse_from_str(&last, "%Y-%m-%d")
                .map_err(|_| invalid("Invalid statement date."))?
                .succ_opt()
                .ok_or_else(|| invalid("Statement date overflow."))?
                .format("%Y-%m-%d")
                .to_string();
            if next.as_str() > to {
                break;
            }
        }
        if next.as_str() <= to {
            missing_coverage = true;
        }
    }
    if missing_coverage {
        warnings.push("Continuous reconciled statement coverage from cutover through the report end is incomplete.");
    }
    Ok(
        json!({"from":from,"to":to,"basis":"cash","provisional":!warnings.is_empty(),"warnings":warnings,
        "categories":categories,"months":totals,
        "trial_balance":rows(c,"SELECT a.code,a.name,a.kind,COALESCE(SUM(m.cents),0) AS balance_cents
          FROM finance_accounts a LEFT JOIN finance_movements m ON m.account=a.code AND m.date<=?
          GROUP BY a.code ORDER BY a.kind,a.name",&[&to])?,
        "entries":rows(c,"SELECT e.* FROM finance_entries e WHERE date BETWEEN ? AND ? ORDER BY date,id",&[&from,&to])?,
        "cash_flow":rows(c,"SELECT a.name,COALESCE(SUM(CASE WHEN m.cents>0 THEN m.cents ELSE 0 END),0) AS inflow_cents,
          COALESCE(SUM(CASE WHEN m.cents<0 THEN -m.cents ELSE 0 END),0) AS outflow_cents FROM finance_accounts a
          LEFT JOIN finance_movements m ON m.account=a.code AND m.date BETWEEN ? AND ?
            AND m.id IN (SELECT e.id FROM finance_entries e WHERE e.source<>'opening'
              AND NOT EXISTS(SELECT 1 FROM finance_entries o WHERE o.id=e.reversal_of AND o.source='opening'))
          WHERE a.kind='bank' GROUP BY a.code ORDER BY a.name",&[&from,&to])?,
        "funding":funding_rows(c,to)?,"outstanding":outstanding,
        "audit":rows(c,"SELECT * FROM finance_audit ORDER BY id DESC LIMIT 100",&[])?}),
    )
}

#[tauri::command]
pub async fn finance(
    app: tauri::AppHandle,
    auth: tauri::State<'_, crate::auth::AuthState>,
    db: tauri::State<'_, DbGate>,
    request: FinanceRequest,
) -> Result<Value, String> {
    db.with_conn(|c| {
        if !c.is_autocommit() {
            return Err(invalid(
                "Finish the current database write before using Finance.",
            ));
        }
        let backup = if request.op == "configure" {
            let busy: i64 = c.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0))?;
            if busy != 0 {
                return Err(invalid(
                    "Database busy; retry after other work completes to create the safety backup.",
                ));
            }
            Some(crate::restore::backup_before_data_cleanup(app, auth).map_err(invalid)?)
        } else {
            None
        };
        let mut result = run(c, request)?;
        if let (Some(path), Some(obj)) = (backup, result.as_object_mut()) {
            obj.insert("backup_path".into(), json!(path));
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    fn test_hash() -> String {
        use sha2::{Digest, Sha256};
        Sha256::digest(b"test")
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }
    fn statement(
        code: &str,
        from: &str,
        to: &str,
        opening: i64,
        closing: i64,
        lines: Value,
    ) -> Value {
        use base64::Engine;
        use sha2::{Digest, Sha256};
        let evidence = format!("synthetic {code} {from}");
        json!({"account":code,"date_from":from,"date_to":to,"opening_cents":opening,"closing_cents":closing,
          "source_hash":Sha256::digest(evidence.as_bytes()).iter().map(|b|format!("{b:02x}")).collect::<String>(),
          "source_name":"synthetic.csv","source_b64":base64::engine::general_purpose::STANDARD.encode(evidence),
          "lines":lines})
    }
    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE receipts(id INTEGER PRIMARY KEY,date TEXT,amount REAL,voided INTEGER DEFAULT 0,is_refund INTEGER DEFAULT 0,deposit_id INTEGER);
            CREATE TABLE deposits(id INTEGER PRIMARY KEY,deposit_date TEXT,voided INTEGER DEFAULT 0);
            CREATE TABLE expenses(id INTEGER PRIMARY KEY,date TEXT,amount REAL,category TEXT,payment_method TEXT,
              import_batch_id TEXT,source_txn_hash TEXT UNIQUE,notes TEXT,vendor TEXT,reference TEXT);").unwrap();
        init(&c).unwrap();
        c
    }
    fn call(c: &Connection, op: &str, data: Value) -> Result<Value, DbError> {
        run(
            c,
            FinanceRequest {
                op: op.into(),
                data,
            },
        )
    }
    pub(crate) fn enabled() -> Connection {
        let c = db();
        call(
            &c,
            "configure",
            json!({"start_date":"2026-09-01","confirm_preview":true}),
        )
        .unwrap();
        c.execute(
            "INSERT INTO finance_accounts VALUES('bank','TD','bank')",
            [],
        )
        .unwrap();
        c
    }
    #[test]
    fn source_posting_and_raw_delete_guard() {
        let c = enabled();
        c.execute(
            "INSERT INTO receipts(id,date,amount) VALUES(1,'2026-09-02',100)",
            [],
        )
        .unwrap();
        assert_eq!(
            c.query_row("SELECT SUM(cents) FROM finance_entries", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            10000
        );
        assert!(c.execute("DELETE FROM receipts", []).is_err());
        c.execute("UPDATE receipts SET amount=90", []).unwrap();
        assert_eq!(
            c.query_row(
                "SELECT SUM(cents) FROM finance_movements WHERE account='parent_fees'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            -9000
        );
        assert!(c.execute("UPDATE finance_entries SET cents=1", []).is_err());
        assert!(c
            .execute(
                "INSERT OR REPLACE INTO receipts(id,date,amount) VALUES(1,'2026-09-02',200)",
                []
            )
            .is_err());
        assert_eq!(
            c.query_row("SELECT amount FROM receipts WHERE id=1", [], |r| r
                .get::<_, f64>(0))
                .unwrap(),
            90.0
        );
    }
    #[test]
    fn stage_and_match_once() {
        let c = enabled();
        c.execute(
            "INSERT INTO receipts(id,date,amount) VALUES(1,'2026-09-02',100)",
            [],
        )
        .unwrap();
        let stmt = json!({"account":"bank","date_from":"2026-09-01","date_to":"2026-09-30","opening_cents":0,"closing_cents":10000,"source_hash":test_hash(),"source_name":"test.csv","source_b64":"dGVzdA==",
            "lines":[{"date":"2026-09-03","description":"deposit","cents":10000}]});
        call(&c, "stage", stmt.clone()).unwrap();
        assert!(call(&c, "stage", stmt).is_err());
        call(
            &c,
            "allocate",
            json!({"line_id":1,"kind":"receipt","source_id":"1","cents":10000}),
        )
        .unwrap();
        assert!(call(
            &c,
            "allocate",
            json!({"line_id":1,"kind":"receipt","source_id":"1","cents":1})
        )
        .is_err());
        assert!(c.execute("UPDATE receipts SET amount=200", []).is_err());
        call(&c, "reconcile", json!({"statement_id":1})).unwrap();
        assert!(call(&c, "unmatch", json!({"allocation_id":1})).is_err());
        let r = call(&c, "report", json!({"from":"2026-09-01","to":"2026-09-30"})).unwrap();
        assert_eq!(r["months"][0]["income_cents"], 10000);
        assert_eq!(r["provisional"], true);
    }
    #[test]
    fn card_payment_is_not_expense() {
        let c = enabled();
        c.execute("INSERT INTO expenses(id,date,amount,category,payment_method) VALUES(1,'2026-09-02',50,'supplies','Visa Credit Card')",[]).unwrap();
        post(
            &c,
            "2026-09-03",
            "Visa repayment",
            "card:Visa Credit Card",
            "bank",
            5000,
            "transfer",
            "test",
            None,
        )
        .unwrap();
        let r = call(&c, "report", json!({"from":"2026-09-01","to":"2026-09-30"})).unwrap();
        assert_eq!(r["months"][0]["expense_cents"], 5000);
        assert_eq!(
            c.query_row("SELECT SUM(cents) FROM finance_movements", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn invalid_statement_rolls_back() {
        let c = enabled();
        let error = call(
            &c,
            "stage",
            statement(
                "bank",
                "2026-09-01",
                "2026-09-30",
                0,
                100,
                json!([{"date":"2026-09-02","description":"x","cents":200}]),
            ),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("does not equal closing"), "{error}");
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM finance_statements", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(c
            .execute(
                "INSERT INTO receipts(id,date,amount) VALUES(1,'2026-09-02',1.001)",
                []
            )
            .is_err());
    }
    #[test]
    fn generic_sql_guard_allows_adapters_and_blocks_bypasses() {
        let c = enabled();
        {
            let _guard = SqlGuard::new(&c).unwrap();
            c.execute(
                "INSERT INTO receipts(id,date,amount) VALUES(1,'2026-09-02',100)",
                [],
            )
            .unwrap();
            c.execute("UPDATE receipts SET amount=99 WHERE id=1", [])
                .unwrap();
            c.execute("INSERT INTO expenses(id,date,amount,category,payment_method) VALUES(1,'2026-09-02',10,'supplies','Cash')",[]).unwrap();
            assert!(c
                .execute("UPDATE finance_config SET funding_confirmed=1", [])
                .is_err());
            assert!(c
                .execute_batch("DROP TRIGGER finance_receipts_insert")
                .is_err());
            assert!(c.execute_batch("DROP TABLE receipts").is_err());
            assert!(c
                .execute_batch("PRAGMA ignore_check_constraints=ON")
                .is_err());
            assert!(c.execute("DELETE FROM finance_allocations", []).is_err());
            assert!(c
                .execute_batch("CREATE TEMP TABLE FINANCE_config(id INTEGER)")
                .is_err());
            assert!(c.execute_batch("CREATE TEMP TRIGGER finance_receipts_insert AFTER INSERT ON receipts BEGIN UPDATE finance_config SET funding_confirmed=1; END").is_err());
            assert!(c
                .execute_batch("ALTER TABLE receipts RENAME TO old_receipts")
                .is_err());
            assert_eq!(
                c.query_row(
                    "SELECT SUM(cents) FROM finance_movements WHERE account='parent_fees'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                -9900
            );
        }
        call(
            &c,
            "confirm_classification",
            json!({"reason":"Reviewed journal classification"}),
        )
        .unwrap();
    }
    #[test]
    fn grouped_and_partial_deposits_do_not_duplicate_revenue() {
        let c = enabled();
        c.execute_batch(
            "INSERT INTO receipts(id,date,amount) VALUES(1,'2026-09-02',100),(2,'2026-09-02',50);",
        )
        .unwrap();
        call(
            &c,
            "stage",
            statement(
                "bank",
                "2026-09-01",
                "2026-09-30",
                0,
                15000,
                json!([
          {"date":"2026-09-03","description":"group deposit","cents":12000},
          {"date":"2026-09-04","description":"remaining payment","cents":3000}]),
            ),
        )
        .unwrap();
        for (line, source, cents) in [(1, "1", 10000), (1, "2", 2000), (2, "2", 3000)] {
            call(
                &c,
                "allocate",
                json!({"line_id":line,"kind":"receipt","source_id":source,"cents":cents}),
            )
            .unwrap();
        }
        call(&c, "reconcile", json!({"statement_id":1})).unwrap();
        let r = call(&c, "report", json!({"from":"2026-09-01","to":"2026-09-30"})).unwrap();
        assert_eq!(r["months"][0]["income_cents"], 15000);
        assert_eq!(r["cash_flow"][0]["inflow_cents"], 15000);
        assert_eq!(
            c.query_row(
                "SELECT SUM(cents) FROM finance_movements WHERE account='receipts_pending'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }
    #[test]
    fn refund_void_and_invalid_source_identity_are_guarded() {
        let c = enabled();
        c.execute_batch(
            "INSERT INTO receipts(id,date,amount) VALUES(1,'2026-09-02',100);
          INSERT INTO receipts(id,date,amount,is_refund) VALUES(2,'2026-09-03',25,1);
          UPDATE receipts SET voided=1 WHERE id=1;",
        )
        .unwrap();
        assert_eq!(
            c.query_row(
                "SELECT SUM(cents) FROM finance_movements WHERE account='parent_fees'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2500
        );
        assert!(c
            .execute("UPDATE receipts SET id=99 WHERE id=2", [])
            .is_err());
        assert!(c
            .execute("UPDATE receipts SET date='2026-09-31' WHERE id=2", [])
            .is_err());
        assert!(c
            .execute("UPDATE receipts SET amount=-25 WHERE id=2", [])
            .is_err());
        assert!(c.execute("DELETE FROM receipts WHERE id=1", []).is_err());
    }
    #[test]
    fn transfer_counterpart_must_unmatch_before_generated_entry() {
        let c = enabled();
        c.execute("INSERT INTO expenses(id,date,amount,category,payment_method) VALUES(1,'2026-09-02',50,'supplies','Visa Credit Card')",[]).unwrap();
        call(
            &c,
            "stage",
            statement(
                "bank",
                "2026-09-01",
                "2026-09-30",
                0,
                -5000,
                json!([
          {"date":"2026-09-03","description":"card repayment","cents":-5000}]),
            ),
        )
        .unwrap();
        call(
            &c,
            "stage",
            statement(
                "card:Visa Credit Card",
                "2026-09-01",
                "2026-09-30",
                0,
                0,
                json!([
          {"date":"2026-09-02","description":"supplies","cents":-5000},
          {"date":"2026-09-03","description":"repayment","cents":5000}]),
            ),
        )
        .unwrap();
        call(&c,"allocate",json!({"line_id":1,"kind":"transfer","account":"card:Visa Credit Card","description":"pay Visa","cents":5000})).unwrap();
        call(
            &c,
            "allocate",
            json!({"line_id":2,"kind":"existing","entry_id":1,"cents":5000}),
        )
        .unwrap();
        call(
            &c,
            "allocate",
            json!({"line_id":3,"kind":"existing","entry_id":2,"cents":5000}),
        )
        .unwrap();
        assert!(call(&c, "unmatch", json!({"allocation_id":1})).is_err());
        call(&c, "unmatch", json!({"allocation_id":3})).unwrap();
        call(&c, "unmatch", json!({"allocation_id":1})).unwrap();
        assert_eq!(
            c.query_row(
                "SELECT COALESCE(SUM(cents),0) FROM finance_movements WHERE account='bank'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            c.query_row(
                "SELECT SUM(cents) FROM finance_movements WHERE account='expense:supplies'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            5000
        );
    }
    #[test]
    fn duplicate_bank_id_rolls_back_but_identical_rows_survive() {
        let c = enabled();
        let duplicated = statement(
            "bank",
            "2026-09-01",
            "2026-09-30",
            0,
            200,
            json!([
          {"date":"2026-09-02","description":"deposit","cents":100,"bank_id":"A"},
          {"date":"2026-09-02","description":"deposit","cents":100,"bank_id":"A"}]),
        );
        assert!(call(&c, "stage", duplicated).is_err());
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM finance_lines", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        call(
            &c,
            "stage",
            statement(
                "bank",
                "2026-09-01",
                "2026-09-30",
                0,
                200,
                json!([
          {"date":"2026-09-02","description":"deposit","cents":100},
          {"date":"2026-09-02","description":"deposit","cents":100}]),
            ),
        )
        .unwrap();
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM finance_lines", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }
    #[test]
    fn missing_middle_statement_blocks_close() {
        let c = enabled();
        call(
            &c,
            "opening",
            json!({"account":"bank","cents":0,"reason":"Verified zero"}),
        )
        .unwrap();
        call(
            &c,
            "confirm_opening",
            json!({"reason":"Reviewed all opening positions"}),
        )
        .unwrap();
        for program in ["CCFRI", "ACCB", "MCCB"] {
            call(&c,"funding_policy",json!({"program":program,"treatment":"not_applicable","rule":"No funding in synthetic fixture","reason":"Synthetic evidence"})).unwrap();
        }
        call(
            &c,
            "confirm_funding",
            json!({"reason":"No funding; reviewed program policy"}),
        )
        .unwrap();
        for (from, to, id) in [
            ("2026-09-01", "2026-09-30", 1),
            ("2026-11-01", "2026-11-30", 2),
        ] {
            call(&c, "stage", statement("bank", from, to, 0, 0, json!([]))).unwrap();
            call(&c, "reconcile", json!({"statement_id":id})).unwrap();
        }
        let r = call(&c, "report", json!({"from":"2026-09-01","to":"2026-11-30"})).unwrap();
        assert_eq!(r["provisional"], true);
        assert!(call(&c, "close_period", json!({"through":"2026-11-30"})).is_err());
        call(
            &c,
            "stage",
            statement("bank", "2026-10-01", "2026-10-31", 0, 0, json!([])),
        )
        .unwrap();
        call(&c, "reconcile", json!({"statement_id":3})).unwrap();
        call(&c, "close_period", json!({"through":"2026-11-30"})).unwrap();
        assert!(c
            .execute(
                "INSERT INTO receipts(id,date,amount) VALUES(1,'2026-11-02',10)",
                []
            )
            .is_err());
        assert!(call(
            &c,
            "reopen",
            json!({"statement_id":1,"reason":"correction"})
        )
        .is_err());
        call(
            &c,
            "reopen_period",
            json!({"reason":"Correction requested"}),
        )
        .unwrap();
        c.execute(
            "INSERT INTO receipts(id,date,amount) VALUES(1,'2026-11-02',10)",
            [],
        )
        .unwrap();
        assert_eq!(
            c.query_row(
                "SELECT status FROM finance_statements WHERE id=2",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "review"
        );
    }
    #[test]
    fn failed_cutover_does_not_enable_partial_accounting() {
        let c = db();
        c.execute(
            "INSERT INTO receipts(id,date,amount) VALUES(1,'2026-09-02',1.001)",
            [],
        )
        .unwrap();
        assert!(call(
            &c,
            "configure",
            json!({"start_date":"2026-09-01","confirm_preview":true})
        )
        .is_err());
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM finance_config", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM finance_entries", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn initialization_is_repeatable_and_preserves_entries() {
        let c = enabled();
        c.execute(
            "INSERT INTO receipts(id,date,amount) VALUES(1,'2026-09-02',10)",
            [],
        )
        .unwrap();
        init(&c).unwrap();
        init(&c).unwrap();
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM finance_entries", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn opening_correction_is_reversed_not_counted_as_cash_flow() {
        let c = enabled();
        call(
            &c,
            "opening",
            json!({"account":"bank","cents":10000,"reason":"First reviewed balance"}),
        )
        .unwrap();
        call(
            &c,
            "opening",
            json!({"account":"bank","cents":5000,"reason":"Corrected evidence"}),
        )
        .unwrap();
        call(
            &c,
            "stage",
            statement("bank", "2026-09-01", "2026-09-30", 5000, 5000, json!([])),
        )
        .unwrap();
        call(&c, "reconcile", json!({"statement_id":1})).unwrap();
        let r = call(&c, "report", json!({"from":"2026-09-01","to":"2026-09-30"})).unwrap();
        assert_eq!(r["cash_flow"][0]["inflow_cents"], 0);
        assert_eq!(r["cash_flow"][0]["outflow_cents"], 0);
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM finance_entries", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            3
        );
        assert_eq!(
            c.query_row(
                "SELECT SUM(cents) FROM finance_movements WHERE account='bank'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            5000
        );
    }
    #[test]
    fn offsetting_unmatched_payments_are_still_provisional() {
        let c = enabled();
        c.execute_batch(
            "INSERT INTO receipts(id,date,amount) VALUES(1,'2026-09-02',100);
          INSERT INTO receipts(id,date,amount,is_refund) VALUES(2,'2026-09-03',100,1);",
        )
        .unwrap();
        let r = call(&c, "report", json!({"from":"2026-09-01","to":"2026-09-30"})).unwrap();
        assert!(r["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v.as_str().unwrap().contains("Individual source")));
        assert!(c
            .execute("UPDATE receipts SET amount=NULL WHERE id=1", [])
            .is_err());
        assert!(c
            .execute("UPDATE receipts SET is_refund=2 WHERE id=1", [])
            .is_err());
    }
    #[test]
    fn funding_requires_program_evidence_and_new_policy_revokes_confirmation() {
        let c = enabled();
        assert!(call(&c, "confirm_funding", json!({"reason":"Unknown"})).is_err());
        for program in ["CCFRI", "ACCB", "MCCB"] {
            call(&c,"funding_policy",json!({"program":program,"treatment":"not_applicable","rule":"No funding in fixture","reason":"Synthetic evidence"})).unwrap();
        }
        call(
            &c,
            "confirm_funding",
            json!({"reason":"Reviewed all programs"}),
        )
        .unwrap();
        call(&c,"funding_policy",json!({"program":"CCFRI","treatment":"unresolved","rule":"New remittance requires review","reason":"Synthetic evidence"})).unwrap();
        assert_eq!(
            c.query_row("SELECT funding_confirmed FROM finance_config", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(call(&c, "confirm_funding", json!({"reason":"Incomplete"})).is_err());
    }
    #[test]
    fn posted_import_undo_retains_sources_and_reverses_atomically() {
        let c = enabled();
        c.execute_batch("INSERT INTO expenses(id,date,amount,category,payment_method,import_batch_id,source_txn_hash)
          VALUES(1,'2026-09-02',50,'supplies','Visa Credit Card','batch','hash1'),
                (2,'2026-09-03',20,'food','Visa Credit Card','batch','hash2');").unwrap();
        call(
            &c,
            "stage",
            statement(
                "card:Visa Credit Card",
                "2026-09-01",
                "2026-09-30",
                0,
                -7000,
                json!([{"date":"2026-09-02","description":"supplies","cents":-5000},
              {"date":"2026-09-03","description":"food","cents":-2000}]),
            ),
        )
        .unwrap();
        call(
            &c,
            "allocate",
            json!({"line_id":2,"kind":"existing","entry_id":2,"cents":2000}),
        )
        .unwrap();
        assert!(call(
            &c,
            "undo_import",
            json!({"batch_id":"batch","reason":"Incorrect import"})
        )
        .is_err());
        assert_eq!(
            c.query_row("SELECT SUM(amount) FROM expenses", [], |r| r
                .get::<_, f64>(0))
                .unwrap(),
            70.0
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM finance_expense_voids", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        call(&c, "unmatch", json!({"allocation_id":1})).unwrap();
        let result = call(
            &c,
            "undo_import",
            json!({"batch_id":"batch","reason":"Correct categories before reimport"}),
        )
        .unwrap();
        assert_eq!(result["count"], 2);
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM expenses", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            c.query_row("SELECT SUM(amount) FROM expenses", [], |r| r
                .get::<_, f64>(0))
                .unwrap(),
            0.0
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM finance_expense_voids", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM finance_entries", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            4
        );
        assert!(c
            .execute("UPDATE expenses SET amount=50 WHERE id=1", [])
            .is_err());
        c.execute("INSERT INTO expenses(id,date,amount,category,payment_method,import_batch_id,source_txn_hash)
            VALUES(3,'2026-09-02',50,'equipment','Visa Credit Card','corrected','hash1')",[]).unwrap();
    }
    #[test]
    fn withdrawn_evidence_can_be_replaced_without_reusing_allocations() {
        let c = enabled();
        let mut first = statement(
            "bank",
            "2026-09-01",
            "2026-09-30",
            0,
            100,
            json!([
          {"date":"2026-09-02","description":"deposit","cents":100,"bank_id":"A"}]),
        );
        call(&c, "stage", first.clone()).unwrap();
        call(
            &c,
            "withdraw_statement",
            json!({"statement_id":1,"reason":"Corrected bank description"}),
        )
        .unwrap();
        assert!(call(&c, "reconcile", json!({"statement_id":1})).is_err());
        assert!(call(&c,"allocate",json!({"line_id":1,"kind":"new","account":"parent_fees","description":"test","cents":100})).is_err());
        use base64::Engine;
        use sha2::{Digest, Sha256};
        first["source_b64"] = json!(base64::engine::general_purpose::STANDARD.encode(b"corrected"));
        first["source_hash"] = json!(Sha256::digest(b"corrected")
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>());
        call(&c, "stage", first).unwrap();
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM finance_statements", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }
    #[test]
    fn statement_expense_and_refund_use_operational_sources_once() {
        let c = enabled();
        c.execute(
            "INSERT INTO finance_accounts VALUES('expense:food','Food','expense')",
            [],
        )
        .unwrap();
        call(
            &c,
            "stage",
            statement(
                "bank",
                "2026-09-01",
                "2026-09-30",
                0,
                -4000,
                json!([
          {"date":"2026-09-02","description":"Groceries","cents":-5000},
          {"date":"2026-09-03","description":"Refund","cents":1000}]),
            ),
        )
        .unwrap();
        for (line, cents) in [(1, 5000), (2, 1000)] {
            call(&c,"allocate",json!({"line_id":line,"kind":"new","account":"expense:food","description":"Groceries","cents":cents})).unwrap();
        }
        assert_eq!(
            c.query_row("SELECT SUM(amount) FROM expenses", [], |r| r
                .get::<_, f64>(0))
                .unwrap(),
            40.0
        );
        let r = call(&c, "report", json!({"from":"2026-09-01","to":"2026-09-30"})).unwrap();
        assert_eq!(r["months"][0]["expense_cents"], 4000);
        validate_restore(&c).unwrap();
        assert!(c
            .execute("UPDATE expenses SET amount=60 WHERE id=1", [])
            .is_err());
        call(&c, "unmatch", json!({"allocation_id":1})).unwrap();
        assert_eq!(
            c.query_row("SELECT amount FROM expenses WHERE id=1", [], |r| r
                .get::<_, f64>(0))
                .unwrap(),
            50.0
        );
        call(
            &c,
            "void_expense",
            json!({"id":1,"reason":"Duplicate purchase corrected"}),
        )
        .unwrap();
        assert!(c
            .execute("UPDATE expenses SET amount=60 WHERE id=1", [])
            .is_err());
        validate_restore(&c).unwrap();
    }
    #[test]
    fn new_card_expense_matches_without_double_posting() {
        let c = enabled();
        c.execute(
            "INSERT INTO finance_accounts VALUES('custom','Custom expense','expense')",
            [],
        )
        .unwrap();
        call(
            &c,
            "stage",
            statement(
                "card:Visa Credit Card",
                "2026-09-01",
                "2026-09-30",
                0,
                -5000,
                json!([{"date":"2026-09-02","description":"Supplies","cents":-5000}]),
            ),
        )
        .unwrap();
        call(&c,"allocate",json!({"line_id":1,"kind":"new","account":"custom","description":"Supplies","cents":5000})).unwrap();
        assert_eq!(
            c.query_row("SELECT SUM(amount) FROM expenses", [], |r| r
                .get::<_, f64>(0))
                .unwrap(),
            50.0
        );
        assert_eq!(
            c.query_row(
                "SELECT SUM(cents) FROM finance_movements WHERE account='custom'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            5000
        );
        assert!(call(
            &c,
            "allocate",
            json!({"line_id":1,"kind":"new","account":"custom","description":"Again","cents":5000})
        )
        .is_err());
        call(&c, "reconcile", json!({"statement_id":1})).unwrap();
    }
    #[test]
    fn batch_picker_and_ranked_suggestions_respect_capacity_and_rollback() {
        let c = enabled();
        c.execute_batch("INSERT INTO deposits VALUES(1,'2026-09-03',0);
          INSERT INTO receipts(id,date,amount,deposit_id) VALUES(1,'2026-09-02',100,1),(2,'2026-09-02',50,1),(3,'2026-09-01',120,NULL);").unwrap();
        call(
            &c,
            "stage",
            statement(
                "bank",
                "2026-09-01",
                "2026-09-30",
                0,
                12000,
                json!([{"date":"2026-09-03","description":"Deposit","cents":12000}]),
            ),
        )
        .unwrap();
        let candidates = call(&c, "candidates", json!({"kind":"receipt","line_id":1})).unwrap();
        assert_eq!(candidates[0]["source_id"], "3");
        let batches = call(&c, "deposit_batches", json!({})).unwrap();
        assert_eq!(batches[0]["remaining"], 15000);
        assert!(call(
            &c,
            "allocate_batch",
            json!({"batch_id":1,"line_id":1,"cents":13000})
        )
        .is_err());
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM finance_allocations", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        call(
            &c,
            "allocate_batch",
            json!({"batch_id":1,"line_id":1,"cents":12000}),
        )
        .unwrap();
        assert_eq!(
            call(&c, "deposit_batches", json!({})).unwrap()[0]["remaining"],
            3000
        );
        validate_restore(&c).unwrap();
    }
    #[test]
    fn restricted_funding_requires_policy_and_tracks_release_refund_history() {
        let c = enabled();
        call(
            &c,
            "stage",
            statement(
                "bank",
                "2026-09-01",
                "2026-09-30",
                0,
                8000,
                json!([
          {"date":"2026-09-02","description":"Remittance","cents":10000},
          {"date":"2026-09-20","description":"Repayment","cents":-2000}]),
            ),
        )
        .unwrap();
        let funding = json!({"line_id":1,"kind":"funding","program":"CCFRI","period_from":"2026-09-01","period_to":"2026-09-30",
          "reference":"SYNTHETIC-1","reason":"Synthetic remittance evidence","cents":10000});
        assert!(call(&c, "allocate", funding.clone()).is_err());
        call(&c,"funding_policy",json!({"program":"CCFRI","treatment":"liability_until_release","rule":"Release on approved conditions","reason":"Synthetic policy"})).unwrap();
        call(&c, "allocate", funding).unwrap();
        let release = json!({"receipt_id":1,"date":"2026-09-10","cents":6000,"reason":"Synthetic conditions met"});
        call(&c, "funding_release", release.clone()).unwrap();
        assert!(call(&c, "funding_release", release).is_err());
        assert!(call(&c, "unmatch", json!({"allocation_id":1})).is_err());
        call(&c,"allocate",json!({"line_id":2,"kind":"funding_refund","receipt_id":1,"cents":2000,"reason":"Unused funding returned"})).unwrap();
        let r = call(&c, "report", json!({"from":"2026-09-01","to":"2026-09-30"})).unwrap();
        assert_eq!(r["months"][0]["income_cents"], 6000);
        assert_eq!(r["funding"][0]["received_cents"], 10000);
        assert_eq!(r["funding"][0]["released_cents"], 6000);
        assert_eq!(r["funding"][0]["refunded_cents"], 2000);
        assert_eq!(
            c.query_row(
                "SELECT SUM(cents) FROM finance_movements WHERE account='funding_liability:CCFRI'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            -2000
        );
        call(
            &c,
            "reverse",
            json!({"entry_id":2,"date":"2026-10-01","reason":"Release evidence corrected"}),
        )
        .unwrap();
        assert_eq!(
            call(&c, "report", json!({"from":"2026-09-01","to":"2026-09-30"})).unwrap()["funding"]
                [0]["released_cents"],
            6000
        );
        assert_eq!(
            call(&c, "snapshot", json!({})).unwrap()["funding"][0]["released_cents"],
            0
        );
        assert!(call(
            &c,
            "funding_release",
            json!({"receipt_id":1,"date":"2026-09-15","cents":1000,"reason":"Backdated"})
        )
        .is_err());
        validate_restore(&c).unwrap();
    }
    #[test]
    fn cash_funding_refund_and_policy_revision_do_not_duplicate_subsidies() {
        let c = enabled();
        call(&c,"funding_policy",json!({"program":"MCCB","treatment":"cash_income","rule":"Recognize reviewed cash","reason":"Synthetic policy"})).unwrap();
        call(
            &c,
            "stage",
            statement(
                "bank",
                "2026-09-01",
                "2026-09-30",
                0,
                8000,
                json!([
          {"date":"2026-09-02","description":"Funding","cents":10000},
          {"date":"2026-09-20","description":"Refund","cents":-2000}]),
            ),
        )
        .unwrap();
        call(&c,"allocate",json!({"line_id":1,"kind":"funding","program":"MCCB","period_from":"2026-09-01","period_to":"2026-09-30",
          "reference":"M1","reason":"Remittance","cents":10000})).unwrap();
        call(&c,"funding_policy",json!({"program":"MCCB","treatment":"unresolved","rule":"Future remittances need review","reason":"New policy"})).unwrap();
        assert!(call(
            &c,
            "funding_release",
            json!({"receipt_id":1,"date":"2026-09-10","cents":1000,"reason":"Again"})
        )
        .is_err());
        call(&c,"allocate",json!({"line_id":2,"kind":"funding_refund","receipt_id":1,"cents":2000,"reason":"Return excess"})).unwrap();
        let r = call(&c, "report", json!({"from":"2026-09-01","to":"2026-09-30"})).unwrap();
        assert_eq!(r["months"][0]["income_cents"], 8000);
        assert_eq!(r["funding"][0]["treatment"], "cash_income");
    }
    #[test]
    fn exported_reports_are_immutable_and_marked_superseded() {
        let c = enabled();
        c.execute(
            "INSERT INTO receipts(id,date,amount) VALUES(1,'2026-09-02',100)",
            [],
        )
        .unwrap();
        let saved = call(
            &c,
            "export_report",
            json!({"from":"2026-09-01","to":"2026-09-30"}),
        )
        .unwrap();
        assert_eq!(
            call(&c, "saved_report", json!({"id":1})).unwrap()["superseded"],
            false
        );
        c.execute("UPDATE receipts SET amount=90 WHERE id=1", [])
            .unwrap();
        let previous = call(&c, "saved_report", json!({"id":1})).unwrap();
        assert_eq!(previous["superseded"], true);
        assert_eq!(previous["report"], saved["report"]);
        assert_eq!(previous["report"]["months"][0]["income_cents"], 10000);
        assert_eq!(
            call(&c, "report", json!({"from":"2026-09-01","to":"2026-09-30"})).unwrap()["months"]
                [0]["income_cents"],
            9000
        );
        validate_restore(&c).unwrap();
        c.execute("UPDATE finance_report_exports SET payload='not JSON'", [])
            .unwrap();
        assert!(validate_restore(&c).is_err());
    }
    #[test]
    fn cleanup_and_forced_delete_cannot_partially_erase_accounting() {
        let c = enabled();
        c.execute_batch("CREATE TABLE students(id INTEGER PRIMARY KEY);
          INSERT INTO students VALUES(1);
          INSERT INTO receipts(id,date,amount) VALUES(1,'2026-09-02',100);
          INSERT INTO expenses(id,date,amount,category,payment_method) VALUES(1,'2026-09-02',50,'food','Other');").unwrap();
        c.execute_batch("BEGIN IMMEDIATE; DELETE FROM students;")
            .unwrap();
        assert!(c.execute("DELETE FROM receipts", []).is_err());
        c.execute_batch("ROLLBACK;").unwrap();
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM students", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(c.execute("DELETE FROM expenses", []).is_err());
        validate_restore(&c).unwrap();
        c.execute_batch("DROP TRIGGER finance_receipts_update;")
            .unwrap();
        c.execute("UPDATE receipts SET amount=99 WHERE id=1", [])
            .unwrap();
        assert!(validate_restore(&c).is_err());
    }
    #[test]
    fn outstanding_approvals_are_as_of_specific_and_follow_future_clearance() {
        let c = enabled();
        c.execute(
            "INSERT INTO receipts(id,date,amount) VALUES(1,'2026-09-30',100)",
            [],
        )
        .unwrap();
        call(
            &c,
            "stage",
            statement("bank", "2026-09-01", "2026-09-30", 0, 0, json!([])),
        )
        .unwrap();
        call(
            &c,
            "stage",
            statement(
                "bank",
                "2026-10-01",
                "2026-10-31",
                0,
                10000,
                json!([
          {"date":"2026-10-02","description":"Deposit in transit cleared","cents":10000}]),
            ),
        )
        .unwrap();
        call(
            &c,
            "allocate",
            json!({"line_id":1,"kind":"receipt","source_id":"1","cents":10000}),
        )
        .unwrap();
        let r = call(&c, "report", json!({"from":"2026-09-01","to":"2026-09-30"})).unwrap();
        assert_eq!(r["outstanding"][0]["remaining"], 10000);
        assert_eq!(r["outstanding"][0]["approved"], 0);
        call(&c,"review_outstanding",json!({"entry_id":1,"through":"2026-09-30","cents":10000,"reason":"Cash received Sept 30, deposited Oct 2; synthetic deposit slip"})).unwrap();
        assert_eq!(
            call(&c, "report", json!({"from":"2026-09-01","to":"2026-09-30"})).unwrap()
                ["outstanding"][0]["approved"],
            1
        );
        assert_eq!(
            call(&c, "report", json!({"from":"2026-09-01","to":"2026-10-01"})).unwrap()
                ["outstanding"][0]["approved"],
            0
        );
        assert_eq!(
            call(&c, "report", json!({"from":"2026-09-01","to":"2026-10-31"})).unwrap()
                ["outstanding"],
            json!([])
        );
        assert!(call(&c,"review_outstanding",json!({"entry_id":1,"through":"2026-10-31","cents":10000,"reason":"Invalid stale amount"})).is_err());
    }
    #[test]
    fn upgrades_from_previous_review_schema_keep_journals_and_refresh_guards() {
        let c = enabled();
        c.execute(
            "INSERT INTO receipts(id,date,amount) VALUES(1,'2026-09-02',100)",
            [],
        )
        .unwrap();
        c.execute("UPDATE finance_schema SET version=5", [])
            .unwrap();
        c.execute_batch("DROP TABLE finance_outstanding_reviews; DROP TABLE finance_funding_refunds;
          DROP TABLE finance_funding_releases; DROP TABLE finance_funding_receipts; DROP TABLE finance_report_exports;").unwrap();
        init(&c).unwrap();
        init(&c).unwrap();
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM finance_entries", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        let saved = call(
            &c,
            "export_report",
            json!({"from":"2026-09-01","to":"2026-09-30"}),
        )
        .unwrap();
        assert_eq!(saved["report"]["months"][0]["income_cents"], 10000);
        validate_restore(&c).unwrap();
    }
}
