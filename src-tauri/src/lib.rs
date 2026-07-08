use tauri::Manager;

mod email;
mod errlog;
mod azure_ai;
mod ask_echelon;
mod consensus;
mod inbox;
mod preprocess;
mod restore;
mod waitlist;
mod documents;
mod path_guard;
mod secrets;
mod backup_crypto;
mod migration_heal;
mod azure_url_guard;
mod voice;
mod security;
mod device_secret;
mod db_migration;
mod db_gate;
mod auth;
mod printing;

/// Every schema migration we ship, in version order. Version numbers
/// are stable across v1.x → v2.0.0 so entries backfilled from the
/// legacy tauri-plugin-sql `_sqlx_migrations` tracker line up with
/// our new `_migrations` table 1:1 (no re-execution on upgrade).
fn embedded_migrations() -> Vec<(i64, &'static str, &'static str)> {
    vec![
        (1, "create_initial_tables", include_str!("../migrations/001_initial.sql")),
        (2, "add_pdf_folder_setting", include_str!("../migrations/002_pdf_folder.sql")),
        (3, "add_email_settings_and_audit", include_str!("../migrations/003_email.sql")),
        (4, "add_person_id_refunds_and_annual_receipts", include_str!("../migrations/004_annual_receipts.sql")),
        (5, "add_subsidies_ccfri_accb", include_str!("../migrations/005_subsidies.sql")),
        (6, "add_void_audit_columns", include_str!("../migrations/006_void_audit.sql")),
        (7, "add_issuer_snapshot", include_str!("../migrations/007_issuer_snapshot.sql")),
        (8, "add_staff_hours", include_str!("../migrations/008_staff.sql")),
        (9, "add_staff_credentials_drills", include_str!("../migrations/009_staff_credentials.sql")),
        (10, "add_child_attendance", include_str!("../migrations/010_child_attendance.sql")),
        (11, "add_no_lunch_flag", include_str!("../migrations/011_no_lunch.sql")),
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .manage(db_gate::DbGate::new())
        .manage(auth::AuthState::new())
        .setup(|app| {
            // Install panic hook + error log file before anything else can crash.
            errlog::init(&app.handle());
            // Apply any pending DB restore BEFORE we open the DB.
            if let Err(e) = restore::apply_pending_restore(&app.handle()) {
                eprintln!("[restore] {e}");
            }
            // Open the DB (still plaintext until the v2 setup wizard
            // encrypts it) and apply schema migrations. Migrations
            // backfill from the legacy _sqlx_migrations table so
            // upgraders from v1.8.1 don't re-execute anything.
            let gate = app.state::<db_gate::DbGate>().inner().clone();
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir).ok();
            let db_path = dir.join("echelon.db");
            let env_path = dir.join("security.json");
            let migrations = embedded_migrations();
            tauri::async_runtime::block_on(async move {
                // Step 1: recover from any mid-migration crash BEFORE
                // we decide plaintext vs encrypted branch. This can
                // forward-complete an envelope that got stuck at
                // Encrypting while the DB was already renamed to
                // encrypted (the tightest crash window).
                if let Ok(mut env) = security::load_envelope(&env_path) {
                    let paths = db_migration::Paths {
                        plaintext: db_path.clone(),
                        envelope: env_path.clone(),
                    };
                    if let Err(e) = db_migration::recover_on_startup(&paths, &mut env) {
                        eprintln!("[db_migration] recover_on_startup failed: {e}");
                        // Do not touch the DB — leave AppGate to show
                        // an error screen based on v2_state.
                        return;
                    }
                }

                // Step 2: read the recovered envelope and decide branch.
                //   - envelope exists AND state = Encrypted → leave gate closed, AppGate prompts.
                //   - envelope exists but load fails         → leave gate closed, AppGate fails-closed.
                //   - envelope missing OR state != Encrypted → plaintext startup (v1.x compat / pre-migration).
                match security::load_envelope(&env_path) {
                    Ok(env) if env.migration_state == security::MigrationState::Encrypted => {
                        return;
                    }
                    Err(e) if !matches!(e, security::SecurityError::Io(ref io)
                        if io.kind() == std::io::ErrorKind::NotFound) =>
                    {
                        eprintln!("[security] envelope load failed: {e}");
                        return; // AppGate will render fail-closed error screen.
                    }
                    _ => {}
                }

                if let Err(e) = gate.open_plaintext(&db_path).await {
                    eprintln!("[db_gate] open_plaintext failed: {e}");
                }
                if let Err(e) = gate.run_migrations(&migrations).await {
                    eprintln!("[db_gate] run_migrations failed: {e}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db_gate::db_query,
            db_gate::db_execute,
            db_gate::db_is_open,
            db_gate::db_close,
            auth::v2_state,
            auth::v2_create_pin,
            auth::v2_unlock,
            auth::v2_lock,
            auth::v2_change_pin,
            auth::v2_reset_pin,
            auth::v2_generate_recovery,
            auth::v2_unlock_with_recovery,
            email::send_email,
            email::keychain_set,
            email::keychain_get,
            email::keychain_delete,
            restore::stage_restore,
            restore::restart_app,
            azure_ai::extract_attendance,
            azure_ai::extract_month_attendance,
            azure_ai::extract_visa_statement,
            ask_echelon::ask_echelon,
            consensus::extract_timesheet_consensus,
            inbox::inbox_list_recent,
            preprocess::normalize_sheet,
            errlog::append_error_log,
            errlog::read_error_log,
            errlog::error_log_path,
            errlog::clear_error_log,
            waitlist::waitlist_test_connection,
            waitlist::waitlist_save_credentials,
            waitlist::waitlist_clear_credentials,
            waitlist::waitlist_get_status,
            waitlist::waitlist_fetch_rows,
            documents::documents_export_zip,
            backup_crypto::backup_set_passphrase,
            backup_crypto::backup_clear_passphrase,
            backup_crypto::backup_verify_passphrase,
            backup_crypto::encrypt_backup,
            backup_crypto::decrypt_backup,
            voice::transcribe_audio,
            voice::parse_organizer_event,
            voice::parse_staff_shifts,
            voice::parse_expense,
            voice::parse_recurring_expense,
            voice::parse_meeting_notes,
            printing::print_current_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
