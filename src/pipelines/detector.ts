import { z } from "zod";
import { callModel, type ContentPart, type ResponseSchema } from "../lib/modelClient";
import type { ModelId } from "../lib/models";

/**
 * MCQ format detector. Per SPEC §6.1, samples 2-3 pages and classifies the PDF's
 * answer-marking format with confidence. Only runs when content_type=mcq and
 * mode ≠ "Answer from scratch".
 */

export const EXAM_FORMATS = [
  "inline_marked",
  "written_answer",
  "answer_key_at_end",
  "bubble_sheet",
  "no_answers",
  "mixed_or_unclear",
] as const;

export const ExamFormatSchema = z.enum(EXAM_FORMATS);
export type ExamFormat = z.infer<typeof ExamFormatSchema>;

export const DetectorLayoutSchema = z.object({
  columns: z.number().int().min(1).max(3),
  has_math: z.boolean(),
  primary_language: z.string(),
  questions_per_page_estimate: z.number().int().min(0),
});
export type DetectorLayout = z.infer<typeof DetectorLayoutSchema>;

export const DetectorResultSchema = z.object({
  format: ExamFormatSchema,
  confidence: z.number().min(0).max(1),
  layout: DetectorLayoutSchema,
  notes: z.string(),
});
export type DetectorResult = z.infer<typeof DetectorResultSchema>;

export const FORMAT_LABELS: Record<ExamFormat, string> = {
  inline_marked:
    "Options A/B/C/D on the same page, one marked (circled, ticked, underlined, highlighted, crossed, boxed).",
  written_answer:
    "A letter or word printed or written near each question indicates the answer.",
  answer_key_at_end:
    "Questions in the body; a separate answer key (e.g., '1. A  2. C  3. B') on later pages.",
  bubble_sheet: "Separate OMR-style sheet with filled bubbles. (Deferred to v2.)",
  no_answers: "No answer marks visible anywhere in the sample.",
  mixed_or_unclear: "Multiple formats present, or the sample is too ambiguous to classify.",
};

const DETECTOR_PROMPT = `You are analyzing sample pages from an MCQ exam PDF to identify how correct answers are marked.

Classify the format as exactly one of:
- inline_marked: options A/B/C/D shown on same page as question, one visually marked (circled, ticked, underlined, highlighted, crossed, boxed).
- written_answer: a letter or word printed/written near each question indicates the answer.
- answer_key_at_end: questions in body, separate answer key on later pages.
- bubble_sheet: separate OMR sheet with filled bubbles.
- no_answers: no answer marks visible.
- mixed_or_unclear: multiple formats, or you cannot confidently determine.

Also report:
- confidence (0-1)
- columns: 1, 2, or 3
- has_math: boolean
- primary_language: ISO 639-1 code (e.g., "en", "es")
- questions_per_page_estimate: integer
- notes: short string for unusual observations (e.g., "answer key uses Roman numerals", "scanned with handwritten circles")

Be conservative: prefer mixed_or_unclear if ambiguous.
Return strict JSON.`;

const DETECTOR_RESPONSE_SCHEMA: ResponseSchema = {
  type: "object",
  properties: {
    format: {
      type: "string",
      enum: [...EXAM_FORMATS],
    },
    confidence: { type: "number" },
    layout: {
      type: "object",
      properties: {
        columns: { type: "integer" },
        has_math: { type: "boolean" },
        primary_language: { type: "string" },
        questions_per_page_estimate: { type: "integer" },
      },
      required: ["columns", "has_math", "primary_language", "questions_per_page_estimate"],
    },
    notes: { type: "string" },
  },
  required: ["format", "confidence", "layout", "notes"],
};

export interface DetectorSample {
  pageNumber: number;
  base64: string;
  mimeType?: string;
}

export interface RunDetectorArgs {
  apiKey: string;
  modelId: ModelId;
  samples: DetectorSample[];
  signal?: AbortSignal;
}

/**
 * Pick 2-3 representative pages from a total page count. For small PDFs returns all pages;
 * for larger ones returns first + middle + last.
 */
export function pickSamplePages(totalPages: number): number[] {
  if (totalPages <= 0) return [];
  if (totalPages === 1) return [1];
  if (totalPages === 2) return [1, 2];
  if (totalPages === 3) return [1, 2, 3];
  return [1, Math.ceil(totalPages / 2), totalPages];
}

/**
 * Detector confidence threshold (SPEC §4.6). If the returned confidence is below this OR
 * the format is `mixed_or_unclear`, the UI pauses to ask the user to confirm or override.
 */
export const DETECTOR_AUTO_PROCEED_THRESHOLD = 0.6;

export function needsManualConfirmation(result: DetectorResult): boolean {
  return result.confidence < DETECTOR_AUTO_PROCEED_THRESHOLD || result.format === "mixed_or_unclear";
}

export async function runDetector(args: RunDetectorArgs): Promise<DetectorResult> {
  if (args.samples.length === 0) {
    throw new Error("runDetector: at least one sample page is required");
  }

  const parts: ContentPart[] = [];
  for (const sample of args.samples) {
    parts.push({ kind: "text", text: `PAGE ${sample.pageNumber}:` });
    parts.push({
      kind: "image",
      mimeType: sample.mimeType ?? "image/jpeg",
      base64: sample.base64,
    });
  }

  const result = await callModel<DetectorResult>(
    {
      modelId: args.modelId,
      apiKey: args.apiKey,
      systemInstruction: DETECTOR_PROMPT,
      parts,
      responseSchema: DETECTOR_RESPONSE_SCHEMA,
      signal: args.signal,
    },
    DetectorResultSchema,
  );

  return result.data;
}
