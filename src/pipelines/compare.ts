import type { ExtractedRow } from "./extractors/types";
import { rowSolverUid, type SolverAnswerMap, type SolvedQuestion } from "./solver";
import { parseQuestionNumber, segmentNumberingRuns } from "./sections";

/**
 * Compare stage (SPEC §6.6 Compare convention).
 *
 * Joins solver output with extractor output on each row's solver `uid` (NOT question_number,
 * which is not unique across multi-section exams). Treats the marked answer (from extraction)
 * as truth — the AI's disagreements are findings to inspect, not proof the marked answer is wrong.
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
    const uid = rowSolverUid(row);
    const solved = uid != null ? solverMap.get(uid) : undefined;
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

// ── Per-section answer-key validation (SPEC §6.6 backstop) ──────────────────────────────
//
// The independent solver gives us a second opinion on every question. If one section agrees
// with the AI far less than the rest of the exam, its marked answers were very likely mapped
// to the wrong section — the failure mode you get from an unlabeled multi-section answer key
// even after positional matching, if the key's sections were out of order. We can't know which
// mapping is right, so we don't auto-correct; we flag the whole section for human review.

/** A section below this absolute agreement rate is a candidate for "misaligned". */
const SECTION_MISALIGN_FLOOR = 0.35;
/** ...and it must also be at least this far below the exam's overall agreement rate. */
const SECTION_MISALIGN_REL_MARGIN = 0.3;
/** Need at least this many comparable rows (both answers present) to judge a section. */
const SECTION_MIN_SAMPLE = 5;

export interface SectionAgreement {
  index: number;
  start_question: string;
  end_question: string;
  comparable: number;
  agreements: number;
  rate: number;
  suspect: boolean;
}

/**
 * Group compared rows into numbering-runs (sections) and compute per-section AI agreement.
 * Sections that agree dramatically less than the rest of the exam are flagged
 * (`answer_key_section_suspect` + a note) so the Review UI surfaces them. Returns per-section
 * stats for logging. Mutates the flagged rows in place. Only meaningful in review mode (where
 * `agreement` is populated). No-op for single-section documents.
 */
export function flagMisalignedSections(rows: ComparedRow[]): SectionAgreement[] {
  const runs = segmentNumberingRuns(rows, (r) => parseQuestionNumber(r.question_number));

  let totalAgree = 0;
  let totalComparable = 0;
  const perRun = runs.map((run) => {
    let agree = 0;
    let comparable = 0;
    for (const r of run) {
      if (r.agreement === true) {
        agree += 1;
        comparable += 1;
      } else if (r.agreement === false) {
        comparable += 1;
      }
    }
    totalAgree += agree;
    totalComparable += comparable;
    return { run, agree, comparable };
  });
  const overall = totalComparable > 0 ? totalAgree / totalComparable : 1;

  return perRun.map((s, index) => {
    const rate = s.comparable > 0 ? s.agree / s.comparable : 1;
    const suspect =
      runs.length > 1 &&
      s.comparable >= SECTION_MIN_SAMPLE &&
      rate < SECTION_MISALIGN_FLOOR &&
      rate < overall - SECTION_MISALIGN_REL_MARGIN;

    if (suspect) {
      const note =
        "possible answer-key misalignment: this section agrees with the independent AI far less than the rest of the exam — verify the marked answers";
      for (const r of s.run) {
        (r as Record<string, unknown>).answer_key_section_suspect = true;
        const existing = (r.notes as string | undefined) ?? "";
        if (!existing.includes("possible answer-key misalignment")) {
          r.notes = existing ? `${existing} · ${note}` : note;
        }
      }
    }

    return {
      index,
      start_question: String(s.run[0]?.question_number ?? ""),
      end_question: String(s.run[s.run.length - 1]?.question_number ?? ""),
      comparable: s.comparable,
      agreements: s.agree,
      rate,
      suspect,
    };
  });
}
