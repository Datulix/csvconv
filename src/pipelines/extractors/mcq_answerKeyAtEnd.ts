import { z } from "zod";
import { callModel, type ContentPart, type ResponseSchema } from "../../lib/modelClient";
import type { ModelId } from "../../lib/models";
import type { Schema } from "../../schema/types";
import {
  ANSWER_KEY_PARSER_PROMPT,
  MCQ_ANSWER_KEY_BODY_PROMPT,
  OPTION_LETTERS,
  STRICT_JSON_REMINDER,
} from "../prompts";
import {
  buildCustomFieldsPromptBlock,
  buildMcqResponseSchema,
  buildMcqZodSchema,
} from "./schemaBuilders";
import { pageImageHint, type ExtractedBatch, type ExtractorPageInput, type OptionLetter } from "./types";
import type { PageMapEntry } from "../documentAnalyzer";
import { parseQuestionNumber, segmentNumberingRuns } from "../sections";

/**
 * Two-phase MCQ extractor for answer_key_at_end format.
 *
 * Phase 1 (body): runs on the question pages. Produces rows with correct_answer=null
 * and awaiting_answer_key=true flagged in audit (the orchestrator records this metadata).
 *
 * Phase 2 (answer-key parser): runs on the trailing answer-key pages. Produces a
 * `{question_number → letter, confidence}` map.
 *
 * Phase 3 (patch): the orchestrator joins the map onto the body rows, setting
 * correct_answer and clearing awaiting_answer_key.
 */

export interface RunAnswerKeyBodyExtractorArgs {
  apiKey: string;
  modelId: ModelId;
  schema: Schema;
  pages: ExtractorPageInput[];
  signal?: AbortSignal;
}

export function buildAnswerKeyBodyPrompt(schema: Schema): string {
  return MCQ_ANSWER_KEY_BODY_PROMPT + buildCustomFieldsPromptBlock(schema) + STRICT_JSON_REMINDER;
}

export async function runAnswerKeyBodyExtractor(
  args: RunAnswerKeyBodyExtractorArgs,
): Promise<ExtractedBatch> {
  if (args.pages.length === 0) {
    throw new Error("runAnswerKeyBodyExtractor: no pages provided");
  }

  const systemInstruction = buildAnswerKeyBodyPrompt(args.schema);
  const responseSchema = buildMcqResponseSchema(args.schema);
  const zodSchema = buildMcqZodSchema(args.schema);

  const parts: ContentPart[] = [];
  for (const page of args.pages) {
    parts.push({ kind: "text", text: `PAGE ${page.pageNumber}${pageImageHint(page)}:` });
    parts.push({
      kind: "image",
      mimeType: page.mimeType ?? "image/jpeg",
      base64: page.base64,
    });
  }

  const result = await callModel<ExtractedBatch>(
    {
      modelId: args.modelId,
      apiKey: args.apiKey,
      systemInstruction,
      parts,
      responseSchema,
      signal: args.signal,
    },
    zodSchema as unknown as Parameters<typeof callModel<ExtractedBatch>>[1],
  );

  // Force correct_answer=null and awaiting_answer_key semantics on every row.
  for (const page of result.data.pages) {
    for (const row of page.rows) {
      row.correct_answer = null;
      row.marking_style = "none";
    }
  }

  return result.data;
}

/** Schema for one entry parsed out of an answer-key page. */
export const AnswerKeyEntrySchema = z.object({
  question_number: z.string(),
  section: z.string().optional(),
  answer: z.enum(OPTION_LETTERS),
  confidence: z.number().min(0).max(1),
  notes: z.string().optional(),
});
export type AnswerKeyEntry = z.infer<typeof AnswerKeyEntrySchema>;

export const AnswerKeyResultSchema = z.object({
  entries: z.array(AnswerKeyEntrySchema),
});
export type AnswerKeyResult = z.infer<typeof AnswerKeyResultSchema>;

const ANSWER_KEY_RESPONSE_SCHEMA: ResponseSchema = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question_number: { type: "string" },
          section: { type: "string" },
          answer: { type: "string", enum: [...OPTION_LETTERS] },
          confidence: { type: "number" },
          notes: { type: "string" },
        },
        required: ["question_number", "answer", "confidence"],
      },
    },
  },
  required: ["entries"],
};

export interface RunAnswerKeyParserArgs {
  apiKey: string;
  modelId: ModelId;
  /** Trailing pages of the PDF that contain the answer key. */
  pages: ExtractorPageInput[];
  signal?: AbortSignal;
}

export async function runAnswerKeyParser(args: RunAnswerKeyParserArgs): Promise<AnswerKeyResult> {
  if (args.pages.length === 0) {
    throw new Error("runAnswerKeyParser: no pages provided");
  }

  const parts: ContentPart[] = [];
  for (const page of args.pages) {
    parts.push({ kind: "text", text: `PAGE ${page.pageNumber}:` });
    parts.push({
      kind: "image",
      mimeType: page.mimeType ?? "image/jpeg",
      base64: page.base64,
    });
  }

  const result = await callModel<AnswerKeyResult>(
    {
      modelId: args.modelId,
      apiKey: args.apiKey,
      systemInstruction: ANSWER_KEY_PARSER_PROMPT,
      parts,
      responseSchema: ANSWER_KEY_RESPONSE_SCHEMA,
      signal: args.signal,
    },
    AnswerKeyResultSchema,
  );

  return result.data;
}

/**
 * Apply an answer-key map onto body-extracted rows in-place. Returns counts for the
 * orchestrator to record in audit (matched, unmatched body rows, unmatched key entries).
 *
 * When the key has section-labeled entries (multi-section exams), lookup uses a compound
 * key `"<section>::<question_number>"`. The page map from document analysis is used to
 * derive which section each body page belongs to, enabling correct cross-section matching.
 * Falls back to bare question_number lookup when sections are absent.
 */
export interface PatchSummary {
  matched: number;
  unmatchedBodyRows: Array<{ page_number: number; question_number: string }>;
  unmatchedKeyEntries: AnswerKeyEntry[];
  /** Which matching strategy was used — recorded in the phase trace for diagnosis. */
  strategy: "section-paired" | "section-label" | "bare-number-with-flags" | "single-section";
  has_sections: boolean;
  body_run_lengths: number[];
  key_run_lengths: number[];
}

function compoundKey(section: string | null | undefined, qn: string): string {
  return section ? `${section}::${qn}` : qn;
}

export function patchWithAnswerKey(
  body: ExtractedBatch,
  key: AnswerKeyResult,
  pageMap: PageMapEntry[] = [],
  /**
   * Optional predicate restricting which body rows are eligible for patching. Used for
   * mixed-format documents where only a sub-range of questions uses answer_key_at_end —
   * rows outside that range (e.g. inline-marked questions) are left untouched. Defaults
   * to patching every row.
   */
  isPatchable: (questionNumber: string, pageNumber: number) => boolean = () => true,
): { batch: ExtractedBatch; summary: PatchSummary } {
  // Build a page-number → section_label lookup from the document analysis page map
  const pageSectionMap = new Map<number, string | null>();
  for (const entry of pageMap) {
    pageSectionMap.set(entry.page_number, entry.section_label ?? null);
  }

  // Build keyMap with compound keys when sections are present
  const keyMap = new Map<string, AnswerKeyEntry>();
  const hasSections = key.entries.some((e) => e.section);
  for (const entry of key.entries) {
    keyMap.set(compoundKey(hasSections ? entry.section : null, entry.question_number), entry);
  }

  const matchedKeys = new Set<string>();
  let matched = 0;
  const unmatchedBodyRows: Array<{ page_number: number; question_number: string }> = [];

  const addNote = (row: ExtractedBatch["pages"][number]["rows"][number], note: string) => {
    const existing = (row.notes as string | undefined) ?? "";
    row.notes = existing ? `${existing} · ${note}` : note;
  };
  const applyEntry = (
    row: ExtractedBatch["pages"][number]["rows"][number],
    entry: AnswerKeyEntry,
  ) => {
    row.correct_answer = entry.answer as OptionLetter;
    // Keep the schema's 0-based index field in sync with the answer letter. In answer_key_at_end
    // mode the body extractor can't see the answer, so it leaves correct_index at its default (0);
    // once the key supplies the letter the index must be recomputed, or the exported correct_index
    // column stays wrong. Mirrors the ReviewTable "use AI" convention (letter → ABCDE ordinal).
    const letterIndex = OPTION_LETTERS.indexOf(entry.answer);
    if ("correct_index" in row && letterIndex >= 0) {
      (row as Record<string, unknown>).correct_index = letterIndex;
    }
    if (typeof row.confidence === "number") {
      row.confidence = Math.min(row.confidence, entry.confidence);
    } else {
      row.confidence = entry.confidence;
    }
    if (entry.notes) addNote(row, `key: ${entry.notes}`);
    matchedKeys.add(compoundKey(hasSections ? entry.section : null, entry.question_number));
    matched += 1;
  };

  // Collect patchable rows in document order (page, then row index within page).
  const patchable: Array<{ pageNumber: number; section: string | null; qn: string; row: ExtractedBatch["pages"][number]["rows"][number] }> = [];
  for (const page of [...body.pages].sort((a, b) => a.page_number - b.page_number)) {
    const pageSection = pageSectionMap.get(page.page_number) ?? null;
    for (const row of page.rows) {
      const qn = String(row.question_number ?? "");
      // Skip rows outside the answer-key region(s) — e.g. inline-marked questions in a
      // mixed-format document that already have their own correct_answer.
      if (!isPatchable(qn, page.page_number)) continue;
      patchable.push({ pageNumber: page.page_number, section: pageSection, qn, row });
    }
  }

  // Detect multi-section numbering collisions: the same question_number appearing on more
  // than one patchable row (e.g. each section restarts at Q1).
  const qnCounts = new Map<string, number>();
  for (const p of patchable) qnCounts.set(p.qn, (qnCounts.get(p.qn) ?? 0) + 1);
  const hasDuplicateQns = [...qnCounts.values()].some((c) => c > 1);

  // Per-row matcher for single-section docs (and the fallback for labeled multi-section docs
  // whose run structure we couldn't align positionally).
  const matchBySectionOrNumber = (p: (typeof patchable)[number]) => {
    const entry =
      keyMap.get(compoundKey(hasSections ? p.section : null, p.qn)) ??
      (hasSections ? keyMap.get(p.qn) : undefined);
    if (entry) applyEntry(p.row, entry);
    else {
      addNote(p.row, "no entry in answer key");
      unmatchedBodyRows.push({ page_number: p.pageNumber, question_number: p.qn });
    }
  };

  let strategy: PatchSummary["strategy"] = "single-section";
  let bodyRunLengths: number[] = [];
  let keyRunLengths: number[] = [];

  if (hasDuplicateQns) {
    // Multi-section exam (numbering repeats across sections). Bare question_number is ambiguous,
    // and section LABELS are unreliable: the key's labels come from a different AI pass than the
    // body's page sections, so the two frequently don't match and label-based matching drops many
    // rows. So we prefer POSITIONAL run matching: segment both sides into numbering-runs (a run =
    // a section, ending where the count resets) and, when the per-run lengths line up in order,
    // assign each section's answers by position. This is label-independent and robust to
    // formatting (key as one continuous list vs. body spanning pages). Section labels are only a
    // fallback for when the run structure can't be aligned. The per-section AI-agreement validator
    // in the compare stage is the backstop that catches a key whose sections were out of order.
    const bodyRuns = segmentNumberingRuns(patchable, (p) => parseQuestionNumber(p.qn));
    const keyRuns = segmentNumberingRuns(key.entries, (e) => parseQuestionNumber(e.question_number));
    bodyRunLengths = bodyRuns.map((r) => r.length);
    keyRunLengths = keyRuns.map((r) => r.length);

    if (bodyRuns.length === keyRuns.length) {
      // Same number of sections: pair section-run i <-> key-run i (answer keys are listed in
      // document order), then WITHIN each section match by question_number. Within a section
      // numbers are unique, so this tolerates the vision model occasionally misreading a few
      // answers — a missing or extra key entry leaves only that one question unfilled instead of
      // breaking the whole section's alignment (which a blind position-by-position match would).
      strategy = "section-paired";
      for (let i = 0; i < bodyRuns.length; i++) {
        const keyByQn = new Map<string, AnswerKeyEntry>();
        for (const e of keyRuns[i]) keyByQn.set(String(e.question_number ?? ""), e);
        for (const p of bodyRuns[i]) {
          const entry = keyByQn.get(p.qn);
          if (entry) applyEntry(p.row, entry);
          else {
            addNote(p.row, "no entry in answer key");
            unmatchedBodyRows.push({ page_number: p.pageNumber, question_number: p.qn });
          }
        }
      }
    } else if (hasSections) {
      // Run structure couldn't be aligned, but the key carries section labels — try those.
      strategy = "section-label";
      for (const p of patchable) matchBySectionOrNumber(p);
    } else {
      strategy = "bare-number-with-flags";
      // No labels and no structural alignment: refuse to guess on the duplicated numbers (leave
      // null + flag for review), but still match any unique numbers by their bare question_number.
      for (const p of patchable) {
        if ((qnCounts.get(p.qn) ?? 0) > 1) {
          (p.row as Record<string, unknown>).answer_key_unresolved = true;
          addNote(p.row, "ambiguous answer-key match (multi-section, no section labels) — needs review");
          unmatchedBodyRows.push({ page_number: p.pageNumber, question_number: p.qn });
        } else {
          const entry = keyMap.get(p.qn);
          if (entry) applyEntry(p.row, entry);
          else {
            addNote(p.row, "no entry in answer key");
            unmatchedBodyRows.push({ page_number: p.pageNumber, question_number: p.qn });
          }
        }
      }
    }
  } else {
    // Single-section document: section-aware compound match (or bare question_number).
    for (const p of patchable) matchBySectionOrNumber(p);
  }

  const unmatchedKeyEntries = key.entries.filter(
    (e) => !matchedKeys.has(compoundKey(hasSections ? e.section : null, e.question_number)),
  );

  return {
    batch: body,
    summary: {
      matched,
      unmatchedBodyRows,
      unmatchedKeyEntries,
      strategy,
      has_sections: hasSections,
      body_run_lengths: bodyRunLengths,
      key_run_lengths: keyRunLengths,
    },
  };
}

/** Heuristic for which pages are likely the answer-key pages: last 5% or last 5, capped at 20. */
export function pickAnswerKeyPages(totalPages: number): number[] {
  if (totalPages <= 0) return [];
  if (totalPages <= 3) return [totalPages];
  const fivePercent = Math.ceil(totalPages * 0.05);
  const count = Math.min(20, Math.max(5, fivePercent));
  const start = Math.max(1, totalPages - count + 1);
  const result: number[] = [];
  for (let p = start; p <= totalPages; p++) result.push(p);
  return result;
}
