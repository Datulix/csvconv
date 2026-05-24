use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SavedSchema {
    pub name: String,
    pub content: serde_json::Value,
}

fn schemas_dir(app_data: &Path) -> PathBuf {
    app_data.join("schemas")
}

fn sanitize_name(name: &str) -> String {
    let trimmed = name.trim();
    let s: String = trimmed
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else if c.is_whitespace() {
                '_'
            } else {
                '_'
            }
        })
        .collect();
    let s = s.trim_matches('_').to_string();
    if s.is_empty() {
        "untitled".to_string()
    } else {
        s
    }
}

pub fn save(app_data: &Path, name: &str, content: &serde_json::Value) -> Result<String> {
    let dir = schemas_dir(app_data);
    fs::create_dir_all(&dir)
        .with_context(|| format!("failed to create schemas dir: {}", dir.display()))?;
    let sanitized = sanitize_name(name);
    let path = dir.join(format!("{sanitized}.json"));
    let json = serde_json::to_string_pretty(content).context("failed to serialize schema")?;
    fs::write(&path, json).with_context(|| format!("failed to write {}", path.display()))?;
    Ok(sanitized)
}

pub fn load_all(app_data: &Path) -> Result<Vec<SavedSchema>> {
    let dir = schemas_dir(app_data);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out: Vec<SavedSchema> = Vec::new();
    for entry in fs::read_dir(&dir)
        .with_context(|| format!("failed to read schemas dir: {}", dir.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("untitled")
            .to_string();
        let content_str = fs::read_to_string(&path)
            .with_context(|| format!("failed to read {}", path.display()))?;
        let content: serde_json::Value = serde_json::from_str(&content_str)
            .with_context(|| format!("failed to parse {}", path.display()))?;
        out.push(SavedSchema {
            name: stem,
            content,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

pub fn delete(app_data: &Path, name: &str) -> Result<()> {
    let dir = schemas_dir(app_data);
    let sanitized = sanitize_name(name);
    let path = dir.join(format!("{sanitized}.json"));
    if path.exists() {
        fs::remove_file(&path)
            .with_context(|| format!("failed to delete {}", path.display()))?;
    }
    Ok(())
}
