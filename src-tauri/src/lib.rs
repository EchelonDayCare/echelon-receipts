use tauri_plugin_sql::{Migration, MigrationKind};

mod email;

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
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
