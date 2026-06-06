import { callModel, type ContentPart } from "../../lib/modelClient";
import type { ModelId } from "../../lib/models";
import type { Schema } from "../../schema/types";
import { ANSWER_FILL_PROMPT, STRICT_JSON_REMINDER } from "../prompts";
import {
  buildCustomFieldsPromptBlock,
  buildMcqResponseSchema,
  buildMcqZodSchema,
} from "./schemaBuilders";
import { pageImageHint, type ExtractedBatch, type ExtractorPageInput } from "./types";

export interface RunAnswerFillExtractorArgs {
  apiKey: string;
  modelId: ModelId;
  schema: Schema;
  pages: ExtractorPageInput[];
  signal?: AbortSignal;
}

/** Build the answer-fill prompt: fixed instructions + the user's custom-field block. */
export function buildAnswerFillPrompt(schema: Schema): string {
  return ANSWER_FILL_PROMPT + buildCustomFieldsPromptBlock(schema) + STRICT_JSON_REMINDER;
}

/**
 * Answer every question on the given pages from the model's own knowledge, returning rows
 * shaped to `schema` (with the answer fields filled). The orchestrator merges these answers
 * into rows whose answer fields came out empty during extraction. Reuses the MCQ response/zod
 * schema so custom answer fields (e.g. Triviadox's `correct_index`) are produced.
 */
export async function runAnswerFillExtractor(
  args: RunAnswerFillExtractorArgs,
): Promise<ExtractedBatch> {
  if (args.pages.length === 0) {
    throw new Error("runAnswerFillExtractor: no pages provided");
  }

  const systemInstruction = buildAnswerFillPrompt(args.schema);
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

  return result.data;
}
