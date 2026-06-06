import type { DocumentAnalysisResult, PageMapEntry } from "./documentAnalyzer";

/** Non-MCQ question types the conversion pass can recast into MCQ. */
export type ForeignQuestionType = "matching" | "written" | "true_false";

export interface ConversionInventoryEntry {
  questionType: ForeignQuestionType;
  /** Total questions of this type across the document (from the analyzer's per-page counts). */
  count: number;
  /** 1-based page numbers containing at least one question of this type. */
  pages: number[];
}

const TYPE_LABELS: Record<ForeignQuestionType, string> = {
  matching: "matching",
  written: "written",
  true_false: "true/false",
};

export function foreignTypeLabel(t: ForeignQuestionType): string {
  return TYPE_LABELS[t];
}

function pageCountFor(p: PageMapEntry, type: ForeignQuestionType): number {
  switch (type) {
    case "matching":
      return p.matching_count;
    case "written":
      return p.written_count;
    case "true_false":
      return p.true_false_count;
  }
}

/**
 * Summarize the non-MCQ questions the analyzer found, so the post-generation step can
 * offer to convert them into the schema's format. Counts and pages come from the
 * analyzer's per-page tallies. Only types with at least one question are returned.
 */
export function conversionInventory(analysis: DocumentAnalysisResult): ConversionInventoryEntry[] {
  const types: ForeignQuestionType[] = ["matching", "written", "true_false"];
  const out: ConversionInventoryEntry[] = [];
  for (const type of types) {
    let count = 0;
    const pages: number[] = [];
    for (const p of analysis.page_map) {
      const c = pageCountFor(p, type);
      if (c > 0) {
        count += c;
        pages.push(p.page_number);
      }
    }
    if (count > 0) {
      out.push({ questionType: type, count, pages });
    }
  }
  return out;
}

/**
 * Every page that bears questions, ascending. Conversion sends these to the converter and
 * lets it decide per question (skip real MCQs, convert the rest) — far more reliable than
 * trusting the analyzer's per-type counts, which are shaky for borderline cases like
 * true/false (a 2-option MCQ) that the analyzer often tags as "mcq".
 */
export function questionPages(analysis: DocumentAnalysisResult): number[] {
  const pages = new Set<number>();
  for (const p of analysis.page_map) {
    const hasQuestions =
      p.mcq_count + p.true_false_count + p.written_count + p.matching_count > 0;
    if (p.content_type === "questions" || p.content_type === "mixed" || hasQuestions) {
      pages.add(p.page_number);
    }
  }
  return Array.from(pages).sort((a, b) => a - b);
}
