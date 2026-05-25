use crate::cache::{BatchRecord, Cache, RowRecord, RunRecord};
use crate::keychain;
use crate::pdf::{self, RasterizeResult};
use crate::schema_store::{self, SavedSchema};
use crate::settings::{self, AppSettings};
use crate::triage::{self, TriageResult};
use pdfium_render::prelude::*;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

fn make_pdfium() -> Result<Pdfium, String> {
    // Resolve the DLL path relative to the running executable so it works in
    // both dev (target/debug/) and production (installer dir).
    let lib_path = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("pdfium.dll")))
        .filter(|p| p.exists())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "pdfium.dll".to_string());

    Pdfium::bind_to_library(lib_path)
        .map(Pdfium::new)
        .map_err(|e| format!("failed to load pdfium: {e}"))
}

fn staging_dir_for(app: &AppHandle, run_id: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    Ok(base.join("staging").join(run_id))
}

#[tauri::command]
pub async fn triage_pdf(
    path: String,
    _run_id: String,
    password: Option<String>,
) -> Result<TriageResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let pdfium = make_pdfium()?;
        triage::triage(&pdfium, &path, password.as_deref()).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| format!("thread error: {e}"))?
}

#[tauri::command]
pub async fn rasterize_pdf(
    app: AppHandle,
    path: String,
    dpi: u32,
    run_id: String,
    password: Option<String>,
    deskew_pages: Option<Vec<u32>>,
    skew_angles: Option<Vec<(u32, f32)>>,
    skip_pages: Option<Vec<u32>>,
    only_pages: Option<Vec<u32>>,
) -> Result<RasterizeResult, String> {
    let staging = staging_dir_for(&app, &run_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let pdfium = make_pdfium()?;
        pdf::rasterize(
            &pdfium,
            &path,
            dpi,
            &staging,
            password.as_deref(),
            &deskew_pages.unwrap_or_default(),
            &skew_angles.unwrap_or_default(),
            &skip_pages.unwrap_or_default(),
            only_pages.as_deref(),
        )
        .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| format!("thread error: {e}"))?
}

#[tauri::command]
pub fn read_image_as_base64(path: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = std::fs::read(&path).map_err(|e| format!("failed to read {path}: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
pub fn hash_pdf(path: String) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(&path).map_err(|e| format!("failed to read {path}: {e}"))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    std::fs::write(&path, content).map_err(|e| format!("write {path}: {e}"))
}

#[tauri::command]
pub fn cleanup_old_staging(app: AppHandle, max_age_days: u64) -> Result<usize, String> {
    let dir = app_data_dir(&app)?.join("staging");
    if !dir.exists() {
        return Ok(0);
    }
    let mut removed = 0;
    let now = std::time::SystemTime::now();
    let max_age = std::time::Duration::from_secs(max_age_days * 86400);
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let age_ok = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| now.duration_since(t).ok())
                .map(|d| d > max_age)
                .unwrap_or(false);
            if age_ok {
                if std::fs::remove_dir_all(&path).is_ok() {
                    removed += 1;
                }
            }
        }
    }
    Ok(removed)
}

#[tauri::command]
pub fn cleanup_staging(app: AppHandle, run_id: String) -> Result<(), String> {
    let staging = staging_dir_for(&app, &run_id)?;
    pdf::cleanup_staging(&staging).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn keychain_set_api_key(key: String) -> Result<(), String> {
    keychain::set_api_key(&key).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn keychain_get_api_key() -> Result<Option<String>, String> {
    keychain::get_api_key().map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn keychain_delete_api_key() -> Result<(), String> {
    keychain::delete_api_key().map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn keychain_set_paid_tier_ack(ack: bool) -> Result<(), String> {
    keychain::set_paid_tier_acknowledged(ack).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn keychain_get_paid_tier_ack() -> Result<bool, String> {
    keychain::get_paid_tier_acknowledged().map_err(|e| format!("{e:#}"))
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))
}

#[tauri::command]
pub fn load_settings(app: AppHandle) -> Result<AppSettings, String> {
    let dir = app_data_dir(&app)?;
    settings::load(&dir).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings_in: AppSettings) -> Result<(), String> {
    let dir = app_data_dir(&app)?;
    settings::save(&dir, &settings_in).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn save_schema(
    app: AppHandle,
    name: String,
    content: serde_json::Value,
) -> Result<String, String> {
    let dir = app_data_dir(&app)?;
    schema_store::save(&dir, &name, &content).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn load_schemas(app: AppHandle) -> Result<Vec<SavedSchema>, String> {
    let dir = app_data_dir(&app)?;
    schema_store::load_all(&dir).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn delete_schema(app: AppHandle, name: String) -> Result<(), String> {
    let dir = app_data_dir(&app)?;
    schema_store::delete(&dir, &name).map_err(|e| format!("{e:#}"))
}

pub struct CacheState(pub Mutex<Option<Cache>>);

fn ensure_cache_open(app: &AppHandle, state: &State<'_, CacheState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "cache mutex poisoned".to_string())?;
    if guard.is_none() {
        let dir = app_data_dir(app)?;
        let c = Cache::open(&dir).map_err(|e| format!("{e:#}"))?;
        *guard = Some(c);
    }
    Ok(())
}

fn with_cache<R>(
    app: &AppHandle,
    state: &State<'_, CacheState>,
    f: impl FnOnce(&Cache) -> Result<R, String>,
) -> Result<R, String> {
    ensure_cache_open(app, state)?;
    let guard = state.0.lock().map_err(|_| "cache mutex poisoned".to_string())?;
    let cache = guard
        .as_ref()
        .ok_or_else(|| "cache not initialized".to_string())?;
    f(cache)
}

#[tauri::command]
pub fn cache_get_completed_batches(
    app: AppHandle,
    state: State<'_, CacheState>,
    cache_key: String,
    stage: String,
) -> Result<Vec<BatchRecord>, String> {
    with_cache(&app, &state, |c| {
        c.get_completed_batches(&cache_key, &stage)
            .map_err(|e| format!("{e:#}"))
    })
}

#[tauri::command]
pub fn cache_save_batch(
    app: AppHandle,
    state: State<'_, CacheState>,
    cache_key: String,
    stage: String,
    batch_index: i64,
    raw_response: String,
) -> Result<(), String> {
    with_cache(&app, &state, |c| {
        c.save_batch(&cache_key, &stage, batch_index, &raw_response)
            .map_err(|e| format!("{e:#}"))
    })
}

#[tauri::command]
pub fn cache_save_batch_failure(
    app: AppHandle,
    state: State<'_, CacheState>,
    cache_key: String,
    stage: String,
    batch_index: i64,
    error: String,
) -> Result<(), String> {
    with_cache(&app, &state, |c| {
        c.save_batch_failure(&cache_key, &stage, batch_index, &error)
            .map_err(|e| format!("{e:#}"))
    })
}

#[tauri::command]
pub fn cache_purge_run(
    app: AppHandle,
    state: State<'_, CacheState>,
    cache_key: String,
) -> Result<(), String> {
    with_cache(&app, &state, |c| {
        c.purge_run(&cache_key).map_err(|e| format!("{e:#}"))
    })
}

#[tauri::command]
pub fn cache_purge_all(
    app: AppHandle,
    state: State<'_, CacheState>,
) -> Result<(), String> {
    with_cache(&app, &state, |c| c.purge_all().map_err(|e| format!("{e:#}")))
}

#[tauri::command]
pub fn cache_save_row(
    app: AppHandle,
    state: State<'_, CacheState>,
    row: RowRecord,
) -> Result<(), String> {
    with_cache(&app, &state, |c| c.save_row(&row).map_err(|e| format!("{e:#}")))
}

#[tauri::command]
pub fn cache_save_rows(
    app: AppHandle,
    state: State<'_, CacheState>,
    rows: Vec<RowRecord>,
) -> Result<(), String> {
    with_cache(&app, &state, |c| c.save_rows(&rows).map_err(|e| format!("{e:#}")))
}

#[tauri::command]
pub fn cache_load_rows(
    app: AppHandle,
    state: State<'_, CacheState>,
    cache_key: String,
) -> Result<Vec<RowRecord>, String> {
    with_cache(&app, &state, |c| {
        c.load_rows(&cache_key).map_err(|e| format!("{e:#}"))
    })
}

#[tauri::command]
pub fn cache_upsert_run(
    app: AppHandle,
    state: State<'_, CacheState>,
    record: RunRecord,
) -> Result<(), String> {
    with_cache(&app, &state, |c| {
        c.upsert_run(&record).map_err(|e| format!("{e:#}"))
    })
}

#[tauri::command]
pub fn cache_list_runs(
    app: AppHandle,
    state: State<'_, CacheState>,
) -> Result<Vec<RunRecord>, String> {
    with_cache(&app, &state, |c| c.list_runs().map_err(|e| format!("{e:#}")))
}

#[tauri::command]
pub fn cache_save_trace(
    app: AppHandle,
    state: State<'_, CacheState>,
    run_id: String,
    trace_json: String,
) -> Result<(), String> {
    with_cache(&app, &state, |c| {
        c.save_trace(&run_id, &trace_json).map_err(|e| format!("{e:#}"))
    })
}

#[tauri::command]
pub fn cache_load_all_traces(
    app: AppHandle,
    state: State<'_, CacheState>,
) -> Result<Vec<String>, String> {
    with_cache(&app, &state, |c| c.load_all_traces().map_err(|e| format!("{e:#}")))
}
