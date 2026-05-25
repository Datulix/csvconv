import { z } from "zod";
import { callModel, type ContentPart, type ResponseSchema } from "../../lib/modelClient";
import type { ModelId } from "../../lib/models";
import type { Schema } from "../../schema/types";
import { FIGURES_PROMPT_BLOCK, STRICT_JSON_REMINDER } from "../prompts";
import { buildCustomFieldsPromptBlock, customExtractFields } from "./schemaBuilders";
import type { ExtractedBatch, ExtractorPageInput } from "./types";

const QA_PAIR_PROMPT = `You are extracting question-and-answer pairs from pages of study material
(e.g., FAQ documents, tutorial Q&A sections).

For each page, identify every Q&A pair and extract:
- question: the question text
- answer: the corresponding answer text

Plus audit fields: confidence (0-1), is_partial (boolean), notes (string),
source_snippet (verbatim text from the pair's region of the page, max 2000 chars).

If a page contains no Q&A pairs (blank, cover, narrative-only text without
explicit Q/A structure), return rows=[] and set layout_notes to a short reason.

confidence reflects certainty in the Q→A pairing being correct.`;

export interface RunQaPairExtractorArgs {
  apiKey: string;
  modelId: ModelId;
  schema: Schema;
  pages: ExtractorPageInput[];
  signal?: AbortSignal;
}

function buildQaPairPrompt(schema: Schema): string {
  return QA_PAIR_PROMPT + FIGURES_PROMPT_BLOCK + buildCustomFieldsPromptBlock(schema) + STRICT_JSON_REMINDER;
}

function buildQaPairResponseSchema(schema: Schema): ResponseSchema {
  const custom = customExtractFields(schema);
  const customProps: Record<string, unknown> = {};
  for (const f of custom) {
    if (f.type === "enum") {
      customProps[f.name] = { type: "string", enum: f.enum_values ?? [] };
    } else if (f.type === "number") customProps[f.name] = { type: "number" };
    else if (f.type === "boolean") customProps[f.name] = { type: "boolean" };
    else customProps[f.name] = { type: "string" };
  }

  const rowProps: Record<string, unknown> = {
    question: { type: "string" },
    answer: { type: "string" },
    is_partial: { type: "boolean" },
    confidence: { type: "number" },
    notes: { type: "string" },
    source_snippet: { type: "string" },
    depends_on: { type: "string", nullable: true },
    context_group: { type: "string", nullable: true },
    figures: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ymin: { type: "integer" },
          xmin: { type: "integer" },
          ymax: { type: "integer" },
          xmax: { type: "integer" },
          explanation: { type: "string" },
          kind: { type: "string", enum: ["figure", "diagram", "chart", "table", "illustration"] },
        },
        required: ["ymin", "xmin", "ymax", "xmax", "explanation", "kind"],
      },
    },
    ...customProps,
  };

  return {
    type: "object",
    properties: {
      pages: {
        type: "array",
        items: {
          type: "object",
          properties: {
            page_number: { type: "integer" },
            layout_notes: { type: "string" },
            rows: {
              type: "array",
              items: {
                type: "object",
                properties: rowProps,
                required: ["question", "answer", "is_partial", "confidence", "notes", "source_snippet"],
              },
            },
          },
          required: ["page_number", "layout_notes", "rows"],
        },
      },
    },
    required: ["pages"],
  };
}

function buildQaPairZodSchema(schema: Schema): z.ZodTypeAny {
  const custom = customExtractFields(schema);
  const rowShape: Record<string, z.ZodTypeAny> = {
    question: z.string(),
    answer: z.string(),
    is_partial: z.boolean(),
    confidence: z.number().min(0).max(1),
    notes: z.string(),
    source_snippet: z.string(),
    depends_on: z.string().nullable().optional(),
    context_group: z.string().nullable().optional(),
    figures: z.array(z.object({
      ymin: z.number().int().min(0).max(1000),
      xmin: z.number().int().min(0).max(1000),
      ymax: z.number().int().min(0).max(1000),
      xmax: z.number().int().min(0).max(1000),
      explanation: z.string(),
      kind: z.enum(["figure", "diagram", "chart", "table", "illustration"]),
    })).optional(),
  };
  for (const f of custom) {
    let base: z.ZodTypeAny;
    switch (f.type) {
      case "number":
        base = z.number();
        break;
      case "boolean":
        base = z.boolean();
        break;
      case "enum":
        if (f.enum_values && f.enum_values.length > 0) {
          base = z.enum(f.enum_values as [string, ...string[]]);
        } else {
          base = z.string();
        }
        break;
      default:
        base = z.string();
    }
    if (!f.required) base = base.nullable().optional();
    rowShape[f.name] = base;
  }
  return z.object({
    pages: z.array(
      z.object({
        page_number: z.number().int(),
        layout_notes: z.string(),
        rows: z.array(z.object(rowShape).passthrough()),
      }),
    ),
  });
}

export async function runQaPairExtractor(
  args: RunQaPairExtractorArgs,
): Promise<ExtractedBatch> {
  if (args.schema.content_type !== "qa_pair") {
    throw new Error(
      `runQaPairExtractor: schema.content_type must be "qa_pair", got "${args.schema.content_type}"`,
    );
  }
  if (args.pages.length === 0) {
    throw new Error("runQaPairExtractor: no pages provided");
  }

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
      systemInstruction: buildQaPairPrompt(args.schema),
      parts,
      responseSchema: buildQaPairResponseSchema(args.schema),
      signal: args.signal,
    },
    buildQaPairZodSchema(args.schema) as unknown as Parameters<typeof callModel<ExtractedBatch>>[1],
  );

  return result.data;
}
