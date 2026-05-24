import type { ModelId } from "../lib/models";
import type { AppSettings } from "../lib/settings";
import {
  rasterizePdf,
  readImageAsBase64,
  triagePdf,
} from "../lib/pdfApi";
import { invoke } from "@tauri-apps/api/core";
import type { RunMode } from "../schema/contentTypes";
import type { Schema } from "../schema/types";
import { schemaHash } from "../schema/hash";
import {
  saveRow,
  upsertRun,
  SqliteCacheBackend,
  type SqliteRowRecord,
} from "../lib/sqliteCache";
import type { ExamFormat } from "./detector";
import type { ExtractedBatch, ExtractedPage, ExtractedRow, ExtractorPageInput } from "./extractors/types";
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

function modelForStage(stage: keyof Pick<AppSettings, "detector_model" | "extractor_model" | "validator_model" | "solver_model">, settings: AppSettings): ModelId {
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
    args.settings.detector_model ?? "inherit",
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
    // 1. Triage
    reportProgress(onProgress, { stage: "triage", message: "Triaging PDF…" });
    const triage = await triagePdf(pdfPath, runId);

    // 2. Rasterize all non-blank pages (or all pages if no blanks detected)
    const blankPages = triage.pages.filter((p) => p.is_blank).map((p) => p.page_number);
    const allPages = triage.pages.map((p) => p.page_number);
    const targetPages = allPages.filter((p) => !blankPages.includes(p));
    reportProgress(onProgress, {
      stage: "rasterize",
      message: `Rasterizing ${targetPages.length} of ${allPages.length} pages…`,
      total: targetPages.length,
    });

    const deskewPairs: Array<[number, number]> = triage.pages
      .filter((p) => Math.abs(p.skew_angle_deg) >= 1.0 && p.page_type === "scanned")
      .map((p) => [p.page_number, p.skew_angle_deg]);
    const deskewPages = deskewPairs.map(([n]) => n);

    const raster = await rasterizePdf({
      path: pdfPath,
      dpi: settings.dpi,
      runId,
      deskewPages,
      skewAngles: deskewPairs,
      skipPages: blankPages,
    });

    // 3. Base64-encode page images
    reportProgress(onProgress, { stage: "encode", message: "Encoding page images…" });
    const pageImages: ExtractorPageInput[] = [];
    for (const p of raster.pages) {
      if (p.skipped || !p.path) continue;
      const base64 = await readImageAsBase64(p.path);
      pageImages.push({ pageNumber: p.page_number, base64, mimeType: "image/jpeg" });
    }
    const pageImageByNumber = new Map(pageImages.map((p) => [p.pageNumber, p]));

    if (signal?.aborted) throw new Error("aborted");

    // 4. Plan extractor batches.
    // For answer_key_at_end, skip the trailing answer-key pages from the body extractor.
    const isAnswerKey = format === "answer_key_at_end" && mode !== "answer";
    let answerKeyPageNumbers: number[] = [];
    let bodyImages = pageImages;
    if (isAnswerKey) {
      answerKeyPageNumbers = pickAnswerKeyPages(allPages.length);
      bodyImages = pageImages.filter((p) => !answerKeyPageNumbers.includes(p.pageNumber));
    }

    const batchSize = Math.max(1, settings.pages_per_batch);
    const batches = chunkPages(bodyImages, batchSize);
    reportProgress(onProgress, {
      stage: "extract",
      message: `Extracting ${batches.length} batch${batches.length === 1 ? "" : "es"}…`,
      total: batches.length,
      done: 0,
    });

    const extractorModel = modelForStage("extractor_model", settings);

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

    // 6. Merge across page boundaries
    reportProgress(onProgress, { stage: "merge", message: "Merging page-span questions…" });
    let merged = mergeAcrossPages(batchResults, { mergeSourceSnippets: true });

    // 7. Validator (only for MCQ; skip for non-MCQ content types since their extractors
    //    don't share the same row shape today).
    let needsReviewCount = 0;
    if (schema.content_type === "mcq" && settings.validator_enabled) {
      reportProgress(onProgress, { stage: "validator", message: "Re-checking low-confidence rows…" });
      const primaryModel = modelForStage("extractor_model", settings);
      const validatorModel = (settings.validator_model ?? settings.primary_model) as ModelId | null;
      const secondaryModel = validatorModel && validatorModel !== primaryModel ? validatorModel : null;

      // Run validator per-batch (matching the extractor batching).
      const variant = (format ?? "inline_marked") as McqExtractorVariant;
      const allPagesMerged: ExtractedPage[] = merged.pages;
      const validatedPages: ExtractedPage[] = [];
      for (const pageGroup of chunkPages(allPagesMerged, batchSize)) {
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
    }

    if (signal?.aborted) throw new Error("aborted");

    // 8. Answer-key parser + patch (only for answer_key_at_end format)
    let answerKey: AnswerKeyResult | null = null;
    if (isAnswerKey && answerKeyPageNumbers.length > 0) {
      reportProgress(onProgress, {
        stage: "answer_key",
        message: `Parsing answer key from ${answerKeyPageNumbers.length} trailing page${answerKeyPageNumbers.length === 1 ? "" : "s"}…`,
      });
      const keyImages = pageImages.filter((p) => answerKeyPageNumbers.includes(p.pageNumber));
      if (keyImages.length > 0) {
        answerKey = await runAnswerKeyParser({
          apiKey,
          modelId: extractorModel,
          pages: keyImages,
          signal,
        });
        const patched = patchWithAnswerKey(merged, answerKey);
        merged = patched.batch;
      }
    }

    // 9. Solver + Compare (Review and Answer modes, MCQ only)
    let compareSummary: ReturnType<typeof compareAll>["summary"] | null = null;
    let comparedRows: ComparedRow[] | null = null;
    let aiNeedsReviewCount = 0;
    if (schema.content_type === "mcq" && (mode === "review" || mode === "answer")) {
      reportProgress(onProgress, { stage: "solver", message: "Solving questions independently…" });
      const solverModel = modelForStage("solver_model", settings);

      // Build solver questions, attaching the relevant page image(s).
      const allRows: ExtractedRow[] = [];
      const solverQuestions: SolverQuestion[] = [];
      for (const page of merged.pages) {
        for (const row of page.rows) {
          // Ensure question_number is a string for the solver and downstream join.
          if (row.question_number == null) {
            row.question_number = `p${page.page_number}_r${page.rows.indexOf(row)}`;
          }
          allRows.push(row);
          const stemImg = pageImageByNumber.get(page.page_number);
          if (!stemImg) continue;
          const images: SolverPageImage[] = [
            { pageNumber: stemImg.pageNumber, base64: stemImg.base64, mimeType: "image/jpeg" },
          ];
          // is_partial → include continuation page too
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

      // 10. Compare (Review mode only)
      if (mode === "review") {
        reportProgress(onProgress, { stage: "compare", message: "Comparing marked vs AI answers…" });
        const result = compareAll(allRows, solverMap);
        comparedRows = result.rows;
        compareSummary = result.summary;
      } else {
        // Answer mode: attach ai_answer + ai_explanation + ai_confidence directly onto the row.
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
    }

    // 11. Persist all rows to cache for the Review UI
    reportProgress(onProgress, { stage: "persist", message: "Saving rows to cache…" });
    let totalRows = 0;
    const finalPages = merged.pages.map((page, _pi) => {
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

    for (const page of finalPages) {
      for (let rIdx = 0; rIdx < page.rows.length; rIdx++) {
        const row = page.rows[rIdx];
        const needs_review =
          typeof row.confidence === "number" && row.confidence < VALIDATOR_CONFIDENCE_THRESHOLD;
        const ai_needs_review =
          typeof (row as ComparedRow).ai_confidence === "number" &&
          (row as ComparedRow).ai_confidence! < VALIDATOR_CONFIDENCE_THRESHOLD &&
          (mode === "review" || mode === "answer");
        const record: SqliteRowRecord = {
          cache_key: cacheKey,
          page_number: page.page_number,
          row_index_within_page: rIdx,
          canonical_json: row,
          needs_review,
          ai_needs_review,
          user_edited: false,
          merged_from_pages: (row as unknown as { merged_from_pages?: number[] }).merged_from_pages ?? null,
          awaiting_answer_key: false,
        };
        await saveRow(record);
        totalRows += 1;
      }
    }

    const allRowsOut: ExtractedRow[] = finalPages.flatMap((p) => p.rows);

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

    // Enrich failed-page records with their JPEG so the UI can render thumbnails.
    const enrichedFailedPages: SplitFailure[] = allFailedPages.map((f) => {
      const img = pageImageByNumber.get(f.pageNumber);
      return {
        ...f,
        imageBase64: img?.base64,
        mimeType: img?.mimeType ?? "image/jpeg",
      };
    });

    return {
      cacheKey,
      rows: allRowsOut,
      pages: finalPages,
      summary: {
        pageCount: triage.pages.length,
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
    return runAnswerKeyBodyExtractor(args); // questions-only, ignore marked answers
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
