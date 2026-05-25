import { callModel, type ContentPart, type ResponseSchema } from "../lib/modelClient";
import type { ModelId } from "../lib/models";
import type { Schema } from "../schema/types";
import { runInlineMarkedExtractor } from "./extractors/mcq_inlineMarked";
import { runWrittenAnswerExtractor } from "./extractors/mcq_writtenAnswer";
import { runAnswerKeyBodyExtractor } from "./extractors/mcq_answerKeyAtEnd";
import type {
  ExtractedBatch,
  ExtractedPage,
  ExtractedRow,
  ExtractorPageInput,
} from "./extractors/types";

/**
 * Validator (SPEC §6.7).
 *
 * Inline filter: every row passes through. confidence ≥ 0.75 → passes unchanged.
 * confidence < 0.75 → re-extracted, either by the second configured model (cross-model)
 * or by the primary model with a stricter prompt (single-model fallback). Disagreements
 * are flagged in audit; the higher-confidence candidate becomes the canonical row.
 *
 * Trigger is confidence < 0.75 only — no bottom-decile sampling.
 */

export const VALIDATOR_CONFIDENCE_THRESHOLD = 0.75;

export type McqExtractorVariant = "inline_marked" | "written_answer" | "answer_key_at_end";

export interface ValidatorPageInput extends ExtractorPageInput {
  pageNumber: number;
}

export interface ValidatorCandidate {
  source: "primary" | "secondary" | "stricter_reprompt";
  modelId: ModelId;
  row: ExtractedRow;
}

export interface ValidatedRow {
  row: ExtractedRow;
  needs_review: boolean;
  candidates?: ValidatorCandidate[];
}

export interface ValidatedBatch {
  pages: Array<{
    page_number: number;
    layout_notes: string;
    rows: ValidatedRow[];
  }>;
}

export interface RunValidatorArgs {
  apiKey: string;
  primaryModelId: ModelId;
  /**
   * When set and different from primaryModelId, the validator cross-checks low-confidence
   * rows against this model. Otherwise falls back to single-model stricter-prompt re-extract.
   */
  secondaryModelId: ModelId | null;
  schema: Schema;
  format: McqExtractorVariant;
  pages: ValidatorPageInput[];
  /** Initial extractor output for this batch. */
  initial: ExtractedBatch;
  signal?: AbortSignal;
}

/**
 * Runs the validator on a single batch. For low-confidence rows, re-extracts the same
 * pages with either the secondary model or a stricter prompt and compares. Higher-confidence
 * candidate wins; disagreements are flagged.
 */
export async function runValidator(args: RunValidatorArgs): Promise<ValidatedBatch> {
  const lowConfidencePresent = args.initial.pages.some((p) =>
    p.rows.some((r) => typeof r.confidence === "number" && r.confidence < VALIDATOR_CONFIDENCE_THRESHOLD),
  );

  // Fast path: nothing to re-extract.
  if (!lowConfidencePresent) {
    return {
      pages: args.initial.pages.map((p) => ({
        page_number: p.page_number,
        layout_notes: p.layout_notes,
        rows: p.rows.map((row) => ({
          row,
          needs_review: false,
        })),
      })),
    };
  }

  // Otherwise we re-run the extractor on the same pages with either the secondary model
  // or the primary model with an added strict-recheck instruction.
  let secondary: ExtractedBatch;
  let source: ValidatorCandidate["source"];
  let candidateModelId: ModelId;

  if (args.secondaryModelId && args.secondaryModelId !== args.primaryModelId) {
    secondary = await runExtractor(
      args.format,
      {
        apiKey: args.apiKey,
        modelId: args.secondaryModelId,
        schema: args.schema,
        pages: args.pages,
        signal: args.signal,
      },
    );
    source = "secondary";
    candidateModelId = args.secondaryModelId;
  } else {
    secondary = await runStricterReprompt({
      apiKey: args.apiKey,
      modelId: args.primaryModelId,
      schema: args.schema,
      format: args.format,
      pages: args.pages,
      signal: args.signal,
    });
    source = "stricter_reprompt";
    candidateModelId = args.primaryModelId;
  }

  // Reconcile.
  return reconcile(args.initial, secondary, source, candidateModelId, args.primaryModelId);
}

async function runExtractor(
  format: McqExtractorVariant,
  args: {
    apiKey: string;
    modelId: ModelId;
    schema: Schema;
    pages: ExtractorPageInput[];
    signal?: AbortSignal;
  },
): Promise<ExtractedBatch> {
  switch (format) {
    case "inline_marked":
      return runInlineMarkedExtractor(args);
    case "written_answer":
      return runWrittenAnswerExtractor(args);
    case "answer_key_at_end":
      return runAnswerKeyBodyExtractor(args);
  }
}

const STRICTER_REPROMPT_SUFFIX = `

ADDITIONAL STRICT RE-CHECK INSTRUCTION:
You previously processed this exact same page set. One or more rows had low
confidence. Re-extract carefully, paying special attention to:
- The exact letter of the marked answer (or written answer notation).
- Whether multiple marks could be present.
- Whether the question_number you read matches what's actually printed.

If you remain unsure on a specific field, set confidence accordingly and add a
notes string explaining the ambiguity. Do not invent a confident answer to
satisfy the schema.`;

async function runStricterReprompt(args: {
  apiKey: string;
  modelId: ModelId;
  schema: Schema;
  format: McqExtractorVariant;
  pages: ValidatorPageInput[];
  signal?: AbortSignal;
}): Promise<ExtractedBatch> {
  // We approximate the stricter re-prompt by re-running the same extractor with an
  // additional suffix. The extractor functions don't accept extra instructions directly,
  // so we use a thin wrapper that constructs the underlying request manually.
  return runExtractorWithExtraSuffix(args.format, args, STRICTER_REPROMPT_SUFFIX);
}

async function runExtractorWithExtraSuffix(
  format: McqExtractorVariant,
  args: {
    apiKey: string;
    modelId: ModelId;
    schema: Schema;
    pages: ExtractorPageInput[];
    signal?: AbortSignal;
  },
  suffix: string,
): Promise<ExtractedBatch> {
  // Compose the prompt fresh, then call the model directly.
  const { buildInlineMarkedPrompt } = await import("./extractors/mcq_inlineMarked");
  const { buildWrittenAnswerPrompt } = await import("./extractors/mcq_writtenAnswer");
  const { buildAnswerKeyBodyPrompt } = await import("./extractors/mcq_answerKeyAtEnd");
  const { buildMcqResponseSchema, buildMcqZodSchema } = await import("./extractors/schemaBuilders");

  const promptBuilders: Record<McqExtractorVariant, (s: Schema) => string> = {
    inline_marked: buildInlineMarkedPrompt,
    written_answer: buildWrittenAnswerPrompt,
    answer_key_at_end: buildAnswerKeyBodyPrompt,
  };

  const systemInstruction = promptBuilders[format](args.schema) + suffix;
  const responseSchema: ResponseSchema = buildMcqResponseSchema(args.schema);
  const zodSchema = buildMcqZodSchema(args.schema);

  const parts: ContentPart[] = [];
  for (const page of args.pages) {
    parts.push({ kind: "text", text: `PAGE ${page.pageNumber}${page.has_images ? " [this page contains figures/images]" : ""}:` });
    parts.push({
      kind: "image",
      mimeType: page.mimeType ?? "image/jpeg",
      base64: page.base64,
    });
  }

  const result = await callModel<ExtractedBatch>(
    {
      modelId: args.modelId,
      apiKey: args.apiKey,
      systemInstruction,
      parts,
      responseSchema,
      signal: args.signal,
    },
    zodSchema as unknown as Parameters<typeof callModel<ExtractedBatch>>[1],
  );

  return result.data;
}

function reconcile(
  initial: ExtractedBatch,
  secondary: ExtractedBatch,
  source: ValidatorCandidate["source"],
  candidateModelId: ModelId,
  primaryModelId: ModelId,
): ValidatedBatch {
  const secondaryByPage = new Map<number, ExtractedPage>();
  for (const p of secondary.pages) secondaryByPage.set(p.page_number, p);

  return {
    pages: initial.pages.map((pageA) => {
      const pageB = secondaryByPage.get(pageA.page_number);
      const rows: ValidatedRow[] = pageA.rows.map((rowA) => {
        const wasLow =
          typeof rowA.confidence === "number" && rowA.confidence < VALIDATOR_CONFIDENCE_THRESHOLD;
        if (!wasLow) return { row: rowA, needs_review: false };

        const rowB = pageB?.rows.find((r) => r.question_number === rowA.question_number);
        if (!rowB) {
          return {
            row: rowA,
            needs_review: true,
            candidates: [
              { source: "primary", modelId: primaryModelId, row: rowA },
            ],
          };
        }

        // Pick winning candidate by confidence; flag if semantic fields disagree.
        const disagrees =
          rowA.correct_answer !== rowB.correct_answer ||
          rowA.marking_style !== rowB.marking_style;
        const confA = typeof rowA.confidence === "number" ? rowA.confidence : 0;
        const confB = typeof rowB.confidence === "number" ? rowB.confidence : 0;
        const winner = confB > confA ? rowB : rowA;
        return {
          row: { ...winner, figures: (winner.figures as any) ?? (rowA.figures as any) },
          needs_review: disagrees,
          candidates: disagrees
            ? [
                { source: "primary", modelId: primaryModelId, row: rowA },
                { source, modelId: candidateModelId, row: rowB },
              ]
            : undefined,
        };
      });

      return {
        page_number: pageA.page_number,
        layout_notes: pageA.layout_notes,
        rows,
      };
    }),
  };
}
