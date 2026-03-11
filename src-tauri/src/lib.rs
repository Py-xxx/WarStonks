mod commands;
mod item_catalog;
mod settings;
mod worldstate_cache;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::get_app_shell_info,
            commands::get_app_version,
            commands::initialize_app_catalog,
            commands::get_wfm_autocomplete_items,
            commands::get_relic_tier_icons,
            commands::get_wfm_top_sell_orders,
            commands::get_worldstate_events,
            commands::get_worldstate_alerts,
            commands::get_worldstate_sortie,
            commands::get_worldstate_arbitration,
            commands::get_worldstate_archon_hunt,
            commands::get_worldstate_fissures,
            commands::get_worldstate_market_news,
            commands::get_worldstate_invasions,
            commands::get_worldstate_syndicate_missions,
            commands::get_worldstate_void_trader,
            worldstate_cache::get_worldstate_cache,
            worldstate_cache::save_worldstate_cache_entry,
            settings::get_app_settings,
            settings::test_alecaframe_public_link,
            settings::save_alecaframe_settings,
            settings::get_currency_balances,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
