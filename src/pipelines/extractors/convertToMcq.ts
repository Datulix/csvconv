import { callModel, type ContentPart } from "../../lib/modelClient";
import type { ModelId } from "../../lib/models";
import type { Schema } from "../../schema/types";
import { CONVERT_TO_MCQ_PROMPT, STRICT_JSON_REMINDER } from "../prompts";
import {
  buildCustomFieldsPromptBlock,
  buildMcqResponseSchema,
  buildMcqZodSchema,
} from "./schemaBuilders";
import { pageImageHint, type ExtractedBatch, type ExtractorPageInput } from "./types";

/** Marker stamped on rows produced by a conversion pass, for provenance/audit. */
export const CONVERTED_FROM_KEY = "converted_from";
/** The original question number a converted row was derived from. */
export const SOURCE_QUESTION_NUMBER_KEY = "source_question_number";

export interface RunConversionToMcqArgs {
  apiKey: string;
  modelId: ModelId;
  schema: Schema;
  /** Pages containing the non-MCQ questions to convert. */
  pages: ExtractorPageInput[];
  /** Target options per generated MCQ. 0/undefined → natural set size. True/false ignores this. */
  optionCount?: number;
  signal?: AbortSignal;
}

/**
 * Build the conversion prompt: fixed multi-type recast instructions + an optional
 * option-count target + the user's custom-field block + strict-JSON reminder. One prompt
 * handles matching, written, and true/false sources.
 */
export function buildConversionPrompt(schema: Schema, optionCount?: number): string {
  let prompt = CONVERT_TO_MCQ_PROMPT;
  if (optionCount && optionCount > 1) {
    prompt += `\n\nTARGET OPTION COUNT: produce up to ${optionCount} options for matching and written MCQs when enough distinct options exist (use fewer real options rather than inventing extras for matching). True/false questions always stay at exactly 2 options.`;
  }
  return prompt + buildCustomFieldsPromptBlock(schema) + STRICT_JSON_REMINDER;
}

/**
 * Derive the originating question number from a converted row's compound number.
 * Generated MCQs are numbered "<original>.<n>", so "7.2" → "7".
 */
function sourceNumberFrom(questionNumber: unknown): string | null {
  if (typeof questionNumber !== "string") return null;
  const dot = questionNumber.lastIndexOf(".");
  return dot > 0 ? questionNumber.slice(0, dot) : questionNumber;
}

/**
 * Convert non-MCQ questions (matching, written, true/false) on the given pages into MCQ
 * rows shaped to `schema`. Reuses the MCQ response/zod schema (so custom fields like
 * Triviadox's `options` JSON array and `correct_index` flow through) plus conversion
 * provenance fields, and the model tags each row's origin. Provenance is backfilled
 * defensively if the model omits it.
 */
export async function runConversionToMcq(
  args: RunConversionToMcqArgs,
): Promise<ExtractedBatch> {
  if (args.schema.content_type !== "mcq") {
    throw new Error(
      `runConversionToMcq: schema.content_type must be "mcq", got "${args.schema.content_type}"`,
    );
  }
  if (args.pages.length === 0) {
    throw new Error("runConversionToMcq: no pages provided");
  }

  const systemInstruction = buildConversionPrompt(args.schema, args.optionCount);
  const responseSchema = buildMcqResponseSchema(args.schema, { includeConversionFields: true });
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

  // Backfill provenance defensively: the model sets converted_from, but ensure
  // source_question_number is always present so converted rows stay traceable.
  for (const page of result.data.pages) {
    for (const row of page.rows) {
      if (row[SOURCE_QUESTION_NUMBER_KEY] == null) {
        row[SOURCE_QUESTION_NUMBER_KEY] = sourceNumberFrom(row.question_number);
      }
    }
  }

  return result.data;
}
