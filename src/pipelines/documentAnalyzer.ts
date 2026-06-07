import { z } from "zod";
import { callModel, type ContentPart, type ResponseSchema } from "../lib/modelClient";
import type { ModelId } from "../lib/models";
import { DOCUMENT_ANALYSIS_PROMPT } from "./prompts";
import type { ExtractorPageInput } from "./extractors/types";
import { ExamFormatSchema, EXAM_FORMATS } from "./detector";

export const ImageRefSchema = z.object({
  /** question_number the image belongs to, or null for page-level / decorative images. */
  question_number: z.string().nullish(),
  kind: z.enum(["figure", "diagram", "chart", "table", "illustration", "photo"]),
  description: z.string(),
});
export type ImageRef = z.infer<typeof ImageRefSchema>;

export const PageMapEntrySchema = z.object({
  page_number: z.number().int().min(1),
  content_type: z.enum(["questions", "answer_key", "instructions", "blank", "mixed"]),
  page_summary: z.string(),
  section_label: z.string().nullish(),
  question_range_start: z.number().int().nullish(),
  question_range_end: z.number().int().nullish(),
  mcq_count: z.number().int().min(0).default(0),
  true_false_count: z.number().int().min(0).default(0),
  written_count: z.number().int().min(0).default(0),
  matching_count: z.number().int().min(0).default(0),
  has_images: z.boolean().default(false),
  image_count: z.number().int().min(0).default(0),
  images: z.array(ImageRefSchema).default([]),
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
  question_type: z.enum(["mcq", "true_false", "written", "fill_blank", "matching", "other"]),
});
export type ContentPattern = z.infer<typeof ContentPatternSchema>;

/**
 * A contiguous range of questions sharing the same answer-marking method. A uniform
 * document yields a single region spanning all questions; a mixed-format document
 * (e.g. inline-marked Q1–20, answer-key-at-end Q21–40) yields one region per method.
 * Drives per-region extractor routing in runPipeline.
 */
export const MarkingRegionSchema = z.object({
  question_range_start: z.number().int(),
  question_range_end: z.number().int(),
  marking_format: ExamFormatSchema,
  confidence: z.number().min(0).max(1),
  notes: z.string().nullish(),
});
export type MarkingRegion = z.infer<typeof MarkingRegionSchema>;

export const DocumentSectionSchema = z.object({
  label: z.string(),
  question_range_start: z.number().int(),
  question_range_end: z.number().int(),
});
export type DocumentSection = z.infer<typeof DocumentSectionSchema>;

export const DocumentAnalysisResultSchema = z.object({
  // Whole-document narrative
  document_summary: z.string(),

  // Format classification (replaces standalone detector).
  // Document-level fields describe the dominant marking method; marking_regions
  // captures per-range methods for mixed-format documents.
  marking_format: ExamFormatSchema,
  marking_format_confidence: z.number().min(0).max(1),
  marking_format_notes: z.string(),
  marking_regions: z.array(MarkingRegionSchema).default([]),

  // Question-type totals
  total_questions: z.number().int().nullable(),
  total_mcq_count: z.number().int().nullable(),
  total_true_false_count: z.number().int().nullable(),
  total_written_count: z.number().int().nullable(),
  has_answer_key: z.boolean(),

  // Structural details
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
    document_summary: { type: "string" },
    marking_format: {
      type: "string",
      enum: [...EXAM_FORMATS],
    },
    marking_format_confidence: { type: "number" },
    marking_format_notes: { type: "string" },
    marking_regions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question_range_start: { type: "integer" },
          question_range_end: { type: "integer" },
          marking_format: { type: "string", enum: [...EXAM_FORMATS] },
          confidence: { type: "number" },
          notes: { type: "string" },
        },
        required: ["question_range_start", "question_range_end", "marking_format", "confidence"],
      },
    },
    total_questions: { type: "integer" },
    total_mcq_count: { type: "integer" },
    total_true_false_count: { type: "integer" },
    total_written_count: { type: "integer" },
    has_answer_key: { type: "boolean" },
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
          page_summary: { type: "string" },
          section_label: { type: "string" },
          question_range_start: { type: "integer" },
          question_range_end: { type: "integer" },
          mcq_count: { type: "integer" },
          true_false_count: { type: "integer" },
          written_count: { type: "integer" },
          matching_count: { type: "integer" },
          has_images: { type: "boolean" },
          image_count: { type: "integer" },
          images: {
            type: "array",
            items: {
              type: "object",
              properties: {
                question_number: { type: "string" },
                kind: { type: "string", enum: ["figure", "diagram", "chart", "table", "illustration", "photo"] },
                description: { type: "string" },
              },
              required: ["kind", "description"],
            },
          },
        },
        required: ["page_number", "content_type", "page_summary", "mcq_count", "true_false_count", "written_count", "matching_count", "has_images", "image_count"],
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
            enum: ["mcq", "true_false", "written", "fill_blank", "matching", "other"],
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
    "document_summary",
    "marking_format",
    "marking_format_confidence",
    "marking_format_notes",
    "marking_regions",
    "total_questions",
    "total_mcq_count",
    "total_true_false_count",
    "total_written_count",
    "has_answer_key",
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
  /** Reports batch progress when a long PDF is analyzed in chunks: (done, total). */
  onProgress?: (done: number, total: number) => void;
}

// Keep each analyzer request well under the model client's 20 MB payload cap, and cap
// pages per request so the per-page `page_map` output can't blow the output-token limit.
// Long PDFs are split across several requests and the partial analyses are merged.
const ANALYZER_PAYLOAD_BUDGET_BYTES = 14 * 1024 * 1024;
const ANALYZER_MAX_PAGES_PER_CHUNK = 25;

/** Split pages into contiguous chunks that fit both the byte budget and the page cap. */
function chunkPages(
  pages: ExtractorPageInput[],
  byteBudget: number,
  maxPages: number,
): ExtractorPageInput[][] {
  const chunks: ExtractorPageInput[][] = [];
  let current: ExtractorPageInput[] = [];
  let currentBytes = 0;
  for (const page of pages) {
    const pageBytes = page.base64.length + 16; // + the "PAGE N:" label
    if (
      current.length > 0 &&
      (currentBytes + pageBytes > byteBudget || current.length >= maxPages)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(page);
    currentBytes += pageBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Analyze a single chunk of pages — one model request. */
async function analyzeChunk(
  args: RunDocumentAnalyzerArgs,
  pages: ExtractorPageInput[],
): Promise<DocumentAnalysisResult> {
  const parts: ContentPart[] = [];
  if (args.pdfName) {
    parts.push({
      kind: "text",
      text: `PDF File Name: ${args.pdfName}\nUse this file name to help infer exam metadata (title, date, subject) or exam partitioning if mentioned in the name.\n\n`,
    });
  }
  for (const page of pages) {
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

/** Merge same-labelled sections, widening to the union of their question ranges. */
function dedupeSections(sections: DocumentSection[]): DocumentSection[] {
  const byLabel = new Map<string, DocumentSection>();
  for (const s of sections) {
    const cur = byLabel.get(s.label);
    if (!cur) {
      byLabel.set(s.label, { ...s });
    } else {
      cur.question_range_start = Math.min(cur.question_range_start, s.question_range_start);
      cur.question_range_end = Math.max(cur.question_range_end, s.question_range_end);
    }
  }
  return [...byLabel.values()];
}

/**
 * Merge per-chunk analyses into one document-level result. Each chunk only saw its own
 * pages, so per-page data (page_map) concatenates, per-page totals sum, document-level
 * classification is taken from the chunk carrying the most questions, and metadata uses
 * the first non-empty value (title/date/subject usually live on the opening pages).
 */
function mergeAnalyses(parts: DocumentAnalysisResult[]): DocumentAnalysisResult {
  const first = parts[0];

  const sumNullable = (sel: (p: DocumentAnalysisResult) => number | null): number | null => {
    let any = false;
    let sum = 0;
    for (const p of parts) {
      const v = sel(p);
      if (v != null) {
        any = true;
        sum += v;
      }
    }
    return any ? sum : null;
  };

  const questionWeight = (p: DocumentAnalysisResult): number =>
    p.total_questions ??
    p.page_map.reduce(
      (s, e) => s + e.mcq_count + e.true_false_count + e.written_count + e.matching_count,
      0,
    );

  // The chunk with the most questions wins layout/structure classification.
  let dominant = first;
  let dominantWeight = -1;
  for (const p of parts) {
    const w = questionWeight(p);
    if (w > dominantWeight) {
      dominantWeight = w;
      dominant = p;
    }
  }

  // The marking format is chosen separately: a body-only chunk of an answer-key-at-end
  // exam looks like "no_answers", so prefer chunks that actually found a marking method,
  // scored by confidence × question weight. Fall back to all chunks if none are decisive.
  const informative = parts.filter(
    (p) => p.marking_format !== "no_answers" && p.marking_format !== "mixed_or_unclear",
  );
  const formatPool = informative.length > 0 ? informative : parts;
  let formatSource = formatPool[0];
  let bestFormatScore = -1;
  for (const p of formatPool) {
    const score = p.marking_format_confidence * (questionWeight(p) + 1);
    if (score > bestFormatScore) {
      bestFormatScore = score;
      formatSource = p;
    }
  }

  const firstStr = (sel: (p: DocumentAnalysisResult) => string | null | undefined): string | undefined => {
    for (const p of parts) {
      const v = sel(p);
      if (v) return v;
    }
    return undefined;
  };

  return {
    document_summary: parts.map((p) => p.document_summary).filter(Boolean).join(" "),
    marking_format: formatSource.marking_format,
    marking_format_confidence: formatSource.marking_format_confidence,
    marking_format_notes: formatSource.marking_format_notes,
    marking_regions: parts.flatMap((p) => p.marking_regions),
    total_questions: sumNullable((p) => p.total_questions),
    total_mcq_count: sumNullable((p) => p.total_mcq_count),
    total_true_false_count: sumNullable((p) => p.total_true_false_count),
    total_written_count: sumNullable((p) => p.total_written_count),
    has_answer_key: parts.some((p) => p.has_answer_key),
    sections: dedupeSections(parts.flatMap((p) => p.sections)),
    page_map: parts.flatMap((p) => p.page_map).sort((a, b) => a.page_number - b.page_number),
    answer_key_locations: parts.flatMap((p) => p.answer_key_locations),
    cross_page_questions: parts.flatMap((p) => p.cross_page_questions),
    content_patterns: parts.flatMap((p) => p.content_patterns),
    exam_metadata: {
      title: firstStr((p) => p.exam_metadata.title),
      date: firstStr((p) => p.exam_metadata.date),
      subject: firstStr((p) => p.exam_metadata.subject),
    },
    layout: {
      columns: dominant.layout.columns,
      has_math: parts.some((p) => p.layout.has_math),
      primary_language: first.layout.primary_language,
    },
    notes: parts.map((p) => p.notes).filter(Boolean).join(" "),
  };
}

export async function runDocumentAnalyzer(
  args: RunDocumentAnalyzerArgs,
): Promise<DocumentAnalysisResult> {
  if (args.pages.length === 0) {
    throw new Error("runDocumentAnalyzer: no pages provided");
  }

  const chunks = chunkPages(
    args.pages,
    ANALYZER_PAYLOAD_BUDGET_BYTES,
    ANALYZER_MAX_PAGES_PER_CHUNK,
  );

  // Short PDFs (the common case) still go through as a single request — no behavior change.
  if (chunks.length === 1) {
    args.onProgress?.(0, 1);
    const only = await analyzeChunk(args, chunks[0]);
    args.onProgress?.(1, 1);
    return only;
  }

  const partials: DocumentAnalysisResult[] = [];
  for (let i = 0; i < chunks.length; i++) {
    args.onProgress?.(i, chunks.length);
    partials.push(await analyzeChunk(args, chunks[i]));
  }
  args.onProgress?.(chunks.length, chunks.length);
  return mergeAnalyses(partials);
}
