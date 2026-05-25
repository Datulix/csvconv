export type ModelId = "gemini-3.1-flash-lite" | "gemma-4-31B-it" | "gemini-3.5-flash";

export type PipelineStage = "detector" | "analyzer" | "extractor" | "validator" | "solver";

export interface ModelInfo {
  id: ModelId;
  label: string;
  vision: boolean;
  inputPricePerMTok: number;
  outputPricePerMTok: number;
  notes?: string;
}

export const SUPPORTED_MODELS: ModelInfo[] = [
  {
    id: "gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash-Lite",
    vision: true,
    inputPricePerMTok: 0.25,
    outputPricePerMTok: 1.5,
    notes: "Purpose-built for structured extraction. Fastest and cheapest.",
  },
  {
    id: "gemma-4-31B-it",
    label: "Gemma 4 31B (instruction-tuned)",
    vision: true,
    inputPricePerMTok: 0.25,
    outputPricePerMTok: 1.0,
    notes: "Open-weights model via Google AI Studio. Confirm pricing in Settings.",
  },
  {
    id: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    vision: true,
    inputPricePerMTok: 0.075,
    outputPricePerMTok: 0.30,
    notes: "Recommended for full-document intelligence analysis. Confirm pricing in Google AI Studio.",
  },
];

export function modelById(id: string | null | undefined): ModelInfo | undefined {
  if (!id) return undefined;
  return SUPPORTED_MODELS.find((m) => m.id === id);
}

export const STAGES: PipelineStage[] = ["detector", "extractor", "validator", "solver"];
