import type { AsyncQueue } from "./queues";

/**
 * Identifiers for pipeline stages, matched against cache entries and progress events.
 * Keep in sync with SPEC §10 `batches.stage` enum.
 */
export type StageId =
  | "triage"
  | "rasterizer"
  | "detector"
  | "extractor"
  | "validator"
  | "solver"
  | "compare"
  | "merge"
  | "answer_key"
  | "answer_key_patch";

export type RunState = "running" | "paused" | "cancelled" | "completed" | "crashed";

export type StageState = "idle" | "running" | "paused" | "complete" | "error";

export interface StageProgress {
  stage: StageId;
  state: StageState;
  total: number | null;
  completed: number;
  inFlight: number;
  failed: number;
  cached: number;
  lastError?: string;
}

export type PipelineEvent =
  | { type: "stage_started"; stage: StageId }
  | { type: "stage_progress"; progress: StageProgress }
  | { type: "stage_completed"; stage: StageId }
  | { type: "stage_failed"; stage: StageId; error: string }
  | { type: "batch_completed"; stage: StageId; batchIndex: number }
  | { type: "batch_failed"; stage: StageId; batchIndex: number; error: string }
  | { type: "row_emitted"; pageNumber: number; rowIndex: number }
  | { type: "run_state_changed"; state: RunState };

export type PipelineEventListener = (event: PipelineEvent) => void;

/**
 * Raised when a stage hits `controller.checkpoint()` after the run was cancelled.
 * Stages should let it propagate so the orchestrator can shut the pipeline down.
 */
export class RunCancelledError extends Error {
  readonly name = "RunCancelledError";
  constructor() {
    super("run was cancelled");
  }
}

/**
 * Per-run lifecycle controller. Stages call `await controller.checkpoint()` at the
 * top of each iteration; pausing freezes them at the next checkpoint until resumed,
 * cancellation throws `RunCancelledError`.
 */
export class RunController {
  private state: RunState = "running";
  private listeners: PipelineEventListener[] = [];
  private resumeWaiters: Array<() => void> = [];

  constructor(public readonly runId: string) {}

  getState(): RunState {
    return this.state;
  }

  pause(): void {
    if (this.state === "running") {
      this.state = "paused";
      this.emit({ type: "run_state_changed", state: "paused" });
    }
  }

  resume(): void {
    if (this.state === "paused") {
      this.state = "running";
      this.emit({ type: "run_state_changed", state: "running" });
      const pending = this.resumeWaiters;
      this.resumeWaiters = [];
      for (const w of pending) w();
    }
  }

  cancel(): void {
    if (this.state === "running" || this.state === "paused") {
      this.state = "cancelled";
      this.emit({ type: "run_state_changed", state: "cancelled" });
      // wake anyone parked on pause — they'll throw on next checkpoint
      const pending = this.resumeWaiters;
      this.resumeWaiters = [];
      for (const w of pending) w();
    }
  }

  markCompleted(): void {
    if (this.state === "running") {
      this.state = "completed";
      this.emit({ type: "run_state_changed", state: "completed" });
    }
  }

  /**
   * Stages call this at the top of each iteration (and ideally before expensive ops).
   * Resolves immediately when running; awaits on pause; throws on cancel.
   */
  async checkpoint(): Promise<void> {
    while (this.state === "paused") {
      await new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
    }
    if (this.state === "cancelled") {
      throw new RunCancelledError();
    }
  }

  on(listener: PipelineEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  emit(event: PipelineEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[RunController] listener threw:", err);
      }
    }
  }
}

/**
 * Context handed to each stage. Stages should:
 *   - call `await ctx.controller.checkpoint()` at the top of every loop iteration
 *   - emit progress events via `ctx.controller.emit(...)` so the UI updates
 *   - read input via the supplied async iterable and write output via the supplied queue
 *   - close their output queue when their input is exhausted (or when checkpoint throws)
 */
export interface StageContext {
  controller: RunController;
  cacheKey: string;
}

/**
 * A pipeline stage: pulls items off an input async iterable, writes results to an output queue.
 * Stages are responsible for closing their own output queue when they're done — this signals
 * end-of-stream to downstream stages.
 */
export interface Stage<TIn, TOut> {
  readonly id: StageId;
  run(ctx: StageContext, input: AsyncIterable<TIn>, output: AsyncQueue<TOut>): Promise<void>;
}

/**
 * Helper for stages: report progress with a single call.
 */
export function reportProgress(
  controller: RunController,
  partial: Omit<StageProgress, "stage"> & { stage: StageId },
): void {
  controller.emit({ type: "stage_progress", progress: partial });
}
