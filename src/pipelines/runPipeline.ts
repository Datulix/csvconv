import type { ModelId } from "../lib/models";
import type { AppSettings } from "../lib/settings";
import {
  rasterizePdf,
  readImageAsBase64,
  cropFiguresBatch,
  figuresDir,
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
import { runDocumentAnalyzer, type DocumentAnalysisResult } from "./documentAnalyzer";
import type { ExtractedBatch, ExtractedPage, ExtractedRow, ExtractorPageInput, FigureBounds } from "./extractors/types";
import { runInlineMarkedExtractor } from "./extractors/mcq_inlineMarked";
import { runWrittenAnswerExtractor } from "./extractors/mcq_writtenAnswer";
import {
  patchWithAnswerKey,
  pickAnswerKeyPages,
  runAnswerKeyBodyExtractor,
  runAnswerKeyParser,
  type AnswerKeyResult,
} from "./extractors/mcq_answerKeyAtEnd";
import { runFlashcardExtractor } from "./extractors/flashcard";
import { runQaPairExtractor } from "./extractors/qaPair";
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
  /** Required when content_type=mcq and mode != "answer". */
  format: ExamFormat | null;
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

function chunkPages<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function partitionBySection<T extends { pageNumber: number } | { page_number: number }>(
  items: T[],
  docAnalysis: DocumentAnalysisResult | null,
  batchSize: number,
): T[][] {
  const getPageNum = (item: T): number => {
    return "pageNumber" in item ? (item as any).pageNumber : (item as any).page_number;
  };

  if (!docAnalysis || !docAnalysis.page_map || docAnalysis.page_map.length === 0) {
    return chunkPages(items, batchSize);
  }

  const batches: T[][] = [];
  let currentSectionLabel: string | null = null;
  let currentGroup: T[] = [];

  for (const item of items) {
    const pageNum = getPageNum(item);
    const entry = docAnalysis.page_map.find((p) => p.page_number === pageNum);
    const sectionLabel = (entry?.section_label || "").trim() || null;

    if (sectionLabel === null) {
      if (currentSectionLabel !== null || currentGroup.length >= batchSize) {
        if (currentGroup.length > 0) {
          batches.push(currentGroup);
          currentGroup = [];
        }
      }
      currentSectionLabel = null;
      currentGroup.push(item);
    } else {
      if (currentSectionLabel !== sectionLabel || currentGroup.length >= batchSize) {
        if (currentGroup.length > 0) {
          batches.push(currentGroup);
          currentGroup = [];
        }
      }
      currentSectionLabel = sectionLabel;
      currentGroup.push(item);
    }
  }

  if (currentGroup.length > 0) {
    batches.push(currentGroup);
  }

  return batches;
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

  await upsertRun({
    cache_key: cacheKey,
    pdf_sha256: pdfSha256,
    schema_hash: sHash,
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

    // Annotate pageImages with has_images from document analysis page map
    if (docAnalysis) {
      const pageMapByNumber = new Map(docAnalysis.page_map.map((p) => [p.page_number, p]));
      for (const img of pageImages) {
        const entry = pageMapByNumber.get(img.pageNumber);
        if (entry) img.has_images = entry.has_images;
      }
    }

    // Derive blank pages from analyzer output (replaces triage blank-page filter)
    const blankPageNumbers = docAnalysis
      ? docAnalysis.page_map
          .filter((p) => p.content_type === "blank")
          .map((p) => p.page_number)
      : [];

    // 4. Plan extractor batches.
    // For answer_key_at_end, exclude answer-key pages from the body extractor.
    // Use exact page locations from document analysis; fall back to heuristic if unavailable.
    const isAnswerKey = format === "answer_key_at_end" && mode !== "answer";
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
    const batches = partitionBySection(bodyImages, docAnalysis, batchSize);
    reportProgress(onProgress, {
      stage: "extract",
      message: `Extracting ${batches.length} batch${batches.length === 1 ? "" : "es"}…`,
      total: batches.length,
      done: 0,
    });

    const extractorModel = modelForStage("extractor_model", settings);

    beginPhase("extract", "Extract", "ai", {
      batches: batches.map((b, i) => ({ batchIndex: i, pageNumbers: b.map((p) => p.pageNumber) })),
      modelId: extractorModel,
      format: format ?? "inferred",
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
        const callExtractor = (pagesSubset: ExtractorPageInput[]) =>
          runExtractorVariant({
            apiKey,
            modelId: extractorModel,
            schema,
            mode,
            format,
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

    // 7. Validator (only for MCQ)
    let needsReviewCount = 0;
    if (schema.content_type === "mcq" && settings.validator_enabled) {
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

      const variant: McqExtractorVariant =
        format === "written_answer" ? "written_answer"
        : format === "answer_key_at_end" ? "answer_key_at_end"
        : "inline_marked";
      const allPagesMerged: ExtractedPage[] = merged.pages;
      const validatedPages: ExtractedPage[] = [];
      for (const pageGroup of partitionBySection(allPagesMerged, docAnalysis, batchSize)) {
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
      skipPhase(
        "validate",
        "Validate",
        "ai",
        schema.content_type !== "mcq"
          ? `Content type is ${schema.content_type} — validator only runs for MCQ`
          : "Validator disabled in settings",
      );
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
        const patched = patchWithAnswerKey(merged, answerKey, docAnalysis?.page_map ?? []);
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
    if (schema.content_type === "mcq" && (mode === "review" || mode === "answer")) {
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
      skipPhase("solve", "Solve", "ai", `Mode is ${mode} and content type is ${schema.content_type} — solver only runs for MCQ in review/answer mode`);
      skipPhase("compare", "Compare", "system", `Solver did not run`);
    }

    // 10.5 — Crop figures
    const figureJobs: CropJob[] = [];
    const jobToFigure = new Map<string, { row: ExtractedRow; idx: number }>();
    const figDir = await figuresDir(cacheKey);

    for (const page of merged.pages) {
      const rasterPage = raster.pages.find((p) => p.page_number === page.page_number);
      if (!rasterPage?.path) continue;
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
            srcPath: rasterPage.path,
            destPath,
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

    const records: SqliteRowRecord[] = [];
    for (const page of finalPages) {
      for (let rIdx = 0; rIdx < page.rows.length; rIdx++) {
        const row = page.rows[rIdx];
        const needs_review =
          typeof row.confidence === "number" && row.confidence < VALIDATOR_CONFIDENCE_THRESHOLD;
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
  const { schema, mode, format } = args;
  if (schema.content_type === "flashcard") {
    return runFlashcardExtractor(args);
  }
  if (schema.content_type === "qa_pair") {
    return runQaPairExtractor(args);
  }
  // MCQ
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
