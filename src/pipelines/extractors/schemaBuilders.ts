import { z } from "zod";
import type { FieldDefinition, Schema } from "../../schema/types";
import { MARKING_STYLE_VALUES, MCQ_TYPE_VALUES, OPTION_LETTERS } from "../prompts";
import type { ResponseSchema } from "../../lib/modelClient";
import {
  CanonicalMcqOptionsSchema,
  CorrectAnswerSchema,
  MarkingStyleSchema,
  McqTypeSchema,
} from "./types";

/**
 * Custom-only fields = the user's declared fields that aren't covered by a canonical
 * semantic role (semantic_role = null) AND aren't computed from a template.
 * These are the ones we ask the model to extract by their user-defined name.
 */
export function customExtractFields(schema: Schema): FieldDefinition[] {
  return schema.fields.filter((f) => f.semantic_role === null && !f.template);
}

/** Convert a user FieldDefinition to a JSON-schema property for Gemini responseSchema. */
function fieldToJsonProperty(field: FieldDefinition): Record<string, unknown> {
  switch (field.type) {
    case "string":
    case "multiline_string":
      return { type: "string" };
    case "enum":
      return {
        type: "string",
        enum: field.enum_values ?? [],
      };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
  }
}

/** Convert a user FieldDefinition to a zod schema for client-side validation. */
function fieldToZod(field: FieldDefinition): z.ZodTypeAny {
  let base: z.ZodTypeAny;
  switch (field.type) {
    case "string":
    case "multiline_string":
      base = z.string();
      break;
    case "enum":
      if (!field.enum_values || field.enum_values.length === 0) {
        base = z.string();
      } else {
        base = z.enum(field.enum_values as [string, ...string[]]);
      }
      break;
    case "number":
      base = z.number();
      break;
    case "boolean":
      base = z.boolean();
      break;
  }
  // Optional fields can be null or absent in the model response.
  if (!field.required) {
    base = base.nullable().optional();
  }
  return base;
}

/**
 * Build the JSON Schema we hand to Gemini as `responseSchema`. Includes canonical
 * MCQ fields + user's custom fields. Output is a `{ pages: [{ page_number, layout_notes, rows: [...] }] }` envelope.
 *
 * Used by all MCQ extractor variants (inline-marked, written-answer, answer-key-at-end).
 */
export function buildMcqResponseSchema(schema: Schema): ResponseSchema {
  const custom = customExtractFields(schema);
  const customProps: Record<string, unknown> = {};
  for (const f of custom) {
    customProps[f.name] = fieldToJsonProperty(f);
  }

  const rowProps: Record<string, unknown> = {
    question_number: { type: "string" },
    question_text: { type: "string" },
    options: {
      type: "object",
      properties: {
        A: { type: "string", nullable: true },
        B: { type: "string", nullable: true },
        C: { type: "string", nullable: true },
        D: { type: "string", nullable: true },
        E: { type: "string", nullable: true },
      },
    },
    correct_answer: {
      type: "string",
      enum: [...OPTION_LETTERS],
      nullable: true,
    },
    marking_style: {
      type: "string",
      enum: [...MARKING_STYLE_VALUES],
    },
    mcq_type: {
      type: "string",
      enum: [...MCQ_TYPE_VALUES],
    },
    multiple_marks_detected: { type: "boolean" },
    is_partial: { type: "boolean" },
    confidence: { type: "number" },
    notes: { type: "string" },
    source_snippet: { type: "string" },
    ...customProps,
  };

  const requiredRowFields = [
    "question_number",
    "question_text",
    "options",
    "marking_style",
    "mcq_type",
    "multiple_marks_detected",
    "is_partial",
    "confidence",
    "notes",
    "source_snippet",
    ...custom.filter((f) => f.required).map((f) => f.name),
  ];

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
                required: requiredRowFields,
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

/** Backwards-compat alias retained for the inline-marked extractor. */
export const buildInlineMarkedResponseSchema = buildMcqResponseSchema;

/**
 * Build a runtime zod schema mirroring the response shape — used by `callModel` to
 * validate Gemini's output before handing it back to the orchestrator.
 *
 * Used by all MCQ extractor variants.
 */
export function buildMcqZodSchema(schema: Schema): z.ZodTypeAny {
  const custom = customExtractFields(schema);
  const rowShape: Record<string, z.ZodTypeAny> = {
    question_number: z.string(),
    question_text: z.string(),
    options: CanonicalMcqOptionsSchema,
    correct_answer: CorrectAnswerSchema,
    marking_style: MarkingStyleSchema,
    mcq_type: McqTypeSchema,
    multiple_marks_detected: z.boolean(),
    is_partial: z.boolean(),
    confidence: z.number().min(0).max(1),
    notes: z.string(),
    source_snippet: z.string(),
  };
  for (const f of custom) {
    rowShape[f.name] = fieldToZod(f);
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

export const buildInlineMarkedZodSchema = buildMcqZodSchema;

/**
 * Build the user-fields block appended to the system prompt. Custom fields are listed
 * with their name, type, required flag, and description so the model knows what to
 * extract for each.
 */
export function buildCustomFieldsPromptBlock(schema: Schema): string {
  const custom = customExtractFields(schema);
  if (custom.length === 0) return "";

  const lines: string[] = [
    "",
    "",
    "In addition to the canonical fields, for each question extract the user-defined fields below.",
    "Match each field's data type exactly; return null for optional fields when not applicable.",
    "",
  ];
  for (const f of custom) {
    const typeLabel =
      f.type === "enum" && f.enum_values && f.enum_values.length > 0
        ? `enum [${f.enum_values.join(" | ")}]`
        : f.type;
    const reqLabel = f.required ? "required" : "optional";
    lines.push(`  ${f.name} (${typeLabel}, ${reqLabel}):`);
    lines.push(`    ${f.description || "(no description provided — use field name as guidance)"}`);
    lines.push("");
  }
  return lines.join("\n");
}
