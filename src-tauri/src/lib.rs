mod cache;
mod commands;
mod keychain;
mod pdf;
mod schema_store;
mod settings;
mod triage;

use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::CacheState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            commands::triage_pdf,
            commands::rasterize_pdf,
            commands::cleanup_staging,
            commands::read_image_as_base64,
            commands::hash_pdf,
            commands::write_text_file,
            commands::cleanup_old_staging,
            commands::keychain_set_api_key,
            commands::keychain_get_api_key,
            commands::keychain_delete_api_key,
            commands::keychain_set_paid_tier_ack,
            commands::keychain_get_paid_tier_ack,
            commands::load_settings,
            commands::save_settings,
            commands::save_schema,
            commands::load_schemas,
            commands::delete_schema,
            commands::cache_get_completed_batches,
            commands::cache_save_batch,
            commands::cache_save_batch_failure,
            commands::cache_purge_run,
            commands::cache_purge_all,
            commands::cache_save_row,
            commands::cache_save_rows,
            commands::cache_load_rows,
            commands::cache_upsert_run,
            commands::cache_list_runs,
            commands::cache_save_trace,
            commands::cache_load_all_traces,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
