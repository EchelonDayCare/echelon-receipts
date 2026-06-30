use tauri_plugin_sql::{Migration, MigrationKind};

mod email;
mod gemini;
mod restore;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "create_initial_tables",
            sql: include_str!("../migrations/001_initial.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "add_pdf_folder_setting",
            sql: include_str!("../migrations/002_pdf_folder.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "add_email_settings_and_audit",
            sql: include_str!("../migrations/003_email.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "add_person_id_refunds_and_annual_receipts",
            sql: include_str!("../migrations/004_annual_receipts.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "add_subsidies_ccfri_accb",
            sql: include_str!("../migrations/005_subsidies.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "add_void_audit_columns",
            sql: include_str!("../migrations/006_void_audit.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "add_issuer_snapshot",
            sql: include_str!("../migrations/007_issuer_snapshot.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "add_staff_hours",
            sql: include_str!("../migrations/008_staff.sql"),
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Apply any pending DB restore BEFORE the SQL plugin opens a connection.
            // The frontend invokes Database.load(...) lazily, so this runs first.
            if let Err(e) = restore::apply_pending_restore(&app.handle()) {
                eprintln!("[restore] {e}");
            }
            Ok(())
        })
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:echelon.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            email::send_email,
            email::keychain_set,
            email::keychain_get,
            email::keychain_delete,
            restore::stage_restore,
            restore::restart_app,
            gemini::extract_timesheet,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
