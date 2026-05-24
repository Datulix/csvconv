import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  loadSchemas,
  type SavedSchemaEntry,
} from "../lib/schemaStorage";
import { getApiKey, loadSettings, type AppSettings } from "../lib/settings";
import {
  cleanupStaging,
  rasterizePdf,
  readImageAsBase64,
  triagePdf,
  type TriageResult,
} from "../lib/pdfApi";
import { type ModelId } from "../lib/models";
import {
  DETECTOR_AUTO_PROCEED_THRESHOLD,
  EXAM_FORMATS,
  FORMAT_LABELS,
  needsManualConfirmation,
  pickSamplePages,
  runDetector,
  type DetectorResult,
  type DetectorSample,
  type ExamFormat,
} from "../pipelines/detector";
import { CONTENT_TYPES, type RunMode } from "../schema/contentTypes";
import {
  estimateCost,
  formatCostRange,
  formatCurrency,
  type CostEstimate,
} from "../lib/cost";
import { runInlineMarkedExtractor } from "../pipelines/extractors/mcq_inlineMarked";
import type { ExtractedBatch } from "../pipelines/extractors/types";
import { runPipeline, type PipelineProgress, type PipelineResult } from "../pipelines/runPipeline";
import type { SplitFailure } from "../pipelines/autoSplit";
import { FailedPageModal } from "./FailedPageModal";

type Phase =
  | { kind: "idle" }
  | { kind: "triaging"; message: string }
  | { kind: "rasterizing"; message: string }
  | { kind: "detecting"; message: string }
  | { kind: "detected"; result: DetectorResult; samples: DetectorSample[] }
  | { kind: "ready_to_extract"; format: ExamFormat | null; detectorResult: DetectorResult | null }
  | { kind: "error"; message: string };

interface ModeOption {
  id: RunMode;
  label: string;
  short: string;
  description: string;
  mcqOnly: boolean;
}

const MODE_OPTIONS: ModeOption[] = [
  {
    id: "extract",
    label: "Extract",
    short: "Just extract the marked answers from the PDF.",
    description:
      "Reads the PDF, identifies questions and marked answers as printed. Cheapest and fastest. Use this for clean answer keys you trust.",
    mcqOnly: false,
  },
  {
    id: "review",
    label: "Review",
    short: "Extract marked answers + have the AI independently solve, then compare.",
    description:
      "Extracts the printed answers AND has the AI answer every question from scratch. The Review UI highlights disagreements between the printed key and the AI's answer.",
    mcqOnly: true,
  },
  {
    id: "answer",
    label: "Answer from scratch",
    short: "Ignore any printed answers. AI solves every question.",
    description:
      "Skips the format detector. Useful for unmarked practice exams: extracts the questions and options, then has the AI provide answers with explanations.",
    mcqOnly: true,
  },
];

function newRunId(): string {
  const c = globalThis.crypto as Crypto & { randomUUID?: () => string };
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function NewConversion({ onOpenInReview }: NewConversionInjectedProps) {
  const [savedSchemas, setSavedSchemas] = useState<SavedSchemaEntry[]>([]);
  const [selectedSchemaName, setSelectedSchemaName] = useState<string | null>(null);
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  const [mode, setMode] = useState<RunMode>("extract");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [triageResult, setTriageResult] = useState<TriageResult | null>(null);
  const [apiKeyPresent, setApiKeyPresent] = useState<boolean>(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [runId, setRunId] = useState<string>(() => newRunId());
  const [testExtract, setTestExtract] = useState<{
    loading: boolean;
    data: ExtractedBatch | null;
    error: string | null;
    pageNumber: number | null;
  }>({ loading: false, data: null, error: null, pageNumber: null });
  const [fullRun, setFullRun] = useState<{
    running: boolean;
    progress: PipelineProgress | null;
    result: PipelineResult | null;
    error: string | null;
  }>({ running: false, progress: null, result: null, error: null });
  const [failedPageDetail, setFailedPageDetail] = useState<SplitFailure | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [list, key, s] = await Promise.all([loadSchemas(), getApiKey(), loadSettings()]);
        setSavedSchemas(list);
        setApiKeyPresent(!!key && key.length > 0);
        setSettings(s);
      } catch (err) {
        console.error("NewConversion init failed", err);
      }
    })();
  }, []);

  const selectedSchema = useMemo(
    () => savedSchemas.find((s) => s.name === selectedSchemaName) ?? null,
    [savedSchemas, selectedSchemaName],
  );

  const contentType = selectedSchema?.content.content_type ?? null;
  const detectorApplies = contentType === "mcq" && mode !== "answer";
  const ctInfo = contentType ? CONTENT_TYPES[contentType] : null;

  // Force mode to "extract" when the schema's content type doesn't support other modes.
  useEffect(() => {
    if (ctInfo && !ctInfo.supportedModes.includes(mode)) {
      setMode("extract");
    }
  }, [ctInfo, mode]);

  const effectiveDetectorModel: ModelId | null = useMemo(() => {
    if (!settings) return null;
    return (settings.detector_model ?? settings.primary_model) as ModelId | null;
  }, [settings]);

  const preflight = useMemo(() => {
    const missing: string[] = [];
    if (!apiKeyPresent) missing.push("API key (set it in Settings)");
    if (!settings?.primary_model) missing.push("primary model (pick one in Settings)");
    if (!selectedSchema) missing.push("a schema (pick one above)");
    if (!pdfPath) missing.push("a PDF file (pick one above)");
    return missing;
  }, [apiKeyPresent, settings, selectedSchema, pdfPath]);

  const costEstimate: CostEstimate | null = useMemo(() => {
    if (!settings || !contentType) return null;
    const pageCount = triageResult?.pages.length ?? 0;
    return estimateCost({
      pageCount,
      mode,
      contentType,
      settings,
    });
  }, [settings, contentType, mode, triageResult]);

  const handlePickFile = useCallback(async () => {
    try {
      const chosen = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      const path = typeof chosen === "string" ? chosen : null;
      if (path) {
        setPdfPath(path);
        setPhase({ kind: "idle" });
        setTriageResult(null);
        setRunId(newRunId());
      }
    } catch (err) {
      console.error("file picker failed", err);
    }
  }, []);

  const handleClearFile = useCallback(async () => {
    if (runId) {
      try {
        await cleanupStaging(runId);
      } catch (err) {
        console.warn("cleanup_staging failed (non-fatal):", err);
      }
    }
    setPdfPath(null);
    setTriageResult(null);
    setPhase({ kind: "idle" });
    setRunId(newRunId());
  }, [runId]);

  const handleStart = useCallback(async () => {
    if (!pdfPath || !selectedSchema || !effectiveDetectorModel || !settings) return;
    try {
      const apiKey = await getApiKey();
      if (!apiKey) {
        setPhase({ kind: "error", message: "API key not found — set it in Settings." });
        return;
      }

      // Always triage first to get page count + triage metadata.
      setPhase({ kind: "triaging", message: "Analyzing PDF (text density, blanks, skew)…" });
      const triage = await triagePdf(pdfPath, runId);
      setTriageResult(triage);

      // For non-MCQ schemas or Answer-from-scratch mode, skip the detector entirely.
      if (!detectorApplies) {
        setPhase({
          kind: "ready_to_extract",
          format: null,
          detectorResult: null,
        });
        return;
      }

      // MCQ + Extract/Review: rasterize sample pages and run the detector.
      const totalPages = triage.pages.length;
      const sampleIndices = pickSamplePages(totalPages);
      if (sampleIndices.length === 0) {
        setPhase({ kind: "error", message: "PDF has no pages." });
        return;
      }

      setPhase({
        kind: "rasterizing",
        message: `Rasterizing ${sampleIndices.length} sample page${
          sampleIndices.length === 1 ? "" : "s"
        } at ${settings.dpi} DPI…`,
      });
      const deskewPairs: Array<[number, number]> = triage.pages
        .filter((p) => Math.abs(p.skew_angle_deg) >= 1.0 && p.page_type === "scanned")
        .map((p) => [p.page_number, p.skew_angle_deg]);
      const deskewPages = deskewPairs.map(([n]) => n);
      const raster = await rasterizePdf({
        path: pdfPath,
        dpi: settings.dpi,
        runId,
        deskewPages,
        skewAngles: deskewPairs,
        onlyPages: sampleIndices,
      });

      const samples: DetectorSample[] = [];
      for (const page of raster.pages) {
        if (page.skipped || !page.path) continue;
        const base64 = await readImageAsBase64(page.path);
        samples.push({ pageNumber: page.page_number, base64, mimeType: "image/jpeg" });
      }
      if (samples.length === 0) {
        setPhase({
          kind: "error",
          message: "Couldn't rasterize any sample pages — the PDF may be blank or corrupted.",
        });
        return;
      }

      setPhase({ kind: "detecting", message: `Asking ${effectiveDetectorModel} to classify…` });
      const result = await runDetector({
        apiKey,
        modelId: effectiveDetectorModel,
        samples,
      });

      setPhase({ kind: "detected", result, samples });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPhase({ kind: "error", message });
    }
  }, [
    pdfPath,
    selectedSchema,
    effectiveDetectorModel,
    settings,
    runId,
    detectorApplies,
  ]);

  const handleConfirmFormat = useCallback(
    (format: ExamFormat) => {
      const detectorResult = phase.kind === "detected" ? phase.result : null;
      setPhase({ kind: "ready_to_extract", format, detectorResult });
    },
    [phase],
  );

  const handleReset = useCallback(() => {
    setPhase({ kind: "idle" });
    setTriageResult(null);
    setTestExtract({ loading: false, data: null, error: null, pageNumber: null });
  }, []);

  const handleTestExtract = useCallback(async () => {
    if (!pdfPath || !selectedSchema || !settings || selectedSchema.content.content_type !== "mcq") {
      return;
    }
    setTestExtract({ loading: true, data: null, error: null, pageNumber: 1 });
    try {
      const apiKey = await getApiKey();
      if (!apiKey) throw new Error("API key not found — set it in Settings.");
      const modelId = (settings.extractor_model ?? settings.primary_model) as ModelId | null;
      if (!modelId) throw new Error("No extractor model configured.");
      const totalPages = triageResult?.pages.length ?? 1;
      const samplePage = Math.min(1, totalPages) || 1;
      const raster = await rasterizePdf({
        path: pdfPath,
        dpi: settings.dpi,
        runId,
        onlyPages: [samplePage],
      });
      const rendered = raster.pages.find((p) => p.page_number === samplePage && !p.skipped);
      if (!rendered || !rendered.path) {
        throw new Error(`Couldn't rasterize page ${samplePage} (it may be blank).`);
      }
      const base64 = await readImageAsBase64(rendered.path);
      const data = await runInlineMarkedExtractor({
        apiKey,
        modelId,
        schema: selectedSchema.content,
        pages: [{ pageNumber: samplePage, base64, mimeType: "image/jpeg" }],
      });
      setTestExtract({ loading: false, data, error: null, pageNumber: samplePage });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTestExtract({ loading: false, data: null, error: message, pageNumber: 1 });
    }
  }, [pdfPath, selectedSchema, settings, runId, triageResult]);

  const isWorking =
    phase.kind === "triaging" || phase.kind === "rasterizing" || phase.kind === "detecting";

  return (
    <div className="new-conversion">
      <h1>New conversion</h1>
      <p className="hint">
        Pick a schema, a PDF, and a mode. The detector identifies how answers are marked (MCQ
        only); subsequent build steps wire the extractor, validator, and solver.
      </p>

      {preflight.length > 0 && phase.kind === "idle" ? (
        <section className="card preflight">
          <strong>Before you can start, you need:</strong>
          <ul>
            {preflight.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="card">
        <label className="block-label">Schema</label>
        {savedSchemas.length === 0 ? (
          <p className="hint">
            No saved schemas yet. Open the <strong>Schemas</strong> tab in the sidebar and create
            one (or apply a preset).
          </p>
        ) : (
          <select
            value={selectedSchemaName ?? ""}
            onChange={(e) => setSelectedSchemaName(e.target.value || null)}
            disabled={phase.kind !== "idle"}
          >
            <option value="">— pick a schema —</option>
            {savedSchemas.map((s) => (
              <option key={s.name} value={s.name}>
                {s.content.name} ({s.content.content_type}, {s.content.fields.length} fields)
              </option>
            ))}
          </select>
        )}
        {selectedSchema && contentType !== "mcq" ? (
          <p className="hint">
            This schema's content_type is <code>{contentType}</code>. The format detector and
            solver only run for MCQ schemas — non-MCQ content types go straight to their
            specialized extractor (build step 19).
          </p>
        ) : null}
      </section>

      <section className="card">
        <label className="block-label">PDF</label>
        {pdfPath ? (
          <div className="file-row">
            <span className="file-path" title={pdfPath}>
              {pdfPath}
            </span>
            <button
              className="btn-secondary small"
              onClick={handleClearFile}
              disabled={isWorking}
            >
              clear
            </button>
          </div>
        ) : (
          <button className="btn-secondary" onClick={handlePickFile}>
            Pick a PDF…
          </button>
        )}
      </section>

      {contentType ? (
        <section className="card">
          <label className="block-label">Mode</label>
          {contentType !== "mcq" ? (
            <p className="hint">
              <code>{contentType}</code> content type only supports <strong>Extract</strong> mode.
              Review and Answer-from-scratch are MCQ-only.
            </p>
          ) : (
            <div className="mode-grid">
              {MODE_OPTIONS.map((m) => {
                const disabled = m.mcqOnly && contentType !== "mcq";
                return (
                  <label
                    key={m.id}
                    className={`mode-card ${mode === m.id ? "selected" : ""} ${
                      disabled ? "disabled" : ""
                    }`}
                  >
                    <input
                      type="radio"
                      name="run-mode"
                      checked={mode === m.id}
                      onChange={() => setMode(m.id)}
                      disabled={disabled || phase.kind !== "idle"}
                    />
                    <div className="mode-title">{m.label}</div>
                    <div className="mode-short">{m.short}</div>
                    <div className="mode-desc">{m.description}</div>
                  </label>
                );
              })}
            </div>
          )}
        </section>
      ) : null}

      {costEstimate && costEstimate.byStage.length > 0 ? (
        <section className="card cost-panel">
          <div className="cost-header">
            <label className="block-label">Estimated cost</label>
            <span className="cost-range">{formatCostRange(costEstimate)}</span>
          </div>
          {triageResult ? (
            <p className="hint">
              Based on {triageResult.pages.length} pages, 4–12 questions per page (rough range).
              Real numbers land in the audit JSON after the run.
            </p>
          ) : (
            <p className="hint">
              Pick a PDF and click <em>Start</em> to refine this estimate using the actual page
              count. Currently shows per-page rates only.
            </p>
          )}
          <ul className="cost-breakdown">
            {costEstimate.byStage.map((s) => (
              <li key={s.stage}>
                <span className="cost-stage">{s.stage}</span>
                <span className="cost-amount">
                  {s.low === s.high ? formatCurrency(s.low) : `${formatCurrency(s.low)} – ${formatCurrency(s.high)}`}
                </span>
                <span className="cost-model">{s.modelId ?? "—"}</span>
                <span className="cost-note">{s.notes}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {phase.kind !== "idle" && phase.kind !== "error" ? (
        <section className="card status-card">
          {isWorking ? (
            <>
              <div className="spinner" />
              <span>{(phase as Extract<Phase, { message: string }>).message}</span>
            </>
          ) : null}
          {phase.kind === "detected" ? (
            <DetectorReadout
              result={phase.result}
              onConfirm={handleConfirmFormat}
              onReset={handleReset}
            />
          ) : null}
          {phase.kind === "ready_to_extract" ? (
            <ReadyToExtractReadout
              mode={mode}
              format={phase.format}
              detectorResult={phase.detectorResult}
              contentType={contentType}
              onReset={handleReset}
              onTestExtract={contentType === "mcq" ? handleTestExtract : null}
              testExtract={testExtract}
              fullRun={fullRun}
              onRunFullPipeline={async () => {
                if (!pdfPath || !selectedSchema || !settings) return;
                setFullRun({ running: true, progress: null, result: null, error: null });
                try {
                  const apiKey = await getApiKey();
                  if (!apiKey) throw new Error("API key not found — set it in Settings.");
                  const result = await runPipeline({
                    apiKey,
                    pdfPath,
                    schema: selectedSchema.content,
                    mode,
                    format: phase.kind === "ready_to_extract" ? phase.format : null,
                    settings,
                    runId,
                    onProgress: (e) => setFullRun((s) => ({ ...s, progress: e })),
                  });
                  setFullRun({ running: false, progress: null, result, error: null });
                } catch (err) {
                  const message = err instanceof Error ? err.message : String(err);
                  setFullRun({ running: false, progress: null, result: null, error: message });
                }
              }}
              onOpenInReview={onOpenInReview}
              onOpenFailedPage={setFailedPageDetail}
            />
          ) : null}
        </section>
      ) : null}

      {phase.kind === "error" ? (
        <section className="card validation-errors">
          <strong>Something went wrong</strong>
          <p className="status error">{phase.message}</p>
          <button className="btn-secondary" onClick={handleReset}>
            Try again
          </button>
        </section>
      ) : null}

      {phase.kind === "idle" ? (
        <div className="action-bar">
          <div className="action-spacer" />
          <button
            className="btn-primary big"
            onClick={handleStart}
            disabled={preflight.length > 0}
          >
            {detectorApplies ? "Start (triage + detect)" : "Start (triage only)"}
          </button>
        </div>
      ) : null}

      {failedPageDetail ? (
        <FailedPageModal
          failure={failedPageDetail}
          onClose={() => setFailedPageDetail(null)}
        />
      ) : null}

      {triageResult ? (
        <section className="card">
          <label className="block-label">Triage summary</label>
          <p className="hint">
            <strong>{triageResult.pdf_type}</strong> · {triageResult.pages.length} pages ·{" "}
            {triageResult.pages.filter((p) => p.is_blank).length} blank ·{" "}
            {triageResult.pages.filter((p) => p.page_type === "scanned").length} scanned ·{" "}
            {
              triageResult.pages.filter((p) => Math.abs(p.skew_angle_deg) >= 1.0).length
            }{" "}
            skewed
          </p>
        </section>
      ) : null}
    </div>
  );
}

interface DetectorReadoutProps {
  result: DetectorResult;
  onConfirm: (format: ExamFormat) => void;
  onReset: () => void;
}

function DetectorReadout({ result, onConfirm, onReset }: DetectorReadoutProps) {
  const [override, setOverride] = useState<ExamFormat>(result.format);
  const mustConfirm = needsManualConfirmation(result);
  const confPct = (result.confidence * 100).toFixed(0);
  const confClass =
    result.confidence >= DETECTOR_AUTO_PROCEED_THRESHOLD ? "conf-high" : "conf-low";

  return (
    <div className="detector-readout">
      <header>
        <h3>Detected: {result.format}</h3>
        <span className={`conf-badge ${confClass}`}>{confPct}% confidence</span>
      </header>

      <p className="format-desc">{FORMAT_LABELS[result.format]}</p>

      <div className="detector-grid">
        <div>
          <span className="label">Columns</span>
          <span>{result.layout.columns}</span>
        </div>
        <div>
          <span className="label">Math present</span>
          <span>{result.layout.has_math ? "yes" : "no"}</span>
        </div>
        <div>
          <span className="label">Language</span>
          <span>{result.layout.primary_language || "?"}</span>
        </div>
        <div>
          <span className="label">~Q per page</span>
          <span>{result.layout.questions_per_page_estimate}</span>
        </div>
      </div>

      {result.notes ? (
        <p className="detector-notes">
          <span className="label">Notes</span> {result.notes}
        </p>
      ) : null}

      {mustConfirm ? (
        <div className="must-confirm">
          <p>
            Low confidence or ambiguous — please confirm or override the format before continuing.
          </p>
          <div className="override-row">
            <select
              value={override}
              onChange={(e) => setOverride(e.target.value as ExamFormat)}
            >
              {EXAM_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <button className="btn-primary" onClick={() => onConfirm(override)}>
              Confirm {override}
            </button>
          </div>
        </div>
      ) : (
        <div className="auto-proceed">
          <p>
            Confidence above {(DETECTOR_AUTO_PROCEED_THRESHOLD * 100).toFixed(0)}% — would
            auto-proceed in a full run.
          </p>
          <div className="override-row">
            <button className="btn-primary" onClick={() => onConfirm(result.format)}>
              Use {result.format}
            </button>
            <select
              value={override}
              onChange={(e) => setOverride(e.target.value as ExamFormat)}
            >
              {EXAM_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <button
              className="btn-secondary"
              onClick={() => onConfirm(override)}
              disabled={override === result.format}
            >
              Use override
            </button>
          </div>
        </div>
      )}

      <div className="action-bar">
        <button className="btn-secondary small" onClick={onReset}>
          Start over
        </button>
      </div>
    </div>
  );
}

interface NewConversionInjectedProps {
  onOpenInReview: (cacheKey: string) => void;
}

interface ReadyToExtractReadoutProps {
  mode: RunMode;
  format: ExamFormat | null;
  detectorResult: DetectorResult | null;
  contentType: string | null;
  onReset: () => void;
  onTestExtract: (() => void) | null;
  testExtract: {
    loading: boolean;
    data: ExtractedBatch | null;
    error: string | null;
    pageNumber: number | null;
  };
  fullRun: {
    running: boolean;
    progress: PipelineProgress | null;
    result: PipelineResult | null;
    error: string | null;
  };
  onRunFullPipeline: () => void;
  onOpenInReview: (cacheKey: string) => void;
  onOpenFailedPage: (failure: SplitFailure) => void;
}

function ReadyToExtractReadout({
  mode,
  format,
  detectorResult,
  contentType,
  onReset,
  onTestExtract,
  testExtract,
  fullRun,
  onRunFullPipeline,
  onOpenInReview,
  onOpenFailedPage,
}: ReadyToExtractReadoutProps) {
  return (
    <div className="ready-readout">
      <h3>Ready to extract</h3>
      <ul className="ready-summary">
        <li>
          <span className="label">content_type</span>
          <code>{contentType ?? "?"}</code>
        </li>
        <li>
          <span className="label">mode</span>
          <code>{mode}</code>
        </li>
        <li>
          <span className="label">format</span>
          <code>{format ?? (mode === "answer" ? "(skipped)" : "n/a for content type")}</code>
        </li>
        {detectorResult ? (
          <li>
            <span className="label">detector confidence</span>
            <code>{(detectorResult.confidence * 100).toFixed(0)}%</code>
          </li>
        ) : null}
      </ul>
      <p className="hint">
        The full streaming pipeline lands in subsequent build steps (validator, solver, compare,
        review UI, export). For now you can sanity-check the extractor pipeline on a single page.
      </p>
      <div className="action-bar">
        <button className="btn-secondary" onClick={onReset} disabled={fullRun.running}>
          Start over
        </button>
        {onTestExtract ? (
          <button
            className="btn-secondary"
            onClick={onTestExtract}
            disabled={testExtract.loading || fullRun.running}
            title="Rasterize and extract one page to verify the prompt + response schema work end-to-end."
          >
            {testExtract.loading
              ? "Running extractor…"
              : `Test extract on page ${testExtract.pageNumber ?? 1}`}
          </button>
        ) : null}
        <button
          className="btn-primary big"
          onClick={onRunFullPipeline}
          disabled={fullRun.running || testExtract.loading}
          title="Run the full pipeline on every page: extract → validate → (review/answer) solve → compare → save rows to cache for review and export."
        >
          {fullRun.running ? "Running pipeline…" : "Run full pipeline"}
        </button>
      </div>

      {fullRun.running && fullRun.progress ? (
        <div className="extract-pending">
          <div className="spinner" />
          <div>
            <strong>{fullRun.progress.stage}:</strong> {fullRun.progress.message}
            {fullRun.progress.done != null && fullRun.progress.total != null ? (
              <span className="hint">
                {" "}
                ({fullRun.progress.done}/{fullRun.progress.total})
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {fullRun.error ? (
        <div className="extract-error">
          <strong>Pipeline failed</strong>
          <p className="status error">{fullRun.error}</p>
        </div>
      ) : null}

      {fullRun.result ? (
        <div className="extract-result">
          <header>
            <strong>Pipeline complete</strong>
            <span className="chip">
              {fullRun.result.summary.rowCount} row{fullRun.result.summary.rowCount === 1 ? "" : "s"} ·{" "}
              {fullRun.result.summary.pageCount} page{fullRun.result.summary.pageCount === 1 ? "" : "s"}
            </span>
            {fullRun.result.summary.needsReviewCount > 0 ? (
              <span className="chip warn">
                {fullRun.result.summary.needsReviewCount} need review
              </span>
            ) : null}
            {fullRun.result.summary.aiNeedsReviewCount > 0 ? (
              <span className="chip warn">
                {fullRun.result.summary.aiNeedsReviewCount} AI uncertain
              </span>
            ) : null}
            {fullRun.result.summary.failedPagesCount > 0 ? (
              <span className="chip warn">
                {fullRun.result.summary.failedPagesCount} page(s) skipped (RECITATION/truncation)
              </span>
            ) : null}
          </header>
          {fullRun.result.failedPages.length > 0 ? (
            <details className="extract-rows-details" open>
              <summary>show {fullRun.result.failedPages.length} failed page(s) — click any to see why</summary>
              <div className="failed-pages-grid">
                {fullRun.result.failedPages.map((f) => (
                  <button
                    type="button"
                    key={f.pageNumber}
                    className="failed-page-card clickable"
                    onClick={() => onOpenFailedPage(f)}
                    title="Click to see full page + diagnostics"
                  >
                    {f.imageBase64 ? (
                      <img
                        src={`data:${f.mimeType ?? "image/jpeg"};base64,${f.imageBase64}`}
                        alt={`Page ${f.pageNumber}`}
                        loading="lazy"
                      />
                    ) : (
                      <div className="failed-page-noimg">no thumbnail</div>
                    )}
                    <div className="failed-page-meta">
                      <span className="label">
                        Page {f.pageNumber}
                        {f.finishReason ? (
                          <span className="chip warn" style={{ marginLeft: 6, fontSize: 9 }}>
                            {f.finishReason}
                          </span>
                        ) : null}
                      </span>
                      <code className="failed-page-reason">{f.reason}</code>
                    </div>
                  </button>
                ))}
              </div>
            </details>
          ) : null}
          {fullRun.result.compareSummary ? (
            <ul className="ready-summary">
              <li>
                <span className="label">agreements</span>
                <code>{fullRun.result.compareSummary.agreements}</code>
              </li>
              <li>
                <span className="label">disagreements</span>
                <code>{fullRun.result.compareSummary.disagreements}</code>
              </li>
              <li>
                <span className="label">ai declined</span>
                <code>{fullRun.result.compareSummary.ai_declined}</code>
              </li>
              <li>
                <span className="label">no marked answer</span>
                <code>{fullRun.result.compareSummary.no_marked_answer}</code>
              </li>
            </ul>
          ) : null}
          <div className="action-bar">
            <button
              className="btn-primary"
              onClick={() => onOpenInReview(fullRun.result!.cacheKey)}
            >
              View in Review →
            </button>
          </div>
        </div>
      ) : null}

      {testExtract.loading ? (
        <div className="extract-pending">
          <div className="spinner" />
          <span>
            Rasterizing + asking the model. First call usually takes 5–15s depending on page
            density.
          </span>
        </div>
      ) : null}

      {testExtract.error ? (
        <div className="extract-error">
          <strong>Test extract failed</strong>
          <p className="status error">{testExtract.error}</p>
        </div>
      ) : null}

      {testExtract.data ? <TestExtractResult batch={testExtract.data} /> : null}
    </div>
  );
}

function TestExtractResult({ batch }: { batch: ExtractedBatch }) {
  const totalRows = batch.pages.reduce((s, p) => s + p.rows.length, 0);
  return (
    <div className="extract-result">
      <header>
        <strong>Test extract succeeded</strong>
        <span className="chip">
          {totalRows} row{totalRows === 1 ? "" : "s"} across {batch.pages.length} page
          {batch.pages.length === 1 ? "" : "s"}
        </span>
      </header>
      {batch.pages.map((page) => (
        <div key={page.page_number} className="extract-page-block">
          <div className="extract-page-header">
            <strong>Page {page.page_number}</strong>
            {page.layout_notes ? (
              <span className="extract-layout-notes">{page.layout_notes}</span>
            ) : null}
            <span className="chip">
              {page.rows.length} row{page.rows.length === 1 ? "" : "s"}
            </span>
          </div>
          {page.rows.length === 0 ? (
            <p className="hint">No rows extracted from this page.</p>
          ) : (
            <details className="extract-rows-details" open={page.rows.length <= 3}>
              <summary>show JSON</summary>
              <pre>{JSON.stringify(page.rows, null, 2)}</pre>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}
