import { z } from "zod";
import { callModel, type ContentPart, type ResponseSchema } from "../lib/modelClient";
import type { ModelId } from "../lib/models";
import { OPTION_LETTERS } from "./prompts";
import type { ExtractedRow, OptionLetter } from "./extractors/types";

/**
 * Solver pipeline (SPEC §6.6).
 *
 * Independently answers MCQ questions. Always vision-enabled — the source page image
 * accompanies the extracted question text/options so the model can see figures,
 * diagrams, and embedded formulas. Per SPEC §4.5, the solver batches by source page.
 *
 * Used in Review mode (where the result is compared against the marked answer) and
 * Answer-from-scratch mode (where it IS the answer).
 */

const SOLVER_PROMPT = `You are independently answering multiple-choice exam questions. For each question
provided, read the question and options carefully (including any figures visible
in the accompanying page image), reason about each option, and choose one answer.

Rules:
- Think step by step about why each option could be correct or incorrect before
  committing to one letter.
- Return exactly one letter (A/B/C/D/E). Do NOT hedge by listing multiple.
- If the question is genuinely unanswerable from the information available,
  return ai_answer=null with an explanation of why.
- ai_confidence reflects YOUR certainty in YOUR answer, not how hard the question
  is. A question can be hard but you can still be highly confident in your reasoning.
- Your explanation should be 1-3 sentences focused on WHY your answer is correct
  and (briefly) why the strongest distractor is wrong.

Return per question: { uid, question_number, ai_answer, ai_explanation, ai_confidence }.
Echo back the \`uid\` EXACTLY as it was given for each question — it is how your
answer is matched to the right question, so it must be copied verbatim.
The page image(s) shown for each question may be referenced by your reasoning.`;

/** Same resilience as CorrectAnswerSchema — normalize "" / undefined → null. */
const AiAnswerSchema = z.preprocess(
  (v) => (v === "" || v === undefined ? null : v),
  z.enum(OPTION_LETTERS).nullable(),
);

export const SolvedQuestionSchema = z.object({
  /** Opaque join key echoed back by the model; correlates the answer to its input row. */
  uid: z.string(),
  question_number: z.string(),
  ai_answer: AiAnswerSchema,
  ai_explanation: z.string(),
  ai_confidence: z.number().min(0).max(1),
});
export type SolvedQuestion = z.infer<typeof SolvedQuestionSchema>;

export const SolverBatchResponseSchema = z.object({
  questions: z.array(SolvedQuestionSchema),
});
export type SolverBatchResponse = z.infer<typeof SolverBatchResponseSchema>;

const SOLVER_RESPONSE_SCHEMA: ResponseSchema = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          uid: { type: "string" },
          question_number: { type: "string" },
          ai_answer: { type: "string", enum: [...OPTION_LETTERS], nullable: true },
          ai_explanation: { type: "string" },
          ai_confidence: { type: "number" },
        },
        required: ["uid", "question_number", "ai_answer", "ai_explanation", "ai_confidence"],
      },
    },
  },
  required: ["questions"],
};

/** Page image used by the solver (the stem page, plus continuation page when is_partial). */
export interface SolverPageImage {
  pageNumber: number;
  base64: string;
  mimeType?: string;
}

/** A question to be solved, with the page image(s) the model should see. */
export interface SolverQuestion {
  /**
   * Stable, globally-unique join key for this row (e.g. `page:rowIndex`). Question
   * numbers are NOT unique across multi-section exams (every section may restart at 1),
   * so the answer is correlated back to its row by this uid, never by question_number.
   */
  uid: string;
  /** The extracted row (we read question_text + options off this). */
  row: ExtractedRow;
  /** Page image(s) backing this question (typically 1, sometimes 2 for is_partial). */
  pageImages: SolverPageImage[];
}

export interface RunSolverArgs {
  apiKey: string;
  modelId: ModelId;
  /** Batch of 5-10 questions, ideally grouped by source page. */
  questions: SolverQuestion[];
  signal?: AbortSignal;
}

export const SOLVER_DEFAULT_BATCH_SIZE = 8;

/**
 * Build the solver request parts. For each question, emits a text block with the
 * question + options + page reference, followed by the page image(s).
 */
function buildSolverParts(questions: SolverQuestion[]): ContentPart[] {
  const parts: ContentPart[] = [];
  questions.forEach((q, idx) => {
    const row = q.row;
    const pageList = q.pageImages.map((p) => p.pageNumber).join(", ");
    const partialNote = (row.is_partial as boolean | undefined) ? " (partial — spans multiple pages)" : "";
    const options = row.options ?? { A: null, B: null, C: null, D: null, E: null };
    const optionLines = (["A", "B", "C", "D", "E"] as const)
      .map((letter) => (options[letter] != null ? `${letter}) ${options[letter]}` : null))
      .filter((s): s is string => s !== null)
      .join("\n");

    parts.push({
      kind: "text",
      text: `QUESTION ${idx + 1} (uid: ${q.uid}) (from PAGE${q.pageImages.length > 1 ? "S" : ""} ${pageList}${partialNote}):\n  uid: ${q.uid}\n  question_number: ${row.question_number}\n  ${row.question_text}\n\nOptions:\n${optionLines}`,
    });
    for (const img of q.pageImages) {
      parts.push({
        kind: "image",
        mimeType: img.mimeType ?? "image/jpeg",
        base64: img.base64,
      });
    }
  });
  return parts;
}

export async function runSolverBatch(args: RunSolverArgs): Promise<SolverBatchResponse> {
  if (args.questions.length === 0) {
    throw new Error("runSolverBatch: no questions provided");
  }
  const parts = buildSolverParts(args.questions);
  const result = await callModel<SolverBatchResponse>(
    {
      modelId: args.modelId,
      apiKey: args.apiKey,
      systemInstruction: SOLVER_PROMPT,
      parts,
      responseSchema: SOLVER_RESPONSE_SCHEMA,
      signal: args.signal,
    },
    SolverBatchResponseSchema,
  );
  return result.data;
}

/**
 * Group questions into solver batches (default 8 questions/batch), keeping
 * same-source-page questions together when possible per SPEC §4.5.
 */
export function planSolverBatches(
  questions: SolverQuestion[],
  batchSize: number = SOLVER_DEFAULT_BATCH_SIZE,
): SolverQuestion[][] {
  if (questions.length === 0) return [];
  // Group by primary source page (the stem page).
  const byPage = new Map<number, SolverQuestion[]>();
  for (const q of questions) {
    const stemPage = q.pageImages[0]?.pageNumber ?? -1;
    const bucket = byPage.get(stemPage) ?? [];
    bucket.push(q);
    byPage.set(stemPage, bucket);
  }

  const pageOrder = Array.from(byPage.keys()).sort((a, b) => a - b);
  const batches: SolverQuestion[][] = [];
  let current: SolverQuestion[] = [];

  for (const page of pageOrder) {
    const bucket = byPage.get(page)!;
    for (const q of bucket) {
      if (current.length >= batchSize) {
        batches.push(current);
        current = [];
      }
      current.push(q);
    }
    // Try to keep page boundaries aligned with batch boundaries when there's room.
    if (current.length >= Math.max(3, batchSize - 2)) {
      batches.push(current);
      current = [];
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Property under which a row's solver join uid is stashed. It is internal pipeline
 * plumbing, not a schema field, so it never appears in the exported CSV (export projects
 * only schema fields). Stable across solve → compare → persist for the same row object.
 */
export const SOLVER_UID_KEY = "__solver_uid";

export function rowSolverUid(row: ExtractedRow): string | undefined {
  return (row as Record<string, unknown>)[SOLVER_UID_KEY] as string | undefined;
}

export function setRowSolverUid(row: ExtractedRow, uid: string): void {
  (row as Record<string, unknown>)[SOLVER_UID_KEY] = uid;
}

/** Convenience: a single solved answer keyed by the question's `uid` (NOT question_number). */
export type SolverAnswerMap = Map<string, SolvedQuestion>;

export function indexSolverResults(responses: SolverBatchResponse[]): SolverAnswerMap {
  const out: SolverAnswerMap = new Map();
  for (const resp of responses) {
    for (const q of resp.questions) {
      out.set(q.uid, q);
    }
  }
  return out;
}

/** Re-export OptionLetter for callers. */
export type { OptionLetter };
