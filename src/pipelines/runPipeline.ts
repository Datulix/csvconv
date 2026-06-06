import type { ModelId } from "../lib/models";
import type { AppSettings } from "../lib/settings";
import {
  rasterizePdf,
  readImageAsBase64,
  cropFiguresBatch,
  figuresDir,
  storeSourcePdf,
  type CropJob,
} from "../lib/pdfApi";
import { invoke } from "@tauri-apps/api/core";
import type { RunMode } from "../schema/contentTypes";
import type { Schema } from "../schema/types";
import { schemaHash } from "../schema/hash";
import {
  saveRows,
  upsertRun,
  SqliteCacheBackend,
  type SqliteRowRecord,
} from "../lib/sqliteCache";
import type { ExamFormat } from "./detector";
import { runDocumentAnalyzer, type DocumentAnalysisResult, type MarkingRegion } from "./documentAnalyzer";
import type { ExtractedBatch, ExtractedPage, ExtractedRow, ExtractorPageInput, FigureBounds } from "./extractors/types";
import { runInlineMarkedExtractor } from "./extractors/mcq_inlineMarked";
import { runWrittenAnswerExtractor } from "./extractors/mcq_writtenAnswer";
import { runConversionToMcq } from "./extractors/convertToMcq";
import { runAnswerFillExtractor } from "./extractors/answerFill";
import { questionPages } from "./conversionInventory";
import {
  patchWithAnswerKey,
  pickAnswerKeyPages,
  runAnswerKeyBodyExtractor,
  runAnswerKeyParser,
  type AnswerKeyResult,
} from "./extractors/mcq_answerKeyAtEnd";
import { mergeAcrossPages } from "./merge";
import { extractWithAutoSplit, type SplitFailure } from "./autoSplit";
import { runValidator, VALIDATOR_CONFIDENCE_THRESHOLD, type McqExtractorVariant } from "./validator";
import {
  indexSolverResults,
  planSolverBatches,
  runSolverBatch,
  type SolverPageImage,
  type SolverQuestion,
} from "./solver";
import { compareAll, type ComparedRow } from "./compare";
import {
  startTrace,
  beginPhase,
  completePhase,
  skipPhase,
  finishTrace,
} from "../lib/pipelineTrace";

export interface PipelineProgress {
  stage: string;
  message: string;
  done?: number;
  total?: number;
}

export type ProgressFn = (e: PipelineProgress) => void;

export interface RunPipelineArgs {
  apiKey: string;
  pdfPath: string;
  schema: Schema;
  mode: RunMode;
  /** Required when content_type=mcq and mode != "answer". The dominant/fallback marking format. */
  format: ExamFormat | null;
  /**
   * Per-region marking methods for mixed-format documents (MCQ only). When present with more
   * than one region, extraction routes each question range to its own extractor variant.
   * When absent or single-region, the pipeline uses `format` for the whole document.
   */
  markingRegions?: MarkingRegion[];
  settings: AppSettings;
  runId: string;
  onProgress?: ProgressFn;
  signal?: AbortSignal;
  /**
   * Pre-computed document analysis from the NewConversion flow. If provided, the pipeline
   * skips its own analyzer call and uses this result directly, avoiding a duplicate LLM call.
   */
  documentAnalysis?: DocumentAnalysisResult;
}

export interface PipelineResult {
  cacheKey: string;
  rows: ExtractedRow[];
  pages: ExtractedPage[];
  summary: {
    pageCount: number;
    rowCount: number;
    needsReviewCount: number;
    aiNeedsReviewCount: number;
    /** Pages that couldn't be extracted (RECITATION block, truncation, etc.) even after auto-split. */
    failedPagesCount: number;
  };
  /** Pages auto-split dropped because they failed individually. */
  failedPages: SplitFailure[];
  /** Present only in Review mode. */
  compareSummary: ReturnType<typeof compareAll>["summary"] | null;
  /** Present only for answer_key_at_end. */
  answerKey: AnswerKeyResult | null;
}

const EXTRACTOR_CONCURRENCY = 2;

function reportProgress(fn: ProgressFn | undefined, e: PipelineProgress) {
  if (fn) fn(e);
}

function modelForStage(stage: keyof Pick<AppSettings, "analyzer_model" | "extractor_model" | "validator_model" | "solver_model">, settings: AppSettings): ModelId {
  const value = (settings[stage] ?? settings.primary_model) as ModelId | null;
  if (!value) throw new Error(`No model configured for stage "${stage}" (set a primary model in Settings)`);
  return value;
}

async function computeCacheKey(args: {
  pdfSha256: string;
  schemaHash: string;
  mode: string;
  format: string | null;
  settings: AppSettings;
}): Promise<string> {
  const parts = [
    args.pdfSha256,
    args.schemaHash,
    args.mode,
    args.format ?? "none",
    args.settings.primary_model ?? "none",
    args.settings.analyzer_model ?? "inherit",
    args.settings.extractor_model ?? "inherit",
    args.settings.validator_model ?? "inherit",
    args.settings.solver_model ?? "inherit",
    String(args.settings.dpi),
    String(args.settings.pages_per_batch),
  ];
  const canonical = parts.join("|");
  const buf = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getPageNum<T extends { pageNumber: number } | { page_number: number }>(item: T): number {
  return "pageNumber" in item ? (item as any).pageNumber : (item as any).page_number;
}

/** Normalize a question stem for duplicate comparison: lowercase, alphanumerics only, capped. */
function normalizeStem(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
}

/**
 * Find rows that share a question stem with another row under a DIFFERENT question number —
 * the signature of extraction cross-contamination (one question's text copied onto another).
 * Returns a set of "<page_number>:<row_index>" keys to flag. Same stem under the same number
 * (a legitimate cross-page question) is not flagged.
 */
function findDuplicateQuestionRows(pages: ExtractedPage[]): Set<string> {
  const byStem = new Map<string, Array<{ key: string; qn: string }>>();
  for (const page of pages) {
    for (let i = 0; i < page.rows.length; i++) {
      const stem = normalizeStem(page.rows[i].question_text);
      if (stem.length < 12) continue; // too short to judge confidently
      const entry = { key: `${page.page_number}:${i}`, qn: String(page.rows[i].question_number ?? "") };
      const arr = byStem.get(stem);
      if (arr) arr.push(entry);
      else byStem.set(stem, [entry]);
    }
  }
  const flagged = new Set<string>();
  for (const entries of byStem.values()) {
    if (entries.length < 2) continue;
    const distinctNumbers = new Set(entries.map((e) => e.qn));
    if (distinctNumbers.size >= 2) {
      for (const e of entries) flagged.add(e.key);
    }
  }
  return flagged;
}

/**
 * Group contiguous items into batches, starting a new batch whenever the grouping key
 * changes or the batch reaches `batchSize`. With a section-only key this reproduces the
 * legacy section-aware batching; with a section+marking-region key it additionally keeps
 * each batch homogeneous in marking format so one extractor variant applies per batch.
 */
function partitionByKey<T>(items: T[], batchSize: number, keyOf: (item: T) => string): T[][] {
  const batches: T[][] = [];
  let currentKey: string | null = null;
  let group: T[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if ((currentKey !== null && key !== currentKey) || group.length >= batchSize) {
      if (group.length > 0) {
        batches.push(group);
        group = [];
      }
    }
    currentKey = key;
    group.push(item);
  }
  if (group.length > 0) batches.push(group);
  return batches;
}

/**
 * Build a `pageNumber → marking format` resolver. Maps a page to its question range via the
 * analyzer page_map, then finds the marking region covering that range. Falls back to the
 * document-level `format` when there are no regions or the page has no questions.
 */
function makeFormatForPage(
  docAnalysis: DocumentAnalysisResult | null,
  regions: MarkingRegion[],
  fallback: ExamFormat | null,
): (pageNum: number) => ExamFormat | null {
  const pageMapByNum = new Map((docAnalysis?.page_map ?? []).map((p) => [p.page_number, p]));
  return (pageNum: number) => {
    if (regions.length === 0) return fallback;
    const entry = pageMapByNum.get(pageNum);
    const q = entry?.question_range_start ?? entry?.question_range_end ?? null;
    if (q == null) return fallback;
    const region = regions.find(
      (r) => q >= r.question_range_start && q <= r.question_range_end,
    );
    return region ? region.marking_format : fallback;
  };
}

/** Section + marking-region composite key used to partition extractor/validator batches. */
function makeBatchKeyFn<T extends { pageNumber: number } | { page_number: number }>(
  docAnalysis: DocumentAnalysisResult | null,
  formatForPage: (pageNum: number) => ExamFormat | null,
): (item: T) => string {
  const pageMapByNum = new Map((docAnalysis?.page_map ?? []).map((p) => [p.page_number, p]));
  return (item: T) => {
    const pageNum = getPageNum(item);
    const section = (pageMapByNum.get(pageNum)?.section_label || "").trim();
    return `${section}|${formatForPage(pageNum) ?? "none"}`;
  };
}

function variantForFormat(f: ExamFormat | null): McqExtractorVariant {
  return f === "written_answer"
    ? "written_answer"
    : f === "answer_key_at_end"
      ? "answer_key_at_end"
      : "inline_marked";
}

async function mapWithConcurrency<I, O>(
  items: I[],
  concurrency: number,
  fn: (item: I, idx: number) => Promise<O>,
): Promise<O[]> {
  const results: O[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(concurrency, items.length); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

export async function runPipeline(args: RunPipelineArgs): Promise<PipelineResult> {
  const { apiKey, pdfPath, schema, mode, format, settings, runId, onProgress, signal } = args;
  const cache = new SqliteCacheBackend();
  const pdfName = pdfPath.replace(/\\/g, "/").split("/").pop() ?? pdfPath;

  startTrace({
    runId,
    pdfPath,
    pdfName,
    mode,
    format,
    contentType: schema.content_type,
    schemaName: schema.name,
    startedAt: Date.now(),
  });

  reportProgress(onProgress, { stage: "init", message: "Hashing PDF…" });
  const pdfSha256 = await invoke<string>("hash_pdf", { path: pdfPath });
  const sHash = await schemaHash(schema);
  const cacheKey = await computeCacheKey({
    pdfSha256,
    schemaHash: sHash,
    mode,
    format,
    settings,
  });

  // Copy the source PDF into the cache so the Review PDF panel keeps working even
  // if the original is later moved or deleted. Fall back to the original path on failure.
  let storedPdfPath = pdfPath;
  try {
    storedPdfPath = await storeSourcePdf(pdfPath, pdfSha256);
  } catch (e) {
    console.warn("could not copy source PDF into cache; using original path", e);
  }

  await upsertRun({
    cache_key: cacheKey,
    pdf_sha256: pdfSha256,
    source_path: storedPdfPath,
    schema_hash: sHash,
    schema_json: JSON.stringify(schema),
    mode,
    content_type: schema.content_type,
    confirmed_format: format,
    state: "running",
    started_at: new Date().toISOString(),
  });

  try {
    // 1. Rasterize all pages (no triage pre-filter; analyzer identifies blank pages)
    reportProgress(onProgress, {
      stage: "rasterize",
      message: "Rasterizing PDF pages…",
    });

    beginPhase("rasterize", "Rasterize", "system", {
      dpi: settings.dpi,
    });
    const raster = await rasterizePdf({
      path: pdfPath,
      dpi: settings.dpi,
      runId,
    });
    completePhase("rasterize", {
      pages: raster.pages.map((p) => ({
        pageNumber: p.page_number,
        width: p.width,
        height: p.height,
        skipped: p.skipped,
      })),
    });

    // 2. Base64-encode page images
    reportProgress(onProgress, { stage: "encode", message: "Encoding page images…" });
    const pageImages: ExtractorPageInput[] = [];
    for (const p of raster.pages) {
      if (p.skipped || !p.path) continue;
      const base64 = await readImageAsBase64(p.path);
      pageImages.push({ pageNumber: p.page_number, base64, mimeType: "image/jpeg" });
    }
    const pageImageByNumber = new Map(pageImages.map((p) => [p.pageNumber, p]));

    if (signal?.aborted) throw new Error("aborted");

    // 3. Document Intelligence — full structural analysis of all pages.
    // If a pre-computed analysis was passed in (from NewConversion), skip the LLM call.
    reportProgress(onProgress, { stage: "analyze", message: "Analyzing document structure…" });
    const analyzerModel = modelForStage("analyzer_model", settings);
    beginPhase("analyze", "Document Analysis", "ai", {
      pageCount: pageImages.length,
      modelId: analyzerModel,
      precomputed: !!args.documentAnalysis,
    });
    let docAnalysis: DocumentAnalysisResult | null = args.documentAnalysis ?? null;
    if (!docAnalysis) {
      try {
        docAnalysis = await runDocumentAnalyzer({
          apiKey,
          modelId: analyzerModel,
          pages: pageImages,
          pdfName,
          signal,
        });
        completePhase("analyze", docAnalysis);
      } catch (err) {
        completePhase("analyze", { error: String(err) });
        throw err;
      }
    } else {
      completePhase("analyze", { ...docAnalysis, note: "Pre-computed from conversion flow" });
    }

    if (signal?.aborted) throw new Error("aborted");

    // Annotate pageImages with has_images / expected image count from document analysis page map
    if (docAnalysis) {
      const pageMapByNumber = new Map(docAnalysis.page_map.map((p) => [p.page_number, p]));
      for (const img of pageImages) {
        const entry = pageMapByNumber.get(img.pageNumber);
        if (entry) {
          img.has_images = entry.has_images;
          img.expected_image_count = entry.image_count;
        }
      }
    }

    // Derive blank pages from analyzer output (replaces triage blank-page filter)
    const blankPageNumbers = docAnalysis
      ? docAnalysis.page_map
          .filter((p) => p.content_type === "blank")
          .map((p) => p.page_number)
      : [];

    // Resolve per-region marking methods. When there's 0 or 1 region, this collapses to the
    // document-level `format` and downstream behaviour is identical to single-format runs.
    const markingRegions =
      args.markingRegions && args.markingRegions.length > 0
        ? args.markingRegions
        : docAnalysis?.marking_regions ?? [];
    const effectiveRegions = markingRegions.length > 1 ? markingRegions : [];
    const formatForPage = makeFormatForPage(docAnalysis, effectiveRegions, format);
    const batchKey = makeBatchKeyFn<ExtractorPageInput>(docAnalysis, formatForPage);

    // Answer-key question ranges (for mixed-format docs, only these rows get key-patched).
    const answerKeyRanges = effectiveRegions
      .filter((r) => r.marking_format === "answer_key_at_end")
      .map((r) => [r.question_range_start, r.question_range_end] as [number, number]);
    const inAnswerKeyRegion = (qn: string): boolean => {
      if (answerKeyRanges.length === 0) return true; // whole-doc answer key: no range restriction
      const m = String(qn).match(/\d+/);
      if (!m) return true;
      const n = parseInt(m[0], 10);
      return answerKeyRanges.some(([s, e]) => n >= s && n <= e);
    };

    // 4. Plan extractor batches.
    // Answer-key handling applies when the whole document is answer_key_at_end OR any region is.
    // For those, exclude answer-key pages from the body extractor.
    // Use exact page locations from document analysis; fall back to heuristic if unavailable.
    const isAnswerKey =
      mode !== "answer" &&
      (format === "answer_key_at_end" ||
        effectiveRegions.some((r) => r.marking_format === "answer_key_at_end"));
    let answerKeyPageNumbers: number[] = [];
    let bodyImages = pageImages.filter((p) => !blankPageNumbers.includes(p.pageNumber));
    if (isAnswerKey) {
      if (docAnalysis && docAnalysis.answer_key_locations.length > 0) {
        answerKeyPageNumbers = docAnalysis.answer_key_locations.map((l) => l.page_number);
      } else {
        answerKeyPageNumbers = pickAnswerKeyPages(pageImages.length);
      }
      bodyImages = bodyImages.filter((p) => !answerKeyPageNumbers.includes(p.pageNumber));
    }

    const batchSize = Math.max(1, settings.pages_per_batch);
    const batches = partitionByKey(bodyImages, batchSize, batchKey);
    reportProgress(onProgress, {
      stage: "extract",
      message: `Extracting ${batches.length} batch${batches.length === 1 ? "" : "es"}…`,
      total: batches.length,
      done: 0,
    });

    const extractorModel = modelForStage("extractor_model", settings);

    beginPhase("extract", "Extract", "ai", {
      batches: batches.map((b, i) => ({
        batchIndex: i,
        pageNumbers: b.map((p) => p.pageNumber),
        format: formatForPage(b[0]?.pageNumber) ?? format ?? "inferred",
      })),
      modelId: extractorModel,
      format: format ?? "inferred",
      markingRegions: effectiveRegions,
      batchSize,
    });

    // 5. Run extractor in parallel with auto-split-on-RECITATION/TRUNCATION
    let doneBatches = 0;
    const allFailedPages: SplitFailure[] = [];
    const batchResults: ExtractedBatch[] = await mapWithConcurrency(
      batches,
      EXTRACTOR_CONCURRENCY,
      async (batch, idx) => {
        if (signal?.aborted) throw new Error("aborted");
        // Route this batch to the extractor variant for its marking region. Batches are
        // homogeneous in marking format (partitionByKey splits on region), so the first
        // page's format applies to the whole batch.
        const batchFormat = formatForPage(batch[0]?.pageNumber) ?? format;
        const callExtractor = (pagesSubset: ExtractorPageInput[]) =>
          runExtractorVariant({
            apiKey,
            modelId: extractorModel,
            schema,
            mode,
            format: batchFormat,
            pages: pagesSubset,
            signal,
          });
        const { batch: result, failedPages } = await extractWithAutoSplit(callExtractor, batch);
        if (failedPages.length > 0) {
          allFailedPages.push(...failedPages);
          await cache.saveBatchFailure(
            cacheKey,
            "extractor",
            idx,
            `auto-split couldn't recover ${failedPages.length} page(s): ${failedPages
              .map((f) => `p${f.pageNumber} (${f.reason})`)
              .join("; ")}`,
          );
        } else {
          await cache.saveBatch(cacheKey, "extractor", idx, result);
        }
        doneBatches += 1;
        reportProgress(onProgress, {
          stage: "extract",
          message:
            failedPages.length > 0
              ? `Extracted batch ${doneBatches}/${batches.length} (${failedPages.length} page(s) failed)`
              : `Extracted batch ${doneBatches}/${batches.length}`,
          done: doneBatches,
          total: batches.length,
        });
        return result;
      },
    );

    completePhase("extract", {
      batchCount: batchResults.length,
      failedPageCount: allFailedPages.length,
      failedPages: allFailedPages.map((f) => ({ pageNumber: f.pageNumber, reason: f.reason })),
      batches: batchResults,
    });

    // 6. Merge across page boundaries
    reportProgress(onProgress, { stage: "merge", message: "Merging page-span questions…" });
    const prePartials = batchResults.flatMap((b) =>
      b.pages.flatMap((p) =>
        p.rows
          .filter((r) => r.is_partial)
          .map((r) => ({ questionNumber: String(r.question_number ?? "?"), pageNumber: p.page_number })),
      ),
    );
    beginPhase("merge", "Merge", "system", {
      pageCount: batchResults.reduce((s, b) => s + b.pages.length, 0),
      partialRows: prePartials,
    });
    let merged = mergeAcrossPages(batchResults, { mergeSourceSnippets: true });
    completePhase("merge", { mergedCount: prePartials.length, pages: merged.pages });

    // 7. Validator
    let needsReviewCount = 0;
    if (settings.validator_enabled) {
      reportProgress(onProgress, { stage: "validator", message: "Re-checking low-confidence rows…" });
      const primaryModel = modelForStage("extractor_model", settings);
      const validatorModel = (settings.validator_model ?? settings.primary_model) as ModelId | null;
      const secondaryModel = validatorModel && validatorModel !== primaryModel ? validatorModel : null;
      const lowConfRows = merged.pages.flatMap((p) =>
        p.rows
          .filter((r) => typeof r.confidence === "number" && r.confidence < VALIDATOR_CONFIDENCE_THRESHOLD)
          .map((r) => ({ questionNumber: String(r.question_number ?? "?"), pageNumber: p.page_number, confidence: r.confidence })),
      );
      beginPhase("validate", "Validate", "ai", {
        candidateCount: lowConfRows.length,
        threshold: VALIDATOR_CONFIDENCE_THRESHOLD,
        primaryModel,
        secondaryModel,
        lowConfRows,
      });

      const allPagesMerged: ExtractedPage[] = merged.pages;
      const validatedPages: ExtractedPage[] = [];
      const pageGroupKey = makeBatchKeyFn<ExtractedPage>(docAnalysis, formatForPage);
      for (const pageGroup of partitionByKey(allPagesMerged, batchSize, pageGroupKey)) {
        // Each group is homogeneous in marking region, so pick the variant from its first page.
        const variant: McqExtractorVariant = variantForFormat(
          formatForPage(pageGroup[0]?.page_number) ?? format,
        );
        const initial: ExtractedBatch = { pages: pageGroup };
        const pageInputs: ExtractorPageInput[] = pageGroup
          .map((p) => pageImageByNumber.get(p.page_number))
          .filter((p): p is ExtractorPageInput => p !== undefined);
        const validated = await runValidator({
          apiKey,
          primaryModelId: primaryModel,
          secondaryModelId: secondaryModel,
          schema,
          format: variant,
          pages: pageInputs,
          initial,
          signal,
        });
        for (const vp of validated.pages) {
          validatedPages.push({
            page_number: vp.page_number,
            layout_notes: vp.layout_notes,
            rows: vp.rows.map((vr) => {
              if (vr.needs_review) needsReviewCount += 1;
              return vr.row;
            }),
          });
        }
      }
      merged = { pages: validatedPages };
      completePhase("validate", { needsReviewCount, pages: validatedPages });
    } else {
      skipPhase("validate", "Validate", "ai", "Validator disabled in settings");
    }

    if (signal?.aborted) throw new Error("aborted");

    // 8. Answer-key parser + patch (only for answer_key_at_end format)
    let answerKey: AnswerKeyResult | null = null;
    if (isAnswerKey && answerKeyPageNumbers.length > 0) {
      reportProgress(onProgress, {
        stage: "answer_key",
        message: `Parsing answer key from ${answerKeyPageNumbers.length} trailing page${answerKeyPageNumbers.length === 1 ? "" : "s"}…`,
      });
      beginPhase("answer_key", "Answer Key", "ai", {
        keyPages: answerKeyPageNumbers,
        modelId: extractorModel,
      });
      const keyImages = pageImages.filter((p) => answerKeyPageNumbers.includes(p.pageNumber));
      if (keyImages.length > 0) {
        answerKey = await runAnswerKeyParser({
          apiKey,
          modelId: extractorModel,
          pages: keyImages,
          signal,
        });
        // In mixed-format docs, only patch rows in answer_key_at_end regions; leave
        // inline-marked / written-answer rows (which already have correct_answer) untouched.
        const patched = patchWithAnswerKey(
          merged,
          answerKey,
          docAnalysis?.page_map ?? [],
          (qn) => inAnswerKeyRegion(qn),
        );
        merged = patched.batch;
        completePhase("answer_key", { entries: answerKey.entries });
      } else {
        completePhase("answer_key", { note: "No key images found" });
      }
    } else {
      skipPhase(
        "answer_key",
        "Answer Key",
        "ai",
        format !== "answer_key_at_end" ? `Format is ${format ?? "not set"} — only runs for answer_key_at_end` : "No trailing pages identified",
      );
    }

    // 9. Solver + Compare (Review and Answer modes, MCQ only)
    let compareSummary: ReturnType<typeof compareAll>["summary"] | null = null;
    let comparedRows: ComparedRow[] | null = null;
    let aiNeedsReviewCount = 0;
    if (mode === "review" || mode === "answer") {
      reportProgress(onProgress, { stage: "solver", message: "Solving questions independently…" });
      const solverModel = modelForStage("solver_model", settings);
      beginPhase("solve", "Solve", "ai", { modelId: solverModel, mode });

      const allRows: ExtractedRow[] = [];
      const solverQuestions: SolverQuestion[] = [];
      for (const page of merged.pages) {
        for (const row of page.rows) {
          if (row.question_number == null) {
            row.question_number = `p${page.page_number}_r${page.rows.indexOf(row)}`;
          }
          allRows.push(row);
          const stemImg = pageImageByNumber.get(page.page_number);
          if (!stemImg) continue;
          const images: SolverPageImage[] = [
            { pageNumber: stemImg.pageNumber, base64: stemImg.base64, mimeType: "image/jpeg" },
          ];
          if (row.is_partial) {
            const cont = pageImageByNumber.get(page.page_number + 1);
            if (cont) {
              images.push({ pageNumber: cont.pageNumber, base64: cont.base64, mimeType: "image/jpeg" });
            }
          }
          solverQuestions.push({ row, pageImages: images });
        }
      }

      const solverBatches = planSolverBatches(solverQuestions);
      const solverResponses = [];
      for (let i = 0; i < solverBatches.length; i++) {
        if (signal?.aborted) throw new Error("aborted");
        const batch = solverBatches[i];
        const response = await runSolverBatch({
          apiKey,
          modelId: solverModel,
          questions: batch,
          signal,
        });
        await cache.saveBatch(cacheKey, "solver", i, response);
        solverResponses.push(response);
        reportProgress(onProgress, {
          stage: "solver",
          message: `Solved batch ${i + 1}/${solverBatches.length}`,
          done: i + 1,
          total: solverBatches.length,
        });
      }
      const solverMap = indexSolverResults(solverResponses);
      completePhase("solve", {
        questionCount: allRows.length,
        batchCount: solverBatches.length,
        answers: solverResponses.flatMap((r) => (r as { questions?: unknown[] }).questions ?? []),
      });

      // 10. Compare (Review mode only)
      if (mode === "review") {
        reportProgress(onProgress, { stage: "compare", message: "Comparing marked vs AI answers…" });
        beginPhase("compare", "Compare", "system", { rowCount: allRows.length });
        const result = compareAll(allRows, solverMap);
        comparedRows = result.rows;
        compareSummary = result.summary;
        completePhase("compare", { summary: compareSummary, rows: comparedRows });
      } else {
        skipPhase("compare", "Compare", "system", `Mode is ${mode} — Compare only runs in review mode`);
        comparedRows = allRows.map((row) => {
          const solved = solverMap.get(String(row.question_number ?? ""));
          if (solved) {
            return {
              ...row,
              ai_answer: solved.ai_answer,
              ai_explanation: solved.ai_explanation,
              ai_confidence: solved.ai_confidence,
              agreement: null,
              disagreement_reason: null,
              ai_declined: solved.ai_answer === null,
            } as ComparedRow;
          }
          return {
            ...row,
            ai_answer: null,
            ai_explanation: "",
            ai_confidence: 0,
            agreement: null,
            disagreement_reason: null,
            ai_declined: false,
          } as ComparedRow;
        });
      }
      for (const r of comparedRows) {
        if (typeof r.ai_confidence === "number" && r.ai_confidence < VALIDATOR_CONFIDENCE_THRESHOLD) {
          aiNeedsReviewCount += 1;
        }
      }
    } else {
      skipPhase("solve", "Solve", "ai", `Mode is ${mode} — solver only runs in review/answer mode`);
      skipPhase("compare", "Compare", "system", `Solver did not run`);
    }

    // 10.4 — Cross-check extractor figures against the analyzer's per-question image counts.
    // The analyzer reports how many images each question should have; if the extractor found a
    // different number, flag the row for review so a human can confirm the crops.
    const expectedByQuestion = new Map<string, number>();
    if (docAnalysis) {
      for (const pm of docAnalysis.page_map) {
        for (const img of pm.images ?? []) {
          if (img.question_number == null) continue;
          const qn = String(img.question_number);
          expectedByQuestion.set(qn, (expectedByQuestion.get(qn) ?? 0) + 1);
        }
      }
    }
    const imageMismatches: Array<{ question_number: string; expected: number; actual: number }> = [];
    if (expectedByQuestion.size > 0) {
      const actualByQuestion = new Map<string, number>();
      const rowsByQuestion = new Map<string, ExtractedRow[]>();
      for (const page of merged.pages) {
        for (const row of page.rows) {
          const qn = String(row.question_number ?? "");
          const figs = (row.figures as FigureBounds[] | undefined)?.length ?? 0;
          actualByQuestion.set(qn, (actualByQuestion.get(qn) ?? 0) + figs);
          const list = rowsByQuestion.get(qn) ?? [];
          list.push(row);
          rowsByQuestion.set(qn, list);
        }
      }
      const allQns = new Set<string>([...expectedByQuestion.keys(), ...actualByQuestion.keys()]);
      for (const qn of allQns) {
        const expected = expectedByQuestion.get(qn) ?? 0;
        const actual = actualByQuestion.get(qn) ?? 0;
        if (expected === actual) continue;
        imageMismatches.push({ question_number: qn, expected, actual });
        const note = `image count mismatch: analyzer expected ${expected}, extractor found ${actual}`;
        for (const row of rowsByQuestion.get(qn) ?? []) {
          (row as Record<string, unknown>).image_count_mismatch = true;
          const existing = (row.notes as string | undefined) ?? "";
          row.notes = existing ? `${existing} · ${note}` : note;
        }
      }
      if (imageMismatches.length > 0) {
        console.warn(`[crop_figures] ${imageMismatches.length} question(s) with image-count mismatch`, imageMismatches);
      }
    }

    // 10.5 — Crop figures.
    // Crops are re-rendered fresh from the PDF at a higher DPI than the page
    // raster (which is capped for the model), then the same per-page skew
    // correction is re-applied so the normalized boxes still line up.
    const figureJobs: CropJob[] = [];
    const jobToFigure = new Map<string, { row: ExtractedRow; idx: number }>();
    const figDir = await figuresDir(cacheKey);
    const cropRenderDpi = Math.max(settings.dpi * 2, 400);

    for (const page of merged.pages) {
      const rasterPage = raster.pages.find((p) => p.page_number === page.page_number);
      if (!rasterPage || rasterPage.skipped) continue;
      for (const row of page.rows) {
        const figs = (row as ExtractedRow).figures as FigureBounds[] | undefined;
        if (!figs?.length) continue;
        figs.forEach((fb, i) => {
          const qn = String(row.question_number ?? `p${page.page_number}_r${page.rows.indexOf(row)}`);
          const safeQn = qn.replace(/[^a-zA-Z0-9_-]/g, "_");
          const jobId = `p${page.page_number}_q${safeQn}_f${i}`;
          const destPath = `${figDir}/${jobId}.jpg`;
          figureJobs.push({
            jobId,
            pdfPath,
            pageNumber: page.page_number,
            destPath,
            renderDpi: cropRenderDpi,
            skewAngleDeg: rasterPage.skew_angle_deg ?? 0,
            ymin: fb.ymin,
            xmin: fb.xmin,
            ymax: fb.ymax,
            xmax: fb.xmax,
          });
          jobToFigure.set(jobId, { row, idx: i });
        });
      }
    }

    if (figureJobs.length > 0) {
      beginPhase("crop_figures", "Crop Figures", "system", {
        count: figureJobs.length,
        figuresDir: figDir,
      });
      const results = await cropFiguresBatch(figureJobs);
      let okCount = 0;
      let failCount = 0;
      for (const r of results) {
        const entry = jobToFigure.get(r.jobId);
        if (!entry) continue;
        const figs = entry.row.figures as any[];
        if (figs && figs[entry.idx]) {
          if (r.ok) {
            figs[entry.idx].path = figureJobs.find((j) => j.jobId === r.jobId)!.destPath;
            okCount++;
          } else {
            figs[entry.idx].crop_error = r.error ?? "unknown";
            failCount++;
            console.warn(`[crop_figures] ${r.jobId}: ${r.error}`);
          }
        }
      }
      completePhase("crop_figures", {
        okCount,
        failCount,
        imageMismatches,
        results: results.map((r) => {
          const job = figureJobs.find((j) => j.jobId === r.jobId);
          return {
            jobId: r.jobId,
            ok: r.ok,
            error: r.error,
            width: r.width,
            height: r.height,
            path: job?.destPath,
          };
        }),
      });
    } else if (imageMismatches.length > 0) {
      // No figure boxes from the extractor, but the analyzer expected some — record the gap.
      beginPhase("crop_figures", "Crop Figures", "system", { count: 0, figuresDir: figDir });
      completePhase("crop_figures", { okCount: 0, failCount: 0, results: [], imageMismatches });
    } else {
      skipPhase("crop_figures", "Crop Figures", "system", "No figures detected");
    }

    // 11. Persist all rows to cache for the Review UI
    reportProgress(onProgress, { stage: "persist", message: "Saving rows to cache…" });
    let totalRows = 0;
    const finalPages = merged.pages.map((page) => {
      const enrichedRows = page.rows.map((row) => {
        if (comparedRows) {
          const qn = String(row.question_number ?? "");
          const found = comparedRows.find((r) => String(r.question_number ?? "") === qn);
          return found ?? row;
        }
        return row;
      });
      return { ...page, rows: enrichedRows };
    });

    beginPhase("persist", "Persist", "system", { cacheKey, pages: finalPages });

    // Detect extraction cross-contamination: the same stem appearing under different
    // question numbers (a model carrying one question's text onto another). Flag both
    // for review and stamp them so the Review UI can surface it.
    const duplicateRowKeys = findDuplicateQuestionRows(finalPages);

    const records: SqliteRowRecord[] = [];
    for (const page of finalPages) {
      for (let rIdx = 0; rIdx < page.rows.length; rIdx++) {
        const row = page.rows[rIdx];
        const isDuplicate = duplicateRowKeys.has(`${page.page_number}:${rIdx}`);
        if (isDuplicate) (row as Record<string, unknown>).duplicate_suspected = true;
        const needs_review =
          isDuplicate ||
          (typeof row.confidence === "number" && row.confidence < VALIDATOR_CONFIDENCE_THRESHOLD) ||
          (row as Record<string, unknown>).image_count_mismatch === true;
        const ai_needs_review =
          typeof (row as ComparedRow).ai_confidence === "number" &&
          (row as ComparedRow).ai_confidence! < VALIDATOR_CONFIDENCE_THRESHOLD &&
          (mode === "review" || mode === "answer");
        records.push({
          cache_key: cacheKey,
          page_number: page.page_number,
          row_index_within_page: rIdx,
          canonical_json: row,
          needs_review,
          ai_needs_review,
          user_edited: false,
          merged_from_pages: (row as unknown as { merged_from_pages?: number[] }).merged_from_pages ?? null,
          awaiting_answer_key: false,
        });
        totalRows += 1;
      }
    }
    await saveRows(records);

    const allRowsOut: ExtractedRow[] = finalPages.flatMap((p) => p.rows);
    completePhase("persist", { totalRows, cacheKey, rows: allRowsOut });

    await upsertRun({
      cache_key: cacheKey,
      pdf_sha256: pdfSha256,
      schema_hash: sHash,
      mode,
      content_type: schema.content_type,
      confirmed_format: format,
      state: "completed",
      finished_at: new Date().toISOString(),
    });

    reportProgress(onProgress, {
      stage: "done",
      message: `Done — ${totalRows} row${totalRows === 1 ? "" : "s"} produced.`,
    });

    const enrichedFailedPages: SplitFailure[] = allFailedPages.map((f) => {
      const img = pageImageByNumber.get(f.pageNumber);
      return {
        ...f,
        imageBase64: img?.base64,
        mimeType: img?.mimeType ?? "image/jpeg",
      };
    });

    finishTrace();

    return {
      cacheKey,
      rows: allRowsOut,
      pages: finalPages,
      summary: {
        pageCount: raster.pages.length,
        rowCount: totalRows,
        needsReviewCount,
        aiNeedsReviewCount,
        failedPagesCount: enrichedFailedPages.length,
      },
      failedPages: enrichedFailedPages,
      compareSummary,
      answerKey,
    };
  } catch (err) {
    finishTrace();
    await upsertRun({
      cache_key: cacheKey,
      state: "crashed",
      finished_at: new Date().toISOString(),
    });
    throw err;
  }
}

async function runExtractorVariant(args: {
  apiKey: string;
  modelId: ModelId;
  schema: Schema;
  mode: RunMode;
  format: ExamFormat | null;
  pages: ExtractorPageInput[];
  signal?: AbortSignal;
}): Promise<ExtractedBatch> {
  const { mode, format } = args;
  if (mode === "answer") {
    return runAnswerKeyBodyExtractor(args);
  }
  switch (format) {
    case "inline_marked":
      return runInlineMarkedExtractor(args);
    case "written_answer":
      return runWrittenAnswerExtractor(args);
    case "answer_key_at_end":
      return runAnswerKeyBodyExtractor(args);
    default:
      return runInlineMarkedExtractor(args);
  }
}

// ─── Post-generation conversion ────────────────────────────────────────────────

export interface RunConversionArgs {
  apiKey: string;
  schema: Schema;
  settings: AppSettings;
  cacheKey: string;
  /** All rasterized page inputs (base64). Only the pages with non-MCQ questions are fed in. */
  pageImages: ExtractorPageInput[];
  analysis: DocumentAnalysisResult;
  /** Pages from the prior run, used to offset row_index so converted rows don't collide. */
  existingPages: ExtractedPage[];
  /** Options per generated MCQ (conversions only). 0/undefined → natural set size. */
  optionCount?: number;
  onProgress?: ProgressFn;
  signal?: AbortSignal;
}

export interface ConversionResult {
  addedRows: ExtractedRow[];
  addedCount: number;
}

/**
 * Opt-in post-generation step: recast the document's non-MCQ questions (matching, written,
 * true/false) into MCQ rows shaped to `schema` and append them to the existing run's cached
 * rows. One converter handles every source type. Converted rows are flagged `needs_review`
 * (AI-recast) and carry `converted_from` provenance. No-op when the analysis found none.
 */
export async function runConversion(args: RunConversionArgs): Promise<ConversionResult> {
  const { apiKey, schema, settings, cacheKey, pageImages, analysis, existingPages } = args;

  // Send EVERY question-bearing page to the converter and let it skip questions already in
  // standard MCQ form. This avoids depending on the analyzer's per-type counts (unreliable for
  // true/false), so nothing is missed because the analyzer mis-tagged a question's type.
  const targetPageNumbers = questionPages(analysis);
  const convertPages = pageImages.filter((p) => targetPageNumbers.includes(p.pageNumber));
  if (convertPages.length === 0) return { addedRows: [], addedCount: 0 };

  const modelId = (settings.extractor_model ?? settings.primary_model) as ModelId | null;
  if (!modelId) throw new Error("No extractor model configured for conversion.");

  reportProgress(args.onProgress, {
    stage: "convert",
    message: "Normalizing non-MCQ questions to MCQ…",
  });

  const batch = await runConversionToMcq({
    apiKey,
    modelId,
    schema,
    pages: convertPages,
    optionCount: args.optionCount,
    signal: args.signal,
  });

  // Dedup safety net: if the converter re-emits a question that already exists (it was
  // supposed to skip real MCQs), drop it rather than duplicate. Matched on normalized stem.
  const existingStems = new Set<string>();
  for (const page of existingPages) {
    for (const row of page.rows) {
      const stem = normalizeStem(row.question_text);
      if (stem.length >= 12) existingStems.add(stem);
    }
  }

  // Append after existing rows on each page so PKs (cache_key, page, row_index) don't collide.
  const nextIndexByPage = new Map<number, number>();
  for (const p of existingPages) nextIndexByPage.set(p.page_number, p.rows.length);

  const records: SqliteRowRecord[] = [];
  const addedRows: ExtractedRow[] = [];
  for (const page of batch.pages) {
    let idx = nextIndexByPage.get(page.page_number) ?? 0;
    for (const row of page.rows) {
      const stem = normalizeStem(row.question_text);
      if (stem.length >= 12 && existingStems.has(stem)) continue; // already present — skip
      // The conversion path doesn't run figure-cropping; drop any boxes the model emitted.
      delete (row as Record<string, unknown>).figures;
      records.push({
        cache_key: cacheKey,
        page_number: page.page_number,
        row_index_within_page: idx,
        canonical_json: row,
        needs_review: true,
        ai_needs_review: false,
        user_edited: false,
        merged_from_pages: null,
        awaiting_answer_key: false,
      });
      addedRows.push(row);
      if (stem.length >= 12) existingStems.add(stem); // also dedup within this batch
      idx += 1;
    }
    nextIndexByPage.set(page.page_number, idx);
  }

  if (records.length > 0) await saveRows(records);

  reportProgress(args.onProgress, {
    stage: "convert",
    message: `Added ${records.length} converted MCQ row${records.length === 1 ? "" : "s"}.`,
  });

  return { addedRows, addedCount: records.length };
}

// ─── Post-generation answer fill ───────────────────────────────────────────────

export interface RunAnswerFillArgs {
  apiKey: string;
  schema: Schema;
  settings: AppSettings;
  cacheKey: string;
  pageImages: ExtractorPageInput[];
  /** Pages from the prior run — answers are merged into these by question_number. */
  existingPages: ExtractedPage[];
  onProgress?: ProgressFn;
  signal?: AbortSignal;
}

export interface AnswerFillResult {
  filledCount: number;
}

/** A value is "empty" if the extraction left nothing usable in that field. */
function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

/**
 * Opt-in post-generation step: have the AI answer every question from its own knowledge and
 * fill any answer field that extraction left empty (e.g. a `no_answers` document). Only empty
 * fields are overlaid — populated extraction data is never clobbered. Filled rows are stamped
 * `ai_generated` and flagged `needs_review`. Schema-agnostic: whatever answer field the schema
 * defines (`correct_answer`, `correct_index`, a written answer) gets filled if the model
 * supplies it and the row lacked it.
 */
export async function runAnswerFill(args: RunAnswerFillArgs): Promise<AnswerFillResult> {
  const { apiKey, schema, settings, cacheKey, pageImages, existingPages } = args;
  if (existingPages.length === 0) return { filledCount: 0 };

  const modelId = (settings.solver_model ?? settings.primary_model) as ModelId | null;
  if (!modelId) throw new Error("No model configured for answer fill.");

  reportProgress(args.onProgress, { stage: "answer_fill", message: "Answering questions with AI…" });

  const batch = await runAnswerFillExtractor({
    apiKey,
    modelId,
    schema,
    pages: pageImages,
    signal: args.signal,
  });

  // Index the AI's answers by question number.
  const answerByQn = new Map<string, ExtractedRow>();
  for (const page of batch.pages) {
    for (const row of page.rows) {
      answerByQn.set(String(row.question_number ?? ""), row);
    }
  }

  const records: SqliteRowRecord[] = [];
  let filled = 0;
  for (const page of existingPages) {
    for (let rIdx = 0; rIdx < page.rows.length; rIdx++) {
      const existing = page.rows[rIdx];
      const answer = answerByQn.get(String(existing.question_number ?? ""));
      if (!answer) continue;

      // Overlay only fields the extraction left empty — never overwrite real data.
      const merged: ExtractedRow = { ...existing };
      let changed = false;
      for (const [key, value] of Object.entries(answer)) {
        if (key === "question_number" || key === "question_text") continue;
        if (isEmptyValue(merged[key]) && !isEmptyValue(value)) {
          merged[key] = value;
          changed = true;
        }
      }
      if (!changed) continue;

      (merged as Record<string, unknown>).ai_generated = true;
      filled += 1;
      records.push({
        cache_key: cacheKey,
        page_number: page.page_number,
        row_index_within_page: rIdx,
        canonical_json: merged,
        needs_review: true,
        ai_needs_review: false,
        user_edited: false,
        merged_from_pages: (existing as unknown as { merged_from_pages?: number[] }).merged_from_pages ?? null,
        awaiting_answer_key: false,
      });
    }
  }

  if (records.length > 0) await saveRows(records);

  reportProgress(args.onProgress, {
    stage: "answer_fill",
    message: `Filled answers for ${filled} question${filled === 1 ? "" : "s"}.`,
  });

  return { filledCount: filled };
}
