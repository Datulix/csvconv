use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

const MIGRATIONS: &str = r#"
CREATE TABLE IF NOT EXISTS pdfs (
  sha256 TEXT PRIMARY KEY,
  path TEXT,
  page_count INTEGER,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  cache_key TEXT PRIMARY KEY,
  pdf_sha256 TEXT,
  schema_hash TEXT,
  mode TEXT,
  content_type TEXT,
  confirmed_format TEXT,
  settings_json TEXT,
  state TEXT,
  started_at TEXT,
  finished_at TEXT,
  token_usage INTEGER,
  cost REAL
);

CREATE TABLE IF NOT EXISTS batches (
  cache_key TEXT NOT NULL,
  stage TEXT NOT NULL,
  batch_index INTEGER NOT NULL,
  status TEXT NOT NULL,
  raw_response TEXT,
  error TEXT,
  completed_at TEXT,
  PRIMARY KEY (cache_key, stage, batch_index)
);

CREATE TABLE IF NOT EXISTS rows (
  cache_key TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  row_index_within_page INTEGER NOT NULL,
  canonical_json TEXT NOT NULL,
  needs_review INTEGER NOT NULL DEFAULT 0,
  ai_needs_review INTEGER NOT NULL DEFAULT 0,
  user_edited INTEGER NOT NULL DEFAULT 0,
  merged_from_pages TEXT,
  awaiting_answer_key INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (cache_key, page_number, row_index_within_page)
);
"#;

pub struct Cache {
    conn: Mutex<Connection>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BatchRecord {
    pub stage: String,
    pub batch_index: i64,
    pub status: String,
    pub raw_response: Option<String>,
    pub error: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RowRecord {
    pub cache_key: String,
    pub page_number: i64,
    pub row_index_within_page: i64,
    pub canonical_json: serde_json::Value,
    pub needs_review: bool,
    pub ai_needs_review: bool,
    pub user_edited: bool,
    pub merged_from_pages: Option<Vec<i64>>,
    pub awaiting_answer_key: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RunRecord {
    pub cache_key: String,
    pub pdf_sha256: Option<String>,
    pub schema_hash: Option<String>,
    pub mode: Option<String>,
    pub content_type: Option<String>,
    pub confirmed_format: Option<String>,
    pub state: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub token_usage: Option<i64>,
    pub cost: Option<f64>,
}

impl Cache {
    pub fn open(app_data: &Path) -> Result<Self> {
        std::fs::create_dir_all(app_data).ok();
        let db_path = app_data.join("cache.sqlite");
        let conn = Connection::open(&db_path)
            .with_context(|| format!("opening cache db at {}", db_path.display()))?;
        conn.execute_batch(MIGRATIONS)
            .context("running cache migrations")?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn get_completed_batches(
        &self,
        cache_key: &str,
        stage: &str,
    ) -> Result<Vec<BatchRecord>> {
        let conn = self.conn.lock().map_err(|_| anyhow::anyhow!("cache mutex poisoned"))?;
        let mut stmt = conn.prepare(
            "SELECT stage, batch_index, status, raw_response, error, completed_at
             FROM batches WHERE cache_key = ?1 AND stage = ?2 AND status = 'complete'
             ORDER BY batch_index ASC",
        )?;
        let rows = stmt.query_map(params![cache_key, stage], |row| {
            Ok(BatchRecord {
                stage: row.get(0)?,
                batch_index: row.get(1)?,
                status: row.get(2)?,
                raw_response: row.get(3)?,
                error: row.get(4)?,
                completed_at: row.get(5)?,
            })
        })?;
        let mut out: Vec<BatchRecord> = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn save_batch(
        &self,
        cache_key: &str,
        stage: &str,
        batch_index: i64,
        raw_response: &str,
    ) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow::anyhow!("cache mutex poisoned"))?;
        let now = chrono_now();
        conn.execute(
            "INSERT INTO batches (cache_key, stage, batch_index, status, raw_response, completed_at)
             VALUES (?1, ?2, ?3, 'complete', ?4, ?5)
             ON CONFLICT(cache_key, stage, batch_index) DO UPDATE SET
               status='complete', raw_response=excluded.raw_response, error=NULL, completed_at=excluded.completed_at",
            params![cache_key, stage, batch_index, raw_response, now],
        )?;
        Ok(())
    }

    pub fn save_batch_failure(
        &self,
        cache_key: &str,
        stage: &str,
        batch_index: i64,
        error_msg: &str,
    ) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow::anyhow!("cache mutex poisoned"))?;
        let now = chrono_now();
        conn.execute(
            "INSERT INTO batches (cache_key, stage, batch_index, status, error, completed_at)
             VALUES (?1, ?2, ?3, 'failed', ?4, ?5)
             ON CONFLICT(cache_key, stage, batch_index) DO UPDATE SET
               status='failed', error=excluded.error, completed_at=excluded.completed_at",
            params![cache_key, stage, batch_index, error_msg, now],
        )?;
        Ok(())
    }

    pub fn purge_run(&self, cache_key: &str) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow::anyhow!("cache mutex poisoned"))?;
        conn.execute("DELETE FROM batches WHERE cache_key = ?1", params![cache_key])?;
        conn.execute("DELETE FROM rows WHERE cache_key = ?1", params![cache_key])?;
        conn.execute("DELETE FROM runs WHERE cache_key = ?1", params![cache_key])?;
        Ok(())
    }

    pub fn purge_all(&self) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow::anyhow!("cache mutex poisoned"))?;
        conn.execute("DELETE FROM batches", [])?;
        conn.execute("DELETE FROM rows", [])?;
        conn.execute("DELETE FROM runs", [])?;
        conn.execute("DELETE FROM pdfs", [])?;
        Ok(())
    }

    pub fn save_row(&self, row: &RowRecord) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow::anyhow!("cache mutex poisoned"))?;
        let canonical_str = serde_json::to_string(&row.canonical_json)?;
        let merged_str = row.merged_from_pages.as_ref().map(|v| {
            serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string())
        });
        conn.execute(
            "INSERT INTO rows (cache_key, page_number, row_index_within_page, canonical_json,
              needs_review, ai_needs_review, user_edited, merged_from_pages, awaiting_answer_key)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(cache_key, page_number, row_index_within_page) DO UPDATE SET
               canonical_json=excluded.canonical_json,
               needs_review=excluded.needs_review,
               ai_needs_review=excluded.ai_needs_review,
               user_edited=excluded.user_edited,
               merged_from_pages=excluded.merged_from_pages,
               awaiting_answer_key=excluded.awaiting_answer_key",
            params![
                row.cache_key,
                row.page_number,
                row.row_index_within_page,
                canonical_str,
                row.needs_review as i64,
                row.ai_needs_review as i64,
                row.user_edited as i64,
                merged_str,
                row.awaiting_answer_key as i64,
            ],
        )?;
        Ok(())
    }

    pub fn load_rows(&self, cache_key: &str) -> Result<Vec<RowRecord>> {
        let conn = self.conn.lock().map_err(|_| anyhow::anyhow!("cache mutex poisoned"))?;
        let mut stmt = conn.prepare(
            "SELECT cache_key, page_number, row_index_within_page, canonical_json,
              needs_review, ai_needs_review, user_edited, merged_from_pages, awaiting_answer_key
             FROM rows WHERE cache_key = ?1
             ORDER BY page_number ASC, row_index_within_page ASC",
        )?;
        let rows = stmt.query_map(params![cache_key], |row| {
            let canonical_str: String = row.get(3)?;
            let canonical: serde_json::Value = serde_json::from_str(&canonical_str).unwrap_or(serde_json::Value::Null);
            let merged_str: Option<String> = row.get(7)?;
            let merged: Option<Vec<i64>> = merged_str.and_then(|s| serde_json::from_str(&s).ok());
            Ok(RowRecord {
                cache_key: row.get(0)?,
                page_number: row.get(1)?,
                row_index_within_page: row.get(2)?,
                canonical_json: canonical,
                needs_review: row.get::<_, i64>(4)? != 0,
                ai_needs_review: row.get::<_, i64>(5)? != 0,
                user_edited: row.get::<_, i64>(6)? != 0,
                merged_from_pages: merged,
                awaiting_answer_key: row.get::<_, i64>(8)? != 0,
            })
        })?;
        let mut out: Vec<RowRecord> = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn upsert_run(&self, record: &RunRecord) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow::anyhow!("cache mutex poisoned"))?;
        let now = chrono_now();
        let started_at = record.started_at.clone().unwrap_or_else(|| now.clone());
        conn.execute(
            "INSERT INTO runs (cache_key, pdf_sha256, schema_hash, mode, content_type,
               confirmed_format, state, started_at, finished_at, token_usage, cost)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(cache_key) DO UPDATE SET
               pdf_sha256=excluded.pdf_sha256,
               schema_hash=excluded.schema_hash,
               mode=excluded.mode,
               content_type=excluded.content_type,
               confirmed_format=excluded.confirmed_format,
               state=excluded.state,
               finished_at=excluded.finished_at,
               token_usage=excluded.token_usage,
               cost=excluded.cost",
            params![
                record.cache_key,
                record.pdf_sha256,
                record.schema_hash,
                record.mode,
                record.content_type,
                record.confirmed_format,
                record.state,
                started_at,
                record.finished_at,
                record.token_usage,
                record.cost,
            ],
        )?;
        Ok(())
    }

    pub fn list_runs(&self) -> Result<Vec<RunRecord>> {
        let conn = self.conn.lock().map_err(|_| anyhow::anyhow!("cache mutex poisoned"))?;
        let mut stmt = conn.prepare(
            "SELECT cache_key, pdf_sha256, schema_hash, mode, content_type, confirmed_format,
              state, started_at, finished_at, token_usage, cost
             FROM runs ORDER BY started_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(RunRecord {
                cache_key: row.get(0)?,
                pdf_sha256: row.get(1)?,
                schema_hash: row.get(2)?,
                mode: row.get(3)?,
                content_type: row.get(4)?,
                confirmed_format: row.get(5)?,
                state: row.get(6)?,
                started_at: row.get(7)?,
                finished_at: row.get(8)?,
                token_usage: row.get(9)?,
                cost: row.get(10)?,
            })
        })?;
        let mut out: Vec<RunRecord> = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }
}

fn chrono_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}
