import { callModel, type ContentPart } from "../../lib/modelClient";
import type { ModelId } from "../../lib/models";
import type { Schema } from "../../schema/types";
import { MCQ_WRITTEN_ANSWER_PROMPT, STRICT_JSON_REMINDER } from "../prompts";
import {
  buildCustomFieldsPromptBlock,
  buildMcqResponseSchema,
  buildMcqZodSchema,
} from "./schemaBuilders";
import type { ExtractedBatch, ExtractorPageInput } from "./types";

export interface RunWrittenAnswerExtractorArgs {
  apiKey: string;
  modelId: ModelId;
  schema: Schema;
  pages: ExtractorPageInput[];
  signal?: AbortSignal;
}

export function buildWrittenAnswerPrompt(schema: Schema): string {
  return MCQ_WRITTEN_ANSWER_PROMPT + buildCustomFieldsPromptBlock(schema) + STRICT_JSON_REMINDER;
}

export async function runWrittenAnswerExtractor(
  args: RunWrittenAnswerExtractorArgs,
): Promise<ExtractedBatch> {
  if (args.schema.content_type !== "mcq") {
    throw new Error(
      `runWrittenAnswerExtractor: schema.content_type must be "mcq", got "${args.schema.content_type}"`,
    );
  }
  if (args.pages.length === 0) {
    throw new Error("runWrittenAnswerExtractor: no pages provided");
  }

  const systemInstruction = buildWrittenAnswerPrompt(args.schema);
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

  return result.data;
}
