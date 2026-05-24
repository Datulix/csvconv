import type { AsyncQueue } from "./queues";
import type { StageId } from "./orchestrator";

/**
 * One batch's worth of cached output for a single stage.
 * `result` is whatever the stage produces — caller knows the shape via the stage's TOut.
 */
export interface CachedBatch<T = unknown> {
  batchIndex: number;
  result: T;
  completedAt: string; // ISO timestamp
}

/**
 * Cache backend used by the resume protocol. The SQLite implementation lands in build step 16;
 * for now this interface lets the pipeline talk to whatever cache exists (real or stubbed).
 */
export interface CacheBackend {
  /**
   * Return all batches in `(batchIndex ASC)` order whose `status === "complete"` for this
   * stage of this run.
   */
  getCompletedBatches<T>(cacheKey: string, stage: StageId): Promise<CachedBatch<T>[]>;

  /** Mark this batch's result as complete in cache. */
  saveBatch<T>(
    cacheKey: string,
    stage: StageId,
    batchIndex: number,
    result: T,
  ): Promise<void>;

  /** Mark this batch as failed (with the error). Useful for diagnostics on resume. */
  saveBatchFailure(
    cacheKey: string,
    stage: StageId,
    batchIndex: number,
    error: string,
  ): Promise<void>;

  /** Clear all batches for a given cache key (used by "Start fresh" from the resume dialog). */
  purgeRun(cacheKey: string): Promise<void>;
}

/**
 * Stub cache backend that holds everything in memory. Use this until the SQLite backend
 * (step 16) lands. Resets per app start, so it doesn't actually persist anything.
 */
export class InMemoryCacheBackend implements CacheBackend {
  private store = new Map<string, Map<StageId, Map<number, CachedBatch<unknown>>>>();
  private failures = new Map<string, Map<StageId, Map<number, string>>>();

  async getCompletedBatches<T>(cacheKey: string, stage: StageId): Promise<CachedBatch<T>[]> {
    const byStage = this.store.get(cacheKey);
    if (!byStage) return [];
    const byBatch = byStage.get(stage);
    if (!byBatch) return [];
    return Array.from(byBatch.values())
      .sort((a, b) => a.batchIndex - b.batchIndex)
      .map((b) => b as CachedBatch<T>);
  }

  async saveBatch<T>(
    cacheKey: string,
    stage: StageId,
    batchIndex: number,
    result: T,
  ): Promise<void> {
    let byStage = this.store.get(cacheKey);
    if (!byStage) {
      byStage = new Map();
      this.store.set(cacheKey, byStage);
    }
    let byBatch = byStage.get(stage);
    if (!byBatch) {
      byBatch = new Map();
      byStage.set(stage, byBatch);
    }
    byBatch.set(batchIndex, {
      batchIndex,
      result,
      completedAt: new Date().toISOString(),
    });
  }

  async saveBatchFailure(
    cacheKey: string,
    stage: StageId,
    batchIndex: number,
    error: string,
  ): Promise<void> {
    let byStage = this.failures.get(cacheKey);
    if (!byStage) {
      byStage = new Map();
      this.failures.set(cacheKey, byStage);
    }
    let byBatch = byStage.get(stage);
    if (!byBatch) {
      byBatch = new Map();
      byStage.set(stage, byBatch);
    }
    byBatch.set(batchIndex, error);
  }

  async purgeRun(cacheKey: string): Promise<void> {
    this.store.delete(cacheKey);
    this.failures.delete(cacheKey);
  }
}

/**
 * Resume protocol (SPEC §4.7):
 *
 * On run start, for each stage, the orchestrator calls `prefillFromCache` to push all
 * previously-completed batches into the stage's output queue, in order. Downstream stages
 * see these as if newly produced, so cached rows render in the Review UI immediately.
 *
 * Returns the highest `batchIndex` already cached (or -1 if none), so the stage knows
 * where to resume new work.
 */
export async function prefillFromCache<T>(
  cache: CacheBackend,
  cacheKey: string,
  stage: StageId,
  output: AsyncQueue<T>,
): Promise<{ resumed: number; lastBatchIndex: number }> {
  const cached = await cache.getCompletedBatches<T>(cacheKey, stage);
  for (const batch of cached) {
    await output.push(batch.result);
  }
  const lastBatchIndex = cached.length > 0 ? cached[cached.length - 1].batchIndex : -1;
  return { resumed: cached.length, lastBatchIndex };
}

/**
 * Wrap a stage's per-batch work so successful results are persisted and failures are
 * recorded. The stage's `process` function is called only for batches not already cached.
 */
export async function runBatchWithCache<TResult>(
  cache: CacheBackend,
  cacheKey: string,
  stage: StageId,
  batchIndex: number,
  process: () => Promise<TResult>,
): Promise<TResult> {
  try {
    const result = await process();
    await cache.saveBatch(cacheKey, stage, batchIndex, result);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await cache.saveBatchFailure(cacheKey, stage, batchIndex, msg);
    throw err;
  }
}
