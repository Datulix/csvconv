import { SafetyBlockedError, TruncationError } from "../lib/modelClient";
import type { ExtractedBatch, ExtractedPage, ExtractorPageInput } from "./extractors/types";

/**
 * Recursive split-on-failure helper. When an extractor batch fails with a recoverable
 * error (RECITATION safety block or output truncation), this re-runs the extractor on
 * the left and right halves, recursively, until each problematic page is isolated.
 * Pages that still fail at batch-size=1 are recorded with their failure reason; the
 * rest of the run continues with the successfully-extracted pages.
 *
 * Recoverable errors:
 *   - TruncationError: model hit MAX_TOKENS — smaller batch fits in the output window
 *   - SafetyBlockedError with RECITATION/OTHER finish reason: filter triggered on one
 *     specific page's content; isolating it lets the others through
 *
 * NOT recoverable here (bubbled up to caller):
 *   - SafetyBlockedError with SAFETY / PROHIBITED_CONTENT / BLOCKLIST / SPII —
 *     these indicate genuinely unprocessable content; splitting won't help
 *   - PayloadTooLargeError — handled separately in modelClient pre-check
 *   - Network errors, API errors, etc.
 */

export interface SplitFailure {
  pageNumber: number;
  reason: string;
  /** Raw finishReason from the API (RECITATION, MAX_TOKENS, SAFETY, etc.). */
  finishReason?: string;
  /** Gemini safety-ratings array, present for SAFETY / RECITATION / etc. */
  safetyRatings?: unknown;
  /** Citation metadata, present for RECITATION. */
  citationMetadata?: unknown;
  /** Prompt-level feedback (block reason at the prompt stage, if any). */
  promptFeedback?: unknown;
  /** Base64 JPEG of the failed page, attached after the fact by the orchestrator. */
  imageBase64?: string;
  mimeType?: string;
}

export interface SplitResult {
  batch: ExtractedBatch;
  failedPages: SplitFailure[];
}

const MAX_RECURSION_DEPTH = 4;

function isAutoSplittableError(err: unknown): boolean {
  if (err instanceof TruncationError) return true;
  if (err instanceof SafetyBlockedError) {
    // RECITATION + OTHER are the ones isolation can fix. SAFETY/PROHIBITED_CONTENT/BLOCKLIST/SPII
    // indicate content the API will reject no matter what; we shouldn't waste tokens splitting.
    return err.finishReason === "RECITATION" || err.finishReason === "OTHER";
  }
  return false;
}

function errorReason(err: unknown): string {
  if (err instanceof TruncationError) return `truncation (finishReason=${err.finishReason})`;
  if (err instanceof SafetyBlockedError) return `blocked (finishReason=${err.finishReason})`;
  if (err instanceof Error) return err.message;
  return String(err);
}

function errorDetail(err: unknown): Partial<SplitFailure> {
  if (err instanceof TruncationError) {
    return { finishReason: err.finishReason };
  }
  if (err instanceof SafetyBlockedError) {
    return {
      finishReason: err.finishReason,
      safetyRatings: err.safetyRatings,
      citationMetadata: err.citationMetadata,
      promptFeedback: err.promptFeedback,
    };
  }
  return {};
}

export async function extractWithAutoSplit(
  callExtractor: (pages: ExtractorPageInput[]) => Promise<ExtractedBatch>,
  pages: ExtractorPageInput[],
  depth: number = 0,
): Promise<SplitResult> {
  if (pages.length === 0) {
    return { batch: { pages: [] }, failedPages: [] };
  }

  try {
    const batch = await callExtractor(pages);
    return { batch, failedPages: [] };
  } catch (err) {
    const splittable = isAutoSplittableError(err);

    // Out of splits or this isn't a splittable error → bubble up if non-splittable;
    // otherwise record the page(s) as failed and return an empty batch for them.
    if (!splittable) {
      throw err;
    }
    if (pages.length === 1 || depth >= MAX_RECURSION_DEPTH) {
      const reason = errorReason(err);
      const detail = errorDetail(err);
      return {
        batch: { pages: [] },
        failedPages: pages.map((p) => ({
          pageNumber: p.pageNumber,
          reason,
          ...detail,
        })),
      };
    }

    const mid = Math.floor(pages.length / 2);
    const leftPages = pages.slice(0, mid);
    const rightPages = pages.slice(mid);

    const [leftResult, rightResult] = await Promise.all([
      extractWithAutoSplit(callExtractor, leftPages, depth + 1),
      extractWithAutoSplit(callExtractor, rightPages, depth + 1),
    ]);

    const mergedPages: ExtractedPage[] = [
      ...leftResult.batch.pages,
      ...rightResult.batch.pages,
    ].sort((a, b) => a.page_number - b.page_number);

    return {
      batch: { pages: mergedPages },
      failedPages: [...leftResult.failedPages, ...rightResult.failedPages],
    };
  }
}
