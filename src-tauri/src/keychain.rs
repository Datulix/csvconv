use anyhow::{Context, Result};

const KEY_API: &str = "api_key";
const KEY_PAID_ACK: &str = "paid_tier_ack";

// ── Desktop (Windows / macOS / Linux) ────────────────────────────────────────

#[cfg(not(target_os = "android"))]
mod desktop {
    use super::*;
    use keyring::Entry;

    const SERVICE: &str = "csvconv";

    fn entry(name: &str) -> Result<Entry> {
        Entry::new(SERVICE, name).context("failed to create keyring entry")
    }

    pub fn set(key: &str, value: &str) -> Result<()> {
        entry(key)?.set_password(value).context("failed to store secret")
    }

    pub fn get(key: &str) -> Result<Option<String>> {
        match entry(key)?.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e).context("failed to read secret"),
        }
    }

    pub fn delete(key: &str) -> Result<()> {
        match entry(key)?.delete_credential() {
            Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e).context("failed to delete secret"),
        }
    }
}

// ── Android — file-based storage in app data dir ──────────────────────────────

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use std::path::PathBuf;
    use std::sync::OnceLock;

    static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

    pub fn set_data_dir(path: PathBuf) {
        let _ = DATA_DIR.set(path);
    }

    fn secrets_path() -> Result<PathBuf> {
        DATA_DIR
            .get()
            .ok_or_else(|| anyhow::anyhow!("keychain data dir not initialised"))
            .map(|d| d.join("secrets.json"))
    }

    fn read_all() -> serde_json::Map<String, serde_json::Value> {
        let Ok(path) = secrets_path() else {
            return Default::default();
        };
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn write_all(map: &serde_json::Map<String, serde_json::Value>) -> Result<()> {
        let path = secrets_path()?;
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p)?;
        }
        std::fs::write(&path, serde_json::to_string(map)?)?;
        Ok(())
    }

    pub fn set(key: &str, value: &str) -> Result<()> {
        let mut map = read_all();
        map.insert(key.to_string(), serde_json::Value::String(value.to_string()));
        write_all(&map)
    }

    pub fn get(key: &str) -> Result<Option<String>> {
        Ok(read_all()
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()))
    }

    pub fn delete(key: &str) -> Result<()> {
        let mut map = read_all();
        map.remove(key);
        write_all(&map)
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

#[cfg(target_os = "android")]
pub use android::set_data_dir;

pub fn set_api_key(key: &str) -> Result<()> {
    #[cfg(not(target_os = "android"))]
    return desktop::set(KEY_API, key);
    #[cfg(target_os = "android")]
    return android::set(KEY_API, key);
}

pub fn get_api_key() -> Result<Option<String>> {
    #[cfg(not(target_os = "android"))]
    return desktop::get(KEY_API);
    #[cfg(target_os = "android")]
    return android::get(KEY_API);
}

pub fn delete_api_key() -> Result<()> {
    #[cfg(not(target_os = "android"))]
    return desktop::delete(KEY_API);
    #[cfg(target_os = "android")]
    return android::delete(KEY_API);
}

pub fn set_paid_tier_acknowledged(ack: bool) -> Result<()> {
    let value = if ack { "true" } else { "false" };
    #[cfg(not(target_os = "android"))]
    return desktop::set(KEY_PAID_ACK, value);
    #[cfg(target_os = "android")]
    return android::set(KEY_PAID_ACK, value);
}

pub fn get_paid_tier_acknowledged() -> Result<bool> {
    #[cfg(not(target_os = "android"))]
    let val = desktop::get(KEY_PAID_ACK)?;
    #[cfg(target_os = "android")]
    let val = android::get(KEY_PAID_ACK)?;
    Ok(val.as_deref() == Some("true"))
}
