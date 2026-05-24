import { SUPPORTED_MODELS, type ModelId } from "./models";
import type { AppSettings } from "./settings";
import type { RunMode } from "../schema/contentTypes";

/**
 * Cost preview helpers. See SPEC §9.3 — the UI shows a range, not a single number,
 * because real cost depends on questions/page, validator firing rate, and auto-splits.
 */

export type StageId =
  | "detector"
  | "extractor"
  | "validator"
  | "solver";

export interface StageCost {
  stage: StageId;
  low: number;
  high: number;
  modelId: ModelId | null;
  notes: string;
}

export interface CostEstimate {
  low: number;
  high: number;
  byStage: StageCost[];
}

const QUESTIONS_PER_PAGE_LOW = 4;
const QUESTIONS_PER_PAGE_HIGH = 12;
const VALIDATOR_FIRE_RATE_LOW = 0.0;
const VALIDATOR_FIRE_RATE_HIGH = 0.3;
const DETECTOR_SAMPLES = 3;

/**
 * Token estimates per stage, per page. Rough — refined after we see real audit data.
 */
function detectorTokens(samplePages: number) {
  return { input: samplePages * 300 + 200, output: 200 };
}

function extractorTokensPerPage() {
  return { input: 400, output: 300 };
}

function validatorTokensPerReExtraction() {
  return { input: 320, output: 160 };
}

function solverTokensPerQuestion() {
  return { input: 320, output: 400 };
}

function priceFor(modelId: ModelId | null): { input: number; output: number } {
  if (!modelId) return { input: 0, output: 0 };
  const model = SUPPORTED_MODELS.find((m) => m.id === modelId);
  if (!model) return { input: 0, output: 0 };
  return { input: model.inputPricePerMTok, output: model.outputPricePerMTok };
}

function dollarsFromTokens(input: number, output: number, modelId: ModelId | null): number {
  const price = priceFor(modelId);
  return (input / 1_000_000) * price.input + (output / 1_000_000) * price.output;
}

export interface CostInputs {
  pageCount: number;
  mode: RunMode;
  contentType: "mcq" | "flashcard" | "qa_pair";
  settings: AppSettings;
}

function modelForStage(stage: StageId, settings: AppSettings): ModelId | null {
  const map: Record<StageId, ModelId | null> = {
    detector: (settings.detector_model ?? settings.primary_model) as ModelId | null,
    extractor: (settings.extractor_model ?? settings.primary_model) as ModelId | null,
    validator: (settings.validator_model ?? settings.primary_model) as ModelId | null,
    solver: (settings.solver_model ?? settings.primary_model) as ModelId | null,
  };
  return map[stage];
}

export function estimateCost(inputs: CostInputs): CostEstimate {
  const { pageCount, mode, contentType, settings } = inputs;
  const stages: StageCost[] = [];

  const detectorApplies = contentType === "mcq" && mode !== "answer";
  if (detectorApplies) {
    const det = detectorTokens(DETECTOR_SAMPLES);
    const modelId = modelForStage("detector", settings);
    const cost = dollarsFromTokens(det.input, det.output, modelId);
    stages.push({
      stage: "detector",
      low: cost,
      high: cost,
      modelId,
      notes: "Single classification call on 2–3 sample pages.",
    });
  }

  // Extractor runs in every mode (Answer mode still extracts question text + options).
  if (pageCount > 0) {
    const per = extractorTokensPerPage();
    const modelId = modelForStage("extractor", settings);
    const low = dollarsFromTokens(per.input * pageCount, per.output * pageCount, modelId);
    const high = low * 1.5;
    stages.push({
      stage: "extractor",
      low,
      high,
      modelId,
      notes: `~${pageCount} page${pageCount === 1 ? "" : "s"} × per-page token estimate.`,
    });
  }

  // Validator: only when ai_solve isn't the entire story (i.e., extract or review modes that
  // produce a marked_answer; for Answer mode we still validate question_text accuracy).
  if (pageCount > 0 && settings.validator_enabled) {
    const per = validatorTokensPerReExtraction();
    const modelId = modelForStage("validator", settings);
    const qLow = pageCount * QUESTIONS_PER_PAGE_LOW;
    const qHigh = pageCount * QUESTIONS_PER_PAGE_HIGH;
    const reLow = qLow * VALIDATOR_FIRE_RATE_LOW;
    const reHigh = qHigh * VALIDATOR_FIRE_RATE_HIGH;
    const low = dollarsFromTokens(per.input * reLow, per.output * reLow, modelId);
    const high = dollarsFromTokens(per.input * reHigh, per.output * reHigh, modelId);
    stages.push({
      stage: "validator",
      low,
      high,
      modelId,
      notes: "Re-extracts confidence < 0.75 rows. Cross-model if both models configured.",
    });
  }

  if (pageCount > 0 && (mode === "review" || mode === "answer") && contentType === "mcq") {
    const per = solverTokensPerQuestion();
    const modelId = modelForStage("solver", settings);
    const qLow = pageCount * QUESTIONS_PER_PAGE_LOW;
    const qHigh = pageCount * QUESTIONS_PER_PAGE_HIGH;
    const low = dollarsFromTokens(per.input * qLow, per.output * qLow, modelId);
    const high = dollarsFromTokens(per.input * qHigh, per.output * qHigh, modelId);
    stages.push({
      stage: "solver",
      low,
      high,
      modelId,
      notes: "AI independently answers each question (vision input).",
    });
  }

  const low = stages.reduce((s, x) => s + x.low, 0);
  const high = stages.reduce((s, x) => s + x.high, 0);
  return { low, high, byStage: stages };
}

export function formatCurrency(amount: number): string {
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  if (amount < 1) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(2)}`;
}

export function formatCostRange(estimate: CostEstimate): string {
  if (estimate.low === 0 && estimate.high === 0) return "—";
  if (estimate.low === estimate.high) return formatCurrency(estimate.low);
  return `${formatCurrency(estimate.low)} – ${formatCurrency(estimate.high)}`;
}
