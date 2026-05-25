import { z } from "zod";
import { callModel, type ContentPart, type ResponseSchema } from "../../lib/modelClient";
import type { ModelId } from "../../lib/models";
import type { Schema } from "../../schema/types";
import { FIGURES_PROMPT_BLOCK, STRICT_JSON_REMINDER } from "../prompts";
import { buildCustomFieldsPromptBlock, customExtractFields } from "./schemaBuilders";
import type { ExtractedBatch, ExtractorPageInput } from "./types";

const FLASHCARD_PROMPT = `You are extracting flashcard-style content from study material pages.
Each card has a TERM (short, often bolded or in a header position) and a
DEFINITION (the explanatory text immediately following the term).

For each page, identify every term/definition pair and extract:
- term: the term being defined
- definition: the explanation
- example (optional): if an example sentence or illustration is provided

Plus audit fields: confidence (0-1), is_partial (if definition continues on next
page), notes (string), source_snippet (verbatim text from the card's region of
the page, max 2000 chars).

Read multi-column pages top-to-bottom within each column.

If a page contains no term/definition pairs (blank, cover, glossary header,
section divider), return rows=[] and set layout_notes to a short reason.

confidence reflects certainty in the term/definition pairing — a clear term
matched to an ambiguous or wrong-feeling definition gets LOW confidence.`;

export interface RunFlashcardExtractorArgs {
  apiKey: string;
  modelId: ModelId;
  schema: Schema;
  pages: ExtractorPageInput[];
  signal?: AbortSignal;
}

function buildFlashcardPrompt(schema: Schema): string {
  return FLASHCARD_PROMPT + FIGURES_PROMPT_BLOCK + buildCustomFieldsPromptBlock(schema) + STRICT_JSON_REMINDER;
}

function buildFlashcardResponseSchema(schema: Schema): ResponseSchema {
  const custom = customExtractFields(schema);
  const customProps: Record<string, unknown> = {};
  for (const f of custom) {
    const t = f.type;
    if (t === "enum") {
      customProps[f.name] = { type: "string", enum: f.enum_values ?? [] };
    } else if (t === "number") customProps[f.name] = { type: "number" };
    else if (t === "boolean") customProps[f.name] = { type: "boolean" };
    else customProps[f.name] = { type: "string" };
  }

  const rowProps: Record<string, unknown> = {
    term: { type: "string" },
    definition: { type: "string" },
    example: { type: "string", nullable: true },
    is_partial: { type: "boolean" },
    confidence: { type: "number" },
    notes: { type: "string" },
    source_snippet: { type: "string" },
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
                required: ["term", "definition", "is_partial", "confidence", "notes", "source_snippet"],
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

function buildFlashcardZodSchema(schema: Schema): z.ZodTypeAny {
  const custom = customExtractFields(schema);
  const rowShape: Record<string, z.ZodTypeAny> = {
    term: z.string(),
    definition: z.string(),
    example: z.string().nullable().optional(),
    is_partial: z.boolean(),
    confidence: z.number().min(0).max(1),
    notes: z.string(),
    source_snippet: z.string(),
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

export async function runFlashcardExtractor(
  args: RunFlashcardExtractorArgs,
): Promise<ExtractedBatch> {
  if (args.schema.content_type !== "flashcard") {
    throw new Error(
      `runFlashcardExtractor: schema.content_type must be "flashcard", got "${args.schema.content_type}"`,
    );
  }
  if (args.pages.length === 0) {
    throw new Error("runFlashcardExtractor: no pages provided");
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

  const result = await callModel<ExtractedBatch>(
    {
      modelId: args.modelId,
      apiKey: args.apiKey,
      systemInstruction: buildFlashcardPrompt(args.schema),
      parts,
      responseSchema: buildFlashcardResponseSchema(args.schema),
      signal: args.signal,
    },
    buildFlashcardZodSchema(args.schema) as unknown as Parameters<typeof callModel<ExtractedBatch>>[1],
  );

  return result.data;
}
