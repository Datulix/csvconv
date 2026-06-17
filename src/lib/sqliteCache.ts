import { invoke } from "@tauri-apps/api/core";
import type { CachedBatch, CacheBackend } from "./resume";
import type { StageId } from "./orchestrator";

/**
 * SQLite-backed CacheBackend (SPEC §10). Talks to the Rust commands; survives
 * across app launches. Drop-in replacement for InMemoryCacheBackend.
 */

interface BatchRecord {
  stage: string;
  batch_index: number;
  status: string;
  raw_response: string | null;
  error: string | null;
  completed_at: string | null;
}

export interface SqliteRowRecord {
  cache_key: string;
  page_number: number;
  row_index_within_page: number;
  canonical_json: unknown;
  needs_review: boolean;
  ai_needs_review: boolean;
  user_edited: boolean;
  merged_from_pages: number[] | null;
  awaiting_answer_key: boolean;
}

export interface SqliteRunRecord {
  cache_key: string;
  pdf_sha256?: string | null;
  source_path?: string | null;
  schema_hash?: string | null;
  schema_json?: string | null;
  mode?: string | null;
  content_type?: string | null;
  confirmed_format?: string | null;
  state?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  token_usage?: number | null;
  cost?: number | null;
}

export class SqliteCacheBackend implements CacheBackend {
  async getCompletedBatches<T>(cacheKey: string, stage: StageId): Promise<CachedBatch<T>[]> {
    const records = await invoke<BatchRecord[]>("cache_get_completed_batches", {
      cacheKey,
      stage,
    });
    return records.map((r) => {
      let parsed: T = null as unknown as T;
      if (r.raw_response) {
        try {
          parsed = JSON.parse(r.raw_response) as T;
        } catch {
          parsed = r.raw_response as unknown as T;
        }
      }
      return {
        batchIndex: r.batch_index,
        result: parsed,
        completedAt: r.completed_at ?? "",
      };
    });
  }

  async saveBatch<T>(
    cacheKey: string,
    stage: StageId,
    batchIndex: number,
    result: T,
  ): Promise<void> {
    const rawResponse = typeof result === "string" ? result : JSON.stringify(result);
    await invoke("cache_save_batch", {
      cacheKey,
      stage,
      batchIndex,
      rawResponse,
    });
  }

  async saveBatchFailure(
    cacheKey: string,
    stage: StageId,
    batchIndex: number,
    error: string,
  ): Promise<void> {
    await invoke("cache_save_batch_failure", {
      cacheKey,
      stage,
      batchIndex,
      error,
    });
  }

  async purgeRun(cacheKey: string): Promise<void> {
    await invoke("cache_purge_run", { cacheKey });
  }
}

export async function purgeAllCache(): Promise<void> {
  await invoke("cache_purge_all");
}

export async function saveRow(record: SqliteRowRecord): Promise<void> {
  await invoke("cache_save_row", { row: record });
}

export async function saveRows(records: SqliteRowRecord[]): Promise<void> {
  await invoke("cache_save_rows", { rows: records });
}

export async function loadRows(cacheKey: string): Promise<SqliteRowRecord[]> {
  return invoke<SqliteRowRecord[]>("cache_load_rows", { cacheKey });
}

export async function upsertRun(record: SqliteRunRecord): Promise<void> {
  await invoke("cache_upsert_run", { record });
}

export async function listRuns(): Promise<SqliteRunRecord[]> {
  return invoke<SqliteRunRecord[]>("cache_list_runs");
}

/** Base64 of the run's original source PDF, for previewing it in the Review UI. */
export async function getRunPdfBase64(cacheKey: string): Promise<string> {
  return invoke<string>("read_run_pdf_base64", { cacheKey });
}

/**
 * Render one page (1-based) of the run's source PDF to a base64 JPEG. The WebView can't
 * display a PDF in an iframe (Android has no built-in PDF viewer), so the preview panel
 * shows this rendered image instead.
 */
export async function renderRunPdfPage(cacheKey: string, page: number, dpi = 150): Promise<string> {
  return invoke<string>("render_pdf_page", { cacheKey, page, dpi });
}

/** Copy figure image files to a folder the user picked. Returns the names copied. */
export async function exportFigures(figurePaths: string[], destDir: string): Promise<string[]> {
  return invoke<string[]>("export_figures", { figurePaths, destDir });
}

export async function saveTrace(runId: string, traceJson: string): Promise<void> {
  await invoke("cache_save_trace", { runId, traceJson });
}

export async function loadAllTraces(): Promise<string[]> {
  return invoke<string[]>("cache_load_all_traces");
}
