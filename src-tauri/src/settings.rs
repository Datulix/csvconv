use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AppSettings {
    pub primary_model: Option<String>,
    pub detector_model: Option<String>,
    pub analyzer_model: Option<String>,
    pub extractor_model: Option<String>,
    pub validator_model: Option<String>,
    pub solver_model: Option<String>,
    pub dpi: u32,
    pub pages_per_batch: u32,
    pub parallel_batches: u32,
    pub confidence_threshold: f32,
    pub validator_enabled: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            primary_model: None,
            detector_model: None,
            analyzer_model: None,
            extractor_model: None,
            validator_model: None,
            solver_model: None,
            dpi: 300,
            pages_per_batch: 10,
            parallel_batches: 3,
            confidence_threshold: 0.75,
            validator_enabled: true,
        }
    }
}

fn settings_path(app_data: &Path) -> PathBuf {
    app_data.join("settings.json")
}

pub fn load(app_data: &Path) -> Result<AppSettings> {
    let path = settings_path(app_data);
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let content = fs::read_to_string(&path)
        .with_context(|| format!("failed to read {}", path.display()))?;
    serde_json::from_str(&content)
        .with_context(|| format!("failed to parse {}", path.display()))
}

pub fn save(app_data: &Path, settings: &AppSettings) -> Result<()> {
    fs::create_dir_all(app_data)
        .with_context(|| format!("failed to create app data dir: {}", app_data.display()))?;
    let path = settings_path(app_data);
    let json = serde_json::to_string_pretty(settings).context("failed to serialize settings")?;
    fs::write(&path, json).with_context(|| format!("failed to write {}", path.display()))?;
    Ok(())
}
