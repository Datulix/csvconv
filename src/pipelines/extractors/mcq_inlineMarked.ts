import { callModel, type ContentPart } from "../../lib/modelClient";
import type { ModelId } from "../../lib/models";
import type { Schema } from "../../schema/types";
import { MCQ_INLINE_MARKED_PROMPT, STRICT_JSON_REMINDER } from "../prompts";
import {
  buildCustomFieldsPromptBlock,
  buildInlineMarkedResponseSchema,
  buildInlineMarkedZodSchema,
} from "./schemaBuilders";
import type { ExtractedBatch, ExtractorPageInput } from "./types";

export interface RunInlineMarkedExtractorArgs {
  apiKey: string;
  modelId: ModelId;
  schema: Schema;
  pages: ExtractorPageInput[];
  /** Optional signal for cancellation; passed through to the model client. */
  signal?: AbortSignal;
}

/**
 * Build the full extractor system prompt: SPEC §6.2 fixed instructions + custom-field
 * block (dynamic per user schema) + strict-JSON reminder.
 */
export function buildInlineMarkedPrompt(schema: Schema): string {
  return MCQ_INLINE_MARKED_PROMPT + buildCustomFieldsPromptBlock(schema) + STRICT_JSON_REMINDER;
}

/**
 * Run the MCQ inline-marked extractor on a batch of page images.
 *
 * One call to the model per batch (typically up to 10 page images). On output
 * truncation, the caller is expected to handle the auto-split per SPEC §4.9 —
 * `callModel` throws `TruncationError` and does NOT retry truncated responses.
 */
export async function runInlineMarkedExtractor(
  args: RunInlineMarkedExtractorArgs,
): Promise<ExtractedBatch> {
  if (args.schema.content_type !== "mcq") {
    throw new Error(
      `runInlineMarkedExtractor: schema.content_type must be "mcq", got "${args.schema.content_type}"`,
    );
  }
  if (args.pages.length === 0) {
    throw new Error("runInlineMarkedExtractor: no pages provided");
  }

  const systemInstruction = buildInlineMarkedPrompt(args.schema);
  const responseSchema = buildInlineMarkedResponseSchema(args.schema);
  const zodSchema = buildInlineMarkedZodSchema(args.schema);

  const parts: ContentPart[] = [];
  for (const page of args.pages) {
    parts.push({ kind: "text", text: `PAGE ${page.pageNumber}${page.has_images ? " [this page contains figures/images]" : ""}:` });
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
