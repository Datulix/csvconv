import { z } from "zod";
import { MARKING_STYLE_VALUES, MCQ_TYPE_VALUES, OPTION_LETTERS } from "../prompts";

/** Letter labels for MCQ options. */
export const OptionLetterSchema = z.enum(OPTION_LETTERS);
export type OptionLetter = z.infer<typeof OptionLetterSchema>;

export const MarkingStyleSchema = z.enum(MARKING_STYLE_VALUES);
export type MarkingStyle = z.infer<typeof MarkingStyleSchema>;

export const McqTypeSchema = z.enum(MCQ_TYPE_VALUES);
export type McqType = z.infer<typeof McqTypeSchema>;

/**
 * Static canonical row shape produced by every MCQ extractor.
 *
 * Every letter is `.nullable().optional()` because:
 *   - Most MCQs have 4 options (no E); Gemini omits the missing key entirely.
 *   - Some have just 2 (true/false); A and B may be the only present keys.
 *   - "no option" can be reported as null OR an empty string OR a missing key —
 *     the preprocessor below normalizes all three to null.
 */
const optionField = z.preprocess(
  (v) => (v === "" || v === undefined ? null : v),
  z.string().nullable(),
);
export const CanonicalMcqOptionsSchema = z.object({
  A: optionField.optional(),
  B: optionField.optional(),
  C: optionField.optional(),
  D: optionField.optional(),
  E: optionField.optional(),
});
export type CanonicalMcqOptions = z.infer<typeof CanonicalMcqOptionsSchema>;

/**
 * Resilient correct_answer schema. Accepts A-E, null, undefined, or empty string;
 * normalizes empty/undefined to null. Models occasionally return "" when they mean
 * "no marked answer" despite our prompt saying null.
 */
export const CorrectAnswerSchema = z.preprocess(
  (v) => (v === "" || v === undefined ? null : v),
  z.enum(OPTION_LETTERS).nullable(),
);

export interface FigureBounds {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
  explanation: string;
  kind: "figure" | "diagram" | "chart" | "table" | "illustration";
}

export interface FigureCrop extends FigureBounds {
  path?: string;
  crop_error?: string;
}

/**
 * Canonical row fields produced by the inline-marked extractor. Custom user fields
 * are attached separately via `extra` — the dynamic zod builder folds them into a
 * single object schema for the model response.
 */
export interface CanonicalMcqRow {
  question_number: string;
  question_text: string;
  options: CanonicalMcqOptions;
  correct_answer: OptionLetter | null;
  marking_style: MarkingStyle;
  mcq_type: McqType;
  multiple_marks_detected: boolean;
  is_partial: boolean;
  confidence: number;
  notes: string;
  source_snippet: string;
  figures?: FigureCrop[];
  /** question_number of the anchor question that provides the shared context, or null if standalone. */
  depends_on?: string | null;
  /** Short label shared by all questions in the same case/scenario/passage group, or null if standalone. */
  context_group?: string | null;
}

/**
 * An extracted row. For MCQ content types, the canonical MCQ fields are populated;
 * for flashcard / qa_pair content types those fields are absent and content-type-specific
 * fields (term/definition or question/answer) appear instead. User-defined custom
 * fields are always merged in by their declared name.
 */
export type ExtractedRow = Record<string, unknown> & Partial<CanonicalMcqRow>;

export interface ExtractedPage {
  page_number: number;
  layout_notes: string;
  rows: ExtractedRow[];
}

export interface ExtractedBatch {
  pages: ExtractedPage[];
}

/**
 * Per-page input to the extractor. The base64 string is the JPEG bytes.
 */
export interface ExtractorPageInput {
  pageNumber: number;
  base64: string;
  mimeType?: string;
  has_images?: boolean;
  /** Number of images the analyzer counted on this page — hints the extractor how many figure boxes to find. */
  expected_image_count?: number;
}

/**
 * Build the bracketed figure hint appended to a page label. Prefers the analyzer's exact
 * count when available so the extractor knows precisely how many figure boxes to produce.
 */
export function pageImageHint(page: ExtractorPageInput): string {
  if (typeof page.expected_image_count === "number" && page.expected_image_count > 0) {
    const n = page.expected_image_count;
    return ` [this page contains ${n} figure/image${n === 1 ? "" : "s"} — emit a bounding box for each]`;
  }
  if (page.has_images) return " [this page contains figures/images]";
  return "";
}
