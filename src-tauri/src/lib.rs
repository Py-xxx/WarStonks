mod commands;
mod item_catalog;
mod market_observatory;
mod settings;
mod trades;
mod worldstate_cache;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::get_app_shell_info,
            commands::get_app_version,
            commands::open_external_url,
            commands::initialize_app_catalog,
            commands::get_wfm_autocomplete_items,
            commands::get_relic_tier_icons,
            commands::get_wfm_top_sell_orders,
            market_observatory::get_wfm_item_orders,
            market_observatory::ensure_market_tracking,
            market_observatory::stop_market_tracking,
            market_observatory::refresh_market_tracking,
            market_observatory::get_item_variants_for_market,
            market_observatory::get_item_detail_summary,
            market_observatory::get_item_analytics,
            market_observatory::get_item_analysis,
            market_observatory::get_arbitrage_scanner,
            market_observatory::get_arbitrage_scanner_state,
            market_observatory::get_set_completion_owned_items,
            market_observatory::set_set_completion_owned_item_quantity,
            market_observatory::get_owned_relic_inventory,
            market_observatory::start_arbitrage_scanner,
            market_observatory::stop_arbitrage_scanner,
            trades::get_wfm_trade_session_state,
            trades::sign_in_wfm_trade_account,
            trades::try_auto_sign_in_wfm_trade_account,
            trades::sign_out_wfm_trade_account,
            trades::set_wfm_trade_status,
            trades::get_wfm_trade_overview,
            trades::get_cached_wfm_profile_trade_log,
            trades::get_wfm_profile_trade_log,
            trades::refresh_wfm_trade_detection,
            trades::refresh_alecaframe_trade_detection,
            trades::get_portfolio_pnl_summary,
            trades::set_wfm_trade_log_keep_item,
            trades::migrate_alecaframe_trade_log,
            trades::update_trade_group_allocations,
            trades::force_wfm_trade_log_resync,
            trades::ensure_trade_set_map,
            trades::create_wfm_sell_order,
            trades::create_wfm_buy_order,
            trades::update_wfm_sell_order,
            trades::update_wfm_buy_order,
            trades::close_wfm_sell_order,
            trades::close_wfm_buy_order,
            trades::delete_wfm_sell_order,
            trades::delete_wfm_buy_order,
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
            settings::save_discord_webhook_settings,
            settings::send_watchlist_found_discord_notification,
            settings::get_currency_balances,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
