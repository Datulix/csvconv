import { z } from "zod";
import { callModel, type ContentPart, type ResponseSchema } from "../lib/modelClient";
import type { ModelId } from "../lib/models";
import { DOCUMENT_ANALYSIS_PROMPT } from "./prompts";
import type { ExtractorPageInput } from "./extractors/types";

export const PageMapEntrySchema = z.object({
  page_number: z.number().int().min(1),
  content_type: z.enum(["questions", "answer_key", "instructions", "blank", "mixed"]),
  section_label: z.string().nullish(),
  question_range_start: z.number().int().nullish(),
  question_range_end: z.number().int().nullish(),
});
export type PageMapEntry = z.infer<typeof PageMapEntrySchema>;

export const AnswerKeyLocationSchema = z.object({
  page_number: z.number().int().min(1),
  section_label: z.string().nullish(),
  question_range_start: z.number().int().nullish(),
  question_range_end: z.number().int().nullish(),
});
export type AnswerKeyLocation = z.infer<typeof AnswerKeyLocationSchema>;

export const CrossPageQuestionSchema = z.object({
  question_number: z.string(),
  starts_on_page: z.number().int().min(1),
  ends_on_page: z.number().int().min(1),
});
export type CrossPageQuestion = z.infer<typeof CrossPageQuestionSchema>;

export const ContentPatternSchema = z.object({
  question_range_start: z.number().int(),
  question_range_end: z.number().int(),
  question_type: z.enum(["mcq", "true_false", "written", "fill_blank", "other"]),
});
export type ContentPattern = z.infer<typeof ContentPatternSchema>;

export const DocumentSectionSchema = z.object({
  label: z.string(),
  question_range_start: z.number().int(),
  question_range_end: z.number().int(),
});
export type DocumentSection = z.infer<typeof DocumentSectionSchema>;

export const DocumentAnalysisResultSchema = z.object({
  total_questions: z.number().int().nullable(),
  sections: z.array(DocumentSectionSchema),
  page_map: z.array(PageMapEntrySchema),
  answer_key_locations: z.array(AnswerKeyLocationSchema),
  cross_page_questions: z.array(CrossPageQuestionSchema),
  content_patterns: z.array(ContentPatternSchema),
  exam_metadata: z.object({
    title: z.string().nullish(),
    date: z.string().nullish(),
    subject: z.string().nullish(),
  }),
  layout: z.object({
    columns: z.number().int().min(1).max(3),
    has_math: z.boolean(),
    primary_language: z.string(),
  }),
  notes: z.string(),
});
export type DocumentAnalysisResult = z.infer<typeof DocumentAnalysisResultSchema>;

const DOCUMENT_ANALYSIS_RESPONSE_SCHEMA: ResponseSchema = {
  type: "object",
  properties: {
    total_questions: { type: "integer" },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          question_range_start: { type: "integer" },
          question_range_end: { type: "integer" },
        },
        required: ["label", "question_range_start", "question_range_end"],
      },
    },
    page_map: {
      type: "array",
      items: {
        type: "object",
        properties: {
          page_number: { type: "integer" },
          content_type: {
            type: "string",
            enum: ["questions", "answer_key", "instructions", "blank", "mixed"],
          },
          section_label: { type: "string" },
          question_range_start: { type: "integer" },
          question_range_end: { type: "integer" },
        },
        required: ["page_number", "content_type"],
      },
    },
    answer_key_locations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          page_number: { type: "integer" },
          section_label: { type: "string" },
          question_range_start: { type: "integer" },
          question_range_end: { type: "integer" },
        },
        required: ["page_number"],
      },
    },
    cross_page_questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question_number: { type: "string" },
          starts_on_page: { type: "integer" },
          ends_on_page: { type: "integer" },
        },
        required: ["question_number", "starts_on_page", "ends_on_page"],
      },
    },
    content_patterns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question_range_start: { type: "integer" },
          question_range_end: { type: "integer" },
          question_type: {
            type: "string",
            enum: ["mcq", "true_false", "written", "fill_blank", "other"],
          },
        },
        required: ["question_range_start", "question_range_end", "question_type"],
      },
    },
    exam_metadata: {
      type: "object",
      properties: {
        title: { type: "string" },
        date: { type: "string" },
        subject: { type: "string" },
      },
    },
    layout: {
      type: "object",
      properties: {
        columns: { type: "integer" },
        has_math: { type: "boolean" },
        primary_language: { type: "string" },
      },
      required: ["columns", "has_math", "primary_language"],
    },
    notes: { type: "string" },
  },
  required: [
    "total_questions",
    "sections",
    "page_map",
    "answer_key_locations",
    "cross_page_questions",
    "content_patterns",
    "exam_metadata",
    "layout",
    "notes",
  ],
};

export interface RunDocumentAnalyzerArgs {
  apiKey: string;
  modelId: ModelId;
  pages: ExtractorPageInput[];
  pdfName?: string;
  signal?: AbortSignal;
}

export async function runDocumentAnalyzer(
  args: RunDocumentAnalyzerArgs,
): Promise<DocumentAnalysisResult> {
  if (args.pages.length === 0) {
    throw new Error("runDocumentAnalyzer: no pages provided");
  }

  const parts: ContentPart[] = [];
  if (args.pdfName) {
    parts.push({
      kind: "text",
      text: `PDF File Name: ${args.pdfName}\nUse this file name to help infer exam metadata (title, date, subject) or exam partitioning if mentioned in the name.\n\n`,
    });
  }
  for (const page of args.pages) {
    parts.push({ kind: "text", text: `PAGE ${page.pageNumber}:` });
    parts.push({
      kind: "image",
      mimeType: page.mimeType ?? "image/jpeg",
      base64: page.base64,
    });
  }

  const result = await callModel<DocumentAnalysisResult>(
    {
      modelId: args.modelId,
      apiKey: args.apiKey,
      systemInstruction: DOCUMENT_ANALYSIS_PROMPT,
      parts,
      responseSchema: DOCUMENT_ANALYSIS_RESPONSE_SCHEMA,
      signal: args.signal,
    },
    DocumentAnalysisResultSchema,
  );

  return result.data;
}
