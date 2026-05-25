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
import type { ExtractedBatch, ExtractorPageInput, OptionLetter } from "./types";
import type { PageMapEntry } from "../documentAnalyzer";

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
  if (args.schema.content_type !== "mcq") {
    throw new Error(
      `runAnswerKeyBodyExtractor: schema.content_type must be "mcq", got "${args.schema.content_type}"`,
    );
  }
  if (args.pages.length === 0) {
    throw new Error("runAnswerKeyBodyExtractor: no pages provided");
  }

  const systemInstruction = buildAnswerKeyBodyPrompt(args.schema);
  const responseSchema = buildMcqResponseSchema(args.schema);
  const zodSchema = buildMcqZodSchema(args.schema);

  const parts: ContentPart[] = [];
  for (const page of args.pages) {
    parts.push({ kind: "text", text: `PAGE ${page.pageNumber}:` });
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
}

function compoundKey(section: string | null | undefined, qn: string): string {
  return section ? `${section}::${qn}` : qn;
}

export function patchWithAnswerKey(
  body: ExtractedBatch,
  key: AnswerKeyResult,
  pageMap: PageMapEntry[] = [],
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

  for (const page of body.pages) {
    const pageSection = pageSectionMap.get(page.page_number) ?? null;
    for (const row of page.rows) {
      const qn = String(row.question_number ?? "");
      // Try compound key first (section-aware), then fall back to bare question number
      const entry =
        keyMap.get(compoundKey(hasSections ? pageSection : null, qn)) ??
        (hasSections ? keyMap.get(qn) : undefined);

      if (entry) {
        const ck = compoundKey(hasSections ? entry.section : null, entry.question_number);
        row.correct_answer = entry.answer as OptionLetter;
        if (typeof row.confidence === "number") {
          row.confidence = Math.min(row.confidence, entry.confidence);
        } else {
          row.confidence = entry.confidence;
        }
        if (entry.notes) {
          const existingNotes = (row.notes as string | undefined) ?? "";
          row.notes = existingNotes ? `${existingNotes} · key: ${entry.notes}` : `key: ${entry.notes}`;
        }
        matchedKeys.add(ck);
        matched += 1;
      } else {
        const existingNotes = (row.notes as string | undefined) ?? "";
        row.notes = existingNotes
          ? `${existingNotes} · no entry in answer key`
          : "no entry in answer key";
        unmatchedBodyRows.push({
          page_number: page.page_number,
          question_number: qn,
        });
      }
    }
  }

  const unmatchedKeyEntries = key.entries.filter(
    (e) => !matchedKeys.has(compoundKey(hasSections ? e.section : null, e.question_number)),
  );

  return { batch: body, summary: { matched, unmatchedBodyRows, unmatchedKeyEntries } };
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
