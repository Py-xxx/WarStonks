mod commands;
mod item_catalog;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::get_app_shell_info,
            commands::get_app_version,
            commands::initialize_app_catalog,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
