import type { ExtractedRow } from "./extractors/types";
import type { SolverAnswerMap, SolvedQuestion } from "./solver";

/**
 * Compare stage (SPEC §6.6 Compare convention).
 *
 * Joins solver output with extractor output on `question_number`. Treats the marked
 * answer (from extraction) as truth — the AI's disagreements are findings to inspect,
 * not proof the marked answer is wrong.
 *
 * agreement === null when either side is null (cannot compute):
 *   - ai_answer === null  → "AI declined" (renders with a distinct icon)
 *   - correct_answer === null → "no marked answer" (renders with a distinct icon)
 */

export interface ComparedRow extends ExtractedRow {
  ai_answer: string | null;
  ai_explanation: string;
  ai_confidence: number;
  agreement: boolean | null;
  disagreement_reason: string | null;
  ai_declined: boolean;
}

export interface CompareSummary {
  total: number;
  agreements: number;
  disagreements: number;
  ai_declined: number;
  no_marked_answer: number;
  missing_ai_answer: number;
}

export function compareRow(row: ExtractedRow, solved: SolvedQuestion | undefined): ComparedRow {
  const correctAnswer = (row.correct_answer as string | null | undefined) ?? null;

  if (!solved) {
    return {
      ...row,
      ai_answer: null,
      ai_explanation: "",
      ai_confidence: 0,
      agreement: null,
      disagreement_reason: null,
      ai_declined: false,
    };
  }

  const aiAnswer = solved.ai_answer ?? null;
  const aiDeclined = aiAnswer === null;
  let agreement: boolean | null;
  let disagreement_reason: string | null = null;

  if (correctAnswer === null || aiAnswer === null) {
    agreement = null;
    if (aiDeclined) disagreement_reason = solved.ai_explanation || null;
  } else if (correctAnswer === aiAnswer) {
    agreement = true;
  } else {
    agreement = false;
    disagreement_reason = solved.ai_explanation || null;
  }

  return {
    ...row,
    ai_answer: aiAnswer,
    ai_explanation: solved.ai_explanation,
    ai_confidence: solved.ai_confidence,
    agreement,
    disagreement_reason,
    ai_declined: aiDeclined,
  };
}

/** Join all extracted rows with the solver map, returning compared rows + a summary. */
export function compareAll(
  rows: ExtractedRow[],
  solverMap: SolverAnswerMap,
): { rows: ComparedRow[]; summary: CompareSummary } {
  let agreements = 0;
  let disagreements = 0;
  let ai_declined = 0;
  let no_marked_answer = 0;
  let missing_ai_answer = 0;

  const compared = rows.map((row) => {
    const qn = String(row.question_number ?? "");
    const solved = solverMap.get(qn);
    if (!solved) missing_ai_answer += 1;
    const result = compareRow(row, solved);
    if (result.ai_declined) ai_declined += 1;
    if ((row.correct_answer as string | null) === null) no_marked_answer += 1;
    if (result.agreement === true) agreements += 1;
    else if (result.agreement === false) disagreements += 1;
    return result;
  });

  return {
    rows: compared,
    summary: {
      total: rows.length,
      agreements,
      disagreements,
      ai_declined,
      no_marked_answer,
      missing_ai_answer,
    },
  };
}
