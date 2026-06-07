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
    #[cfg(target_os = "android")]
    {
        // On Android, libpdfium.so is placed in jniLibs and extracted by the
        // system to the app's native library directory, which is on LD_LIBRARY_PATH.
        return Pdfium::bind_to_library("libpdfium.so")
            .map(Pdfium::new)
            .map_err(|e| format!("failed to load pdfium: {e}"));
    }

    #[cfg(not(target_os = "android"))]
    {
        // Look for pdfium.dll in the layouts it can land in: right next to the exe
        // (dev `target/debug`, and production once bundled to the install root), plus
        // the resource subfolders Tauri may place bundled resources in. First hit wins;
        // bare "pdfium.dll" is the last-resort search-path fallback.
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()));
        let mut lib_path = "pdfium.dll".to_string();
        if let Some(dir) = exe_dir {
            let candidates = [
                dir.join("pdfium.dll"),
                dir.join("binaries").join("pdfium.dll"),
                dir.join("resources").join("pdfium.dll"),
                dir.join("resources").join("binaries").join("pdfium.dll"),
            ];
            if let Some(found) = candidates.into_iter().find(|p| p.exists()) {
                lib_path = found.to_string_lossy().into_owned();
            }
        }

        Pdfium::bind_to_library(lib_path)
            .map(Pdfium::new)
            .map_err(|e| format!("failed to load pdfium: {e}"))
    }
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
    let res = with_cache(&app, &state, |c| {
        c.purge_run(&cache_key).map_err(|e| format!("{e:#}"))
    });
    if let Ok(app_data) = app_data_dir(&app) {
        let _ = pdf::cleanup_figures(&app_data, &cache_key);
    }
    res
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

/// Read the original source PDF for a run and return it base64-encoded, so the
/// Review UI can show it in a blob iframe without widening the asset scope.
#[tauri::command]
pub fn read_run_pdf_base64(
    app: AppHandle,
    state: State<'_, CacheState>,
    cache_key: String,
) -> Result<String, String> {
    use base64::Engine;
    let path = with_cache(&app, &state, |c| {
        c.get_pdf_path_for_run(&cache_key).map_err(|e| format!("{e:#}"))
    })?;
    let path = path.ok_or_else(|| "no source PDF recorded for this run".to_string())?;
    let bytes = std::fs::read(&path)
        .map_err(|e| format!("source PDF unavailable ({path}): {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
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

#[tauri::command]
pub async fn crop_figures_batch(
    jobs: Vec<pdf::CropJob>,
) -> Result<Vec<pdf::CropResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let pdfium = make_pdfium()?;
        Ok(pdf::crop_figures_batch(&pdfium, &jobs))
    })
    .await
    .map_err(|e| format!("thread error: {e}"))?
}

#[tauri::command]
pub fn figures_dir(app: AppHandle, cache_key: String) -> Result<String, String> {
    let dir = pdf::figures_dir_for(&app_data_dir(&app)?, &cache_key);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir figures: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn cleanup_figures(app: AppHandle, cache_key: String) -> Result<(), String> {
    pdf::cleanup_figures(&app_data_dir(&app)?, &cache_key).map_err(|e| format!("{e:#}"))
}

/// Copy cropped figure images out to a user-chosen folder, keeping each file's
/// original (hash) name. Returns the basenames actually copied so the UI can
/// report a count. Missing/duplicate sources are skipped rather than failing the
/// whole export.
#[tauri::command]
pub fn export_figures(figure_paths: Vec<String>, dest_dir: String) -> Result<Vec<String>, String> {
    let dest = std::path::Path::new(&dest_dir);
    std::fs::create_dir_all(dest).map_err(|e| format!("mkdir {dest_dir}: {e}"))?;
    let mut copied = Vec::new();
    for src in &figure_paths {
        let src_path = std::path::Path::new(src);
        let Some(name) = src_path.file_name() else {
            continue;
        };
        if !src_path.exists() {
            continue;
        }
        let dest_path = dest.join(name);
        std::fs::copy(src_path, &dest_path).map_err(|e| format!("copy {src}: {e}"))?;
        copied.push(name.to_string_lossy().into_owned());
    }
    Ok(copied)
}

/// Save figure images into the device's **public** Downloads/<subdir>/ folder so
/// the user can see and upload them from the phone's file manager.
///
/// Why this exists instead of the fs plugin: on Android `BaseDirectory.Download`
/// resolves to the app's *private* external dir (`Android/data/<pkg>/files/Download`),
/// which is invisible in the Files app and gallery — so "export images" produced
/// files the user could never find. This writes through MediaStore, which (on API
/// 29+) lets an app add entries to the public Downloads collection with **no storage
/// permission**, because the app owns what it creates. On desktop it just copies into
/// the OS Downloads folder. Returns the number of files written.
///
/// Source paths are the app-private figure crops, readable with std::fs on both
/// platforms; duplicate basenames (hashes are already unique) and missing files are
/// skipped rather than failing the whole export.
#[tauri::command]
pub fn export_figures_to_downloads(
    app: AppHandle,
    figure_paths: Vec<String>,
    subdir: String,
) -> Result<usize, String> {
    let _ = &app;
    let mut seen = std::collections::HashSet::new();

    #[cfg(target_os = "android")]
    {
        let mut written = 0;
        for src in &figure_paths {
            let p = std::path::Path::new(src);
            let Some(name) = p.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if !seen.insert(name.to_string()) {
                continue;
            }
            let Ok(bytes) = std::fs::read(p) else {
                continue;
            };
            android_mediastore::write_to_downloads(&subdir, name, mime_for(name), &bytes)?;
            written += 1;
        }
        Ok(written)
    }

    #[cfg(not(target_os = "android"))]
    {
        let downloads = app
            .path()
            .download_dir()
            .map_err(|e| format!("could not resolve Downloads dir: {e}"))?;
        let dest = downloads.join(&subdir);
        std::fs::create_dir_all(&dest).map_err(|e| format!("mkdir {}: {e}", dest.display()))?;
        let mut written = 0;
        for src in &figure_paths {
            let p = std::path::Path::new(src);
            let Some(name) = p.file_name() else {
                continue;
            };
            if !seen.insert(name.to_owned()) {
                continue;
            }
            if !p.exists() {
                continue;
            }
            std::fs::copy(p, dest.join(name)).map_err(|e| format!("copy {src}: {e}"))?;
            written += 1;
        }
        Ok(written)
    }
}

#[cfg(target_os = "android")]
fn mime_for(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else {
        "application/octet-stream"
    }
}

/// MediaStore writes via raw JNI. Kept in its own module so all the unsafe JNI glue
/// is in one place. We never marshal the image bytes through JNI: instead we ask the
/// ContentResolver for a writable file descriptor, detach it, and write the bytes in
/// Rust — avoiding fragile byte-array conversions across the boundary.
#[cfg(target_os = "android")]
mod android_mediastore {
    use jni::objects::{JObject, JValue};
    use std::io::Write;
    use std::os::fd::{FromRawFd, RawFd};

    pub fn write_to_downloads(
        subdir: &str,
        filename: &str,
        mime: &str,
        bytes: &[u8],
    ) -> Result<(), String> {
        let ctx = ndk_context::android_context();
        let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
            .map_err(|e| format!("jni: get JavaVM: {e}"))?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("jni: attach thread: {e}"))?;
        // SAFETY: ndk_context hands us the Android Context pointer set up by the runtime.
        let context = unsafe { JObject::from_raw(ctx.context().cast()) };

        let fd = match insert_and_open_fd(&mut env, &context, subdir, filename, mime) {
            Ok(fd) => fd,
            Err(e) => {
                // Clear any pending Java exception so the next file's calls aren't poisoned.
                let _ = env.exception_clear();
                return Err(format!("MediaStore write failed for {filename}: {e}"));
            }
        };

        // detachFd transferred ownership of the descriptor to us; File's Drop closes it,
        // which is what makes the MediaStore entry final and visible.
        let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
        file.write_all(bytes)
            .map_err(|e| format!("write {filename} to Downloads: {e}"))?;
        file.flush()
            .map_err(|e| format!("flush {filename}: {e}"))?;
        Ok(())
    }

    fn insert_and_open_fd(
        env: &mut jni::JNIEnv,
        context: &JObject,
        subdir: &str,
        filename: &str,
        mime: &str,
    ) -> Result<RawFd, jni::errors::Error> {
        // ContentResolver resolver = context.getContentResolver();
        let resolver = env
            .call_method(
                context,
                "getContentResolver",
                "()Landroid/content/ContentResolver;",
                &[],
            )?
            .l()?;

        // ContentValues values = new ContentValues(); values.put(...);
        let values = env.new_object("android/content/ContentValues", "()V", &[])?;
        put_string(env, &values, "_display_name", filename)?;
        put_string(env, &values, "mime_type", mime)?;
        put_string(env, &values, "relative_path", &format!("Download/{subdir}"))?;

        // Uri collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI; (API 29+)
        let collection = env
            .get_static_field(
                "android/provider/MediaStore$Downloads",
                "EXTERNAL_CONTENT_URI",
                "Landroid/net/Uri;",
            )?
            .l()?;

        // Uri item = resolver.insert(collection, values);
        let item = env
            .call_method(
                &resolver,
                "insert",
                "(Landroid/net/Uri;Landroid/content/ContentValues;)Landroid/net/Uri;",
                &[JValue::Object(&collection), JValue::Object(&values)],
            )?
            .l()?;
        if item.is_null() {
            return Err(jni::errors::Error::NullPtr("MediaStore.insert returned null"));
        }

        // ParcelFileDescriptor pfd = resolver.openFileDescriptor(item, "w");
        let mode = env.new_string("w")?;
        let mode_obj: &JObject = &mode;
        let pfd = env
            .call_method(
                &resolver,
                "openFileDescriptor",
                "(Landroid/net/Uri;Ljava/lang/String;)Landroid/os/ParcelFileDescriptor;",
                &[JValue::Object(&item), JValue::Object(mode_obj)],
            )?
            .l()?;
        if pfd.is_null() {
            return Err(jni::errors::Error::NullPtr(
                "openFileDescriptor returned null",
            ));
        }

        // int fd = pfd.detachFd();
        let fd = env.call_method(&pfd, "detachFd", "()I", &[])?.i()?;
        Ok(fd as RawFd)
    }

    fn put_string(
        env: &mut jni::JNIEnv,
        values: &JObject,
        key: &str,
        val: &str,
    ) -> Result<(), jni::errors::Error> {
        let k = env.new_string(key)?;
        let v = env.new_string(val)?;
        let k_obj: &JObject = &k;
        let v_obj: &JObject = &v;
        env.call_method(
            values,
            "put",
            "(Ljava/lang/String;Ljava/lang/String;)V",
            &[JValue::Object(k_obj), JValue::Object(v_obj)],
        )?;
        Ok(())
    }
}

/// Copy a source PDF into the app's data dir (keyed by its sha256, so identical
/// documents are stored once) and return the stored path. Lets the Review PDF
/// panel keep working even if the user later moves or deletes the original.
#[tauri::command]
pub fn store_source_pdf(app: AppHandle, pdf_path: String, sha256: String) -> Result<String, String> {
    let dir = app_data_dir(&app)?.join("sources");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir sources: {e}"))?;
    // sha256 is hex, but filter defensively to a safe filename.
    let key: String = sha256.chars().filter(|c| c.is_ascii_alphanumeric()).take(64).collect();
    let key = if key.is_empty() { "source".to_string() } else { key };
    let dest = dir.join(format!("{key}.pdf"));
    if !dest.exists() {
        std::fs::copy(&pdf_path, &dest).map_err(|e| format!("copy source pdf: {e}"))?;
    }
    Ok(dest.to_string_lossy().into_owned())
}
