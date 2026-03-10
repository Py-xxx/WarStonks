mod commands;
mod item_catalog;
mod settings;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::get_app_shell_info,
            commands::get_app_version,
            commands::initialize_app_catalog,
            commands::get_wfm_autocomplete_items,
            commands::get_wfm_top_sell_orders,
            commands::get_worldstate_events,
            settings::get_app_settings,
            settings::test_alecaframe_public_link,
            settings::save_alecaframe_settings,
            settings::get_currency_balances,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
