import { z } from "zod";

/**
 * MCQ format types — used by the document analyzer (which replaced the standalone detector).
 * The LLM-based runDetector and pickSamplePages functions have been removed; format
 * classification now happens inside runDocumentAnalyzer on all pages.
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

export const FORMAT_LABELS: Record<ExamFormat, string> = {
  inline_marked:
    "Options A/B/C/D on the same page, one marked (circled, ticked, underlined, highlighted, crossed, boxed).",
  written_answer:
    "A letter or word printed or written near each question indicates the answer.",
  answer_key_at_end:
    "Questions in the body; a separate answer key (e.g., '1. A  2. C  3. B') on later pages.",
  bubble_sheet: "Separate OMR-style sheet with filled bubbles. (Deferred to v2.)",
  no_answers: "No answer marks visible anywhere in the document.",
  mixed_or_unclear: "Multiple formats present, or the document is too ambiguous to classify.",
};

/** Confidence threshold below which the UI pauses to ask the user to confirm/override. */
export const DETECTOR_AUTO_PROCEED_THRESHOLD = 0.6;

/** Returns true when the UI should pause for manual format confirmation. */
export function needsManualConfirmation(format: ExamFormat, confidence: number): boolean {
  return confidence < DETECTOR_AUTO_PROCEED_THRESHOLD || format === "mixed_or_unclear";
}
