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
} from "../lib/pdfApi";
import { type ModelId } from "../lib/models";
import {
  DETECTOR_AUTO_PROCEED_THRESHOLD,
  EXAM_FORMATS,
  FORMAT_LABELS,
  needsManualConfirmation,
  type ExamFormat,
} from "../pipelines/detector";
import { runDocumentAnalyzer, type DocumentAnalysisResult, type MarkingRegion } from "../pipelines/documentAnalyzer";
import { type RunMode } from "../schema/contentTypes";
import {
  estimateCost,
  formatCostRange,
  formatCurrency,
  type CostEstimate,
} from "../lib/cost";
import { runInlineMarkedExtractor } from "../pipelines/extractors/mcq_inlineMarked";
import type { ExtractedBatch } from "../pipelines/extractors/types";
import type { ExtractorPageInput } from "../pipelines/extractors/types";
import { runPipeline, runConversion, runAnswerFill, type PipelineProgress, type PipelineResult } from "../pipelines/runPipeline";
import { conversionInventory, foreignTypeLabel } from "../pipelines/conversionInventory";
import type { SplitFailure } from "../pipelines/autoSplit";
import { FailedPageModal } from "./FailedPageModal";
import { startTrace, beginPhase, completePhase } from "../lib/pipelineTrace";

interface LogEntry {
  ts: number;
  stage: string;
  message: string;
  done?: number;
  total?: number;
  level: "info" | "error";
}

type Phase =
  | { kind: "idle" }
  | { kind: "analyzing"; message: string }
  | { kind: "analyzed"; result: DocumentAnalysisResult; pageImages: ExtractorPageInput[] }
  | { kind: "ready_to_extract"; format: ExamFormat; markingRegions: MarkingRegion[]; analysis: DocumentAnalysisResult; pageImages: ExtractorPageInput[] }
  | { kind: "error"; message: string };

function newRunId(): string {
  const c = globalThis.crypto as Crypto & { randomUUID?: () => string };
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function NewConversion({ onOpenInReview, active }: NewConversionInjectedProps) {
  const [savedSchemas, setSavedSchemas] = useState<SavedSchemaEntry[]>([]);
  const [selectedSchemaName, setSelectedSchemaName] = useState<string | null>(null);
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  // Layered run controls. Extraction always runs. Review adds an independent AI solve
  // for confidence + disagreement flagging (default on). AI-authoritative makes the AI's
  // answer the final one (override).
  const [reviewEnabled, setReviewEnabled] = useState(true);
  const [aiAuthoritative, setAiAuthoritative] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
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
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  // Post-generation conversion of foreign question types (matching → MCQ for now).
  const [optionCount, setOptionCount] = useState(4);
  const [conversion, setConversion] = useState<{
    status: "idle" | "running" | "done" | "error";
    message?: string;
    addedCount?: number;
  }>({ status: "idle" });
  const [answerFill, setAnswerFill] = useState<{
    status: "idle" | "running" | "done" | "error";
    message?: string;
    filledCount?: number;
  }>({ status: "idle" });

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

  // This tab stays mounted across switches, so its mount-only load goes stale when the
  // user adds a schema elsewhere. Re-fetch saved schemas each time the tab becomes active.
  useEffect(() => {
    if (!active) return;
    loadSchemas()
      .then(setSavedSchemas)
      .catch((err) => console.error("refreshing schemas failed", err));
  }, [active]);

  const selectedSchema = useMemo(
    () => savedSchemas.find((s) => s.name === selectedSchemaName) ?? null,
    [savedSchemas, selectedSchemaName],
  );

  const contentType = selectedSchema?.content.content_type ?? null;

  // Derive the pipeline's RunMode from the two layered toggles.
  const mode: RunMode = aiAuthoritative ? "answer" : reviewEnabled ? "review" : "extract";

  const effectiveAnalyzerModel: ModelId | null = useMemo(() => {
    if (!settings) return null;
    return (settings.analyzer_model ?? settings.primary_model) as ModelId | null;
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
    const pageCount = phase.kind === "analyzed" ? phase.pageImages.length
      : phase.kind === "ready_to_extract" ? phase.pageImages.length
      : 0;
    return estimateCost({
      pageCount,
      mode,
      contentType,
      settings,
    });
  }, [settings, contentType, mode, phase]);

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
    setPhase({ kind: "idle" });
    setRunId(newRunId());
  }, [runId]);

  const handleStart = useCallback(async () => {
    if (!pdfPath || !selectedSchema || !effectiveAnalyzerModel || !settings) return;
    try {
      const apiKey = await getApiKey();
      if (!apiKey) {
        setPhase({ kind: "error", message: "API key not found — set it in Settings." });
        return;
      }

      const pdfName = pdfPath.replace(/\\/g, "/").split("/").pop() ?? pdfPath;

      // For Answer-from-scratch mode on MCQ, or non-MCQ content types, the analysis
      // still runs (we want the full structural map) but format confirmation is skipped.
      setPhase({ kind: "analyzing", message: "Rasterizing PDF pages…" });

      // Rasterize all pages unconditionally — the analyzer sees the whole document
      const raster = await rasterizePdf({
        path: pdfPath,
        dpi: settings.dpi,
        runId,
      });

      const pageImages: ExtractorPageInput[] = [];
      for (const p of raster.pages) {
        if (p.skipped || !p.path) continue;
        const base64 = await readImageAsBase64(p.path);
        pageImages.push({ pageNumber: p.page_number, base64, mimeType: "image/jpeg" });
      }

      if (pageImages.length === 0) {
        setPhase({ kind: "error", message: "Couldn't rasterize any pages — the PDF may be blank or corrupted." });
        return;
      }

      setPhase({ kind: "analyzing", message: `Analyzing ${pageImages.length} pages with ${effectiveAnalyzerModel}…` });

      startTrace({
        runId,
        pdfPath,
        pdfName,
        mode,
        format: null,
        contentType: selectedSchema.content.content_type,
        schemaName: selectedSchema.content.name,
        startedAt: Date.now(),
      });
      beginPhase("analyze", "Document Analysis", "ai", { pageCount: pageImages.length, modelId: effectiveAnalyzerModel });

      const analysis = await runDocumentAnalyzer({
        apiKey,
        modelId: effectiveAnalyzerModel,
        pages: pageImages,
        pdfName,
      });
      completePhase("analyze", analysis);

      // For Answer mode, skip format confirmation and go straight to ready_to_extract
      // using the analyzer's detected format (or a sensible default).
      const regions = analysis.marking_regions ?? [];
      const isMultiRegion = regions.length > 1;
      const mustConfirm = needsManualConfirmation(
        analysis.marking_format,
        analysis.marking_format_confidence,
      );
      // Skip the format-confirmation gate whenever there's nothing to decide: answer mode,
      // non-MCQ, or a confident single-region detection. Only stop to ask when the detector
      // is genuinely unsure (low confidence) or the document mixes marking methods.
      if (mode === "answer" || contentType !== "mcq" || (!mustConfirm && !isMultiRegion)) {
        const format = analysis.marking_format === "mixed_or_unclear" ? "inline_marked" : analysis.marking_format;
        setPhase({ kind: "ready_to_extract", format, markingRegions: regions, analysis, pageImages });
        return;
      }

      setPhase({ kind: "analyzed", result: analysis, pageImages });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPhase({ kind: "error", message });
    }
  }, [
    pdfPath,
    selectedSchema,
    effectiveAnalyzerModel,
    settings,
    runId,
    mode,
    contentType,
  ]);

  const handleConfirmFormat = useCallback(
    (format: ExamFormat, markingRegions: MarkingRegion[]) => {
      if (phase.kind !== "analyzed") return;
      setPhase({ kind: "ready_to_extract", format, markingRegions, analysis: phase.result, pageImages: phase.pageImages });
    },
    [phase],
  );

  const handleReset = useCallback(() => {
    setPhase({ kind: "idle" });
    setTestExtract({ loading: false, data: null, error: null, pageNumber: null });
  }, []);

  const handleTestExtract = useCallback(async () => {
    if (!pdfPath || !selectedSchema || !settings) {
      return;
    }
    setTestExtract({ loading: true, data: null, error: null, pageNumber: 1 });
    try {
      const apiKey = await getApiKey();
      if (!apiKey) throw new Error("API key not found — set it in Settings.");
      const modelId = (settings.extractor_model ?? settings.primary_model) as ModelId | null;
      if (!modelId) throw new Error("No extractor model configured.");

      // Use the first non-blank page from the analysis if available
      const pageImages = phase.kind === "ready_to_extract" ? phase.pageImages
        : phase.kind === "analyzed" ? phase.pageImages
        : null;
      const firstPage = pageImages?.[0];
      if (!firstPage) throw new Error("No page images available for test extract.");

      const data = await runInlineMarkedExtractor({
        apiKey,
        modelId,
        schema: selectedSchema.content,
        pages: [firstPage],
      });
      setTestExtract({ loading: false, data, error: null, pageNumber: firstPage.pageNumber });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTestExtract({ loading: false, data: null, error: message, pageNumber: 1 });
    }
  }, [pdfPath, selectedSchema, settings, phase]);

  const isWorking = phase.kind === "analyzing";

  return (
    <div className="new-conversion">
      <h1>New conversion</h1>
      <p className="hint">
        Pick a schema, a PDF, and a mode. The document analyzer reads every page first to understand
        the structure; subsequent steps wire the extractor, validator, and solver.
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

      <div className="new-conversion-grid">
        <div className="new-conversion-sidebar">
          {/* Card: Schema */}
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
                    {s.content.name} ({s.content.fields.length} fields)
                  </option>
                ))}
              </select>
            )}
          </section>

          {/* Card: PDF */}
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

          {/* Card: Run options */}
          {contentType ? (
            <section className="card">
              <label className="block-label">Run options</label>
              <p className="hint">
                Extraction always runs — questions and any printed answers are read from the PDF.
              </p>
              <label className={`toggle-row ${phase.kind !== "idle" ? "disabled" : ""}`}>
                <input
                  type="checkbox"
                  checked={reviewEnabled || aiAuthoritative}
                  disabled={aiAuthoritative || phase.kind !== "idle"}
                  onChange={(e) => setReviewEnabled(e.target.checked)}
                />
                <div className="toggle-text">
                  <div className="toggle-title">AI review for confidence</div>
                  <div className="toggle-desc">
                    The AI independently solves each question and compares to the printed answer,
                    scoring confidence and flagging disagreements. Doubles solver cost.
                  </div>
                </div>
              </label>
              <label className={`toggle-row ${phase.kind !== "idle" ? "disabled" : ""}`}>
                <input
                  type="checkbox"
                  checked={aiAuthoritative}
                  disabled={phase.kind !== "idle"}
                  onChange={(e) => setAiAuthoritative(e.target.checked)}
                />
                <div className="toggle-text">
                  <div className="toggle-title">AI answers (override printed answers)</div>
                  <div className="toggle-desc">
                    The AI's answer becomes the final answer for every question, overriding any mark
                    on the page. Use for unmarked practice exams or to regenerate an answer key.
                  </div>
                </div>
              </label>
            </section>
          ) : null}

          {/* Card: Cost Estimate */}
          {costEstimate && costEstimate.byStage.length > 0 ? (
            <section className="card cost-panel">
              <div className="cost-header">
                <label className="block-label">Estimated cost</label>
                <span className="cost-range">{formatCostRange(costEstimate)}</span>
              </div>
              {phase.kind === "analyzed" || phase.kind === "ready_to_extract" ? (
                <p className="hint">
                  Based on {phase.pageImages.length} pages, 4–12 questions per page (rough range).
                  Real numbers land in the audit JSON after the run.
                </p>
              ) : (
                <p className="hint">
                  Pick a PDF and click <em>Start Analysis</em> to refine this estimate using the actual
                  page count. Currently shows per-page rates only.
                </p>
              )}
              <ul className="cost-breakdown">
                {costEstimate.byStage.map((s) => (
                  <li key={s.stage} className="cost-item">
                    <div className="cost-item-main">
                      <span className="cost-stage">{s.stage}</span>
                      <span className="cost-amount">
                        {s.low === s.high ? formatCurrency(s.low) : `${formatCurrency(s.low)} – ${formatCurrency(s.high)}`}
                      </span>
                      <span className="cost-model">{s.modelId ?? "—"}</span>
                    </div>
                    {s.notes ? <div className="cost-note">{s.notes}</div> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <div className="new-conversion-main">
          {/* Status/Readout card */}
          {phase.kind !== "idle" && phase.kind !== "error" ? (
            <section className="card status-card">
              {isWorking ? (
                <div style={{ display: "flex", gap: "10px", alignItems: "center", width: "100%" }}>
                  <div className="spinner" />
                  <span>{(phase as Extract<Phase, { message: string }>).message}</span>
                </div>
              ) : null}
              {phase.kind === "analyzed" ? (
                <AnalysisReadout
                  result={phase.result}
                  onConfirm={handleConfirmFormat}
                  onReset={handleReset}
                />
              ) : null}
              {phase.kind === "ready_to_extract" ? (
                <ReadyToExtractReadout
                  mode={mode}
                  format={phase.format}
                  analysis={phase.analysis}
                  contentType={contentType}
                  onReset={handleReset}
                  onTestExtract={handleTestExtract}
                  testExtract={testExtract}
                  fullRun={fullRun}
                  onRunFullPipeline={async () => {
                    if (!pdfPath || !selectedSchema || !settings || phase.kind !== "ready_to_extract") return;
                    setLogs([]);
                    setConversion({ status: "idle" });
                    setAnswerFill({ status: "idle" });
                    setFullRun({ running: true, progress: null, result: null, error: null });
                    try {
                      const apiKey = await getApiKey();
                      if (!apiKey) throw new Error("API key not found — set it in Settings.");
                      const result = await runPipeline({
                        apiKey,
                        pdfPath,
                        schema: selectedSchema.content,
                        mode,
                        format: phase.format,
                        markingRegions: phase.markingRegions,
                        settings,
                        runId,
                        documentAnalysis: phase.analysis,
                        onProgress: (e) => {
                          setFullRun((s) => ({ ...s, progress: e }));
                          setLogs((prev) => [...prev, { ts: Date.now(), stage: e.stage, message: e.message, done: e.done, total: e.total, level: "info" }]);
                        },
                      });
                      setLogs((prev) => [...prev, { ts: Date.now(), stage: "done", message: `Complete — ${result.summary.rowCount} rows, ${result.summary.pageCount} pages.`, level: "info" }]);
                      setFullRun({ running: false, progress: null, result, error: null });
                    } catch (err) {
                      const message = err instanceof Error ? err.message : String(err);
                      setLogs((prev) => [...prev, { ts: Date.now(), stage: "error", message, level: "error" }]);
                      setFullRun({ running: false, progress: null, result: null, error: message });
                    }
                  }}
                  onOpenInReview={onOpenInReview}
                  onOpenFailedPage={setFailedPageDetail}
                  logs={logs}
                  showLogs={showLogs}
                  onToggleLogs={() => setShowLogs((v) => !v)}
                />
              ) : null}
            </section>
          ) : null}

          {/* Post-generation conversion card — only for MCQ-focused schemas. */}
          {phase.kind === "ready_to_extract" && fullRun.result && !fullRun.running && contentType === "mcq"
            ? (() => {
                const inventory = conversionInventory(phase.analysis);
                const summary = inventory
                  .map((e) => `${e.count} ${foreignTypeLabel(e.questionType)}`)
                  .join(", ");
                const analysis = phase.analysis;
                const pageImages = phase.pageImages;
                return (
                  <section className="card conversion-card">
                    <label className="block-label">Normalize to MCQ</label>
                    <p className="hint">
                      Convert any matching, written, or true/false questions into MCQs shaped to your
                      schema. Runs over every question page and skips questions that are already MCQ.
                      {summary ? <> Analyzer estimate: <strong>{summary}</strong>.</> : null}
                    </p>

                    {conversion.status === "done" ? (
                      <p className="status saved">
                        {conversion.addedCount && conversion.addedCount > 0
                          ? `Added ${conversion.addedCount} converted MCQ row${conversion.addedCount === 1 ? "" : "s"}. Open in Review to see them.`
                          : conversion.message === "skipped"
                          ? "Skipped — no conversion run."
                          : "Nothing to convert — every question was already in MCQ form."}
                      </p>
                    ) : (
                      <>
                        <p className="hint conversion-omit">
                          Matching keeps real distractors; written/true-false generate distractors
                          (flagged for review). True/false stays two-option.
                        </p>
                        <div className="conversion-controls">
                          <label className="conversion-optcount">
                            Options per question
                            <input
                              type="number"
                              min={2}
                              max={5}
                              value={optionCount}
                              disabled={conversion.status === "running"}
                              onChange={(ev) =>
                                setOptionCount(Math.max(2, Math.min(5, Number(ev.target.value) || 4)))
                              }
                            />
                          </label>
                          <div className="conversion-actions">
                            <button
                              className="btn-primary"
                              disabled={conversion.status === "running"}
                              onClick={async () => {
                                const result = fullRun.result;
                                if (!result || !selectedSchema || !settings) return;
                                setConversion({ status: "running" });
                                try {
                                  const apiKey = await getApiKey();
                                  if (!apiKey) throw new Error("API key not found — set it in Settings.");
                                  const res = await runConversion({
                                    apiKey,
                                    schema: selectedSchema.content,
                                    settings,
                                    cacheKey: result.cacheKey,
                                    pageImages,
                                    analysis,
                                    existingPages: result.pages,
                                    optionCount,
                                    onProgress: (ev) =>
                                      setLogs((prev) => [
                                        ...prev,
                                        { ts: Date.now(), stage: ev.stage, message: ev.message, level: "info" },
                                      ]),
                                  });
                                  setFullRun((s) =>
                                    s.result
                                      ? {
                                          ...s,
                                          result: {
                                            ...s.result,
                                            summary: {
                                              ...s.result.summary,
                                              rowCount: s.result.summary.rowCount + res.addedCount,
                                              needsReviewCount:
                                                s.result.summary.needsReviewCount + res.addedCount,
                                            },
                                          },
                                        }
                                      : s,
                                  );
                                  setConversion({ status: "done", addedCount: res.addedCount });
                                } catch (err) {
                                  const message = err instanceof Error ? err.message : String(err);
                                  setLogs((prev) => [...prev, { ts: Date.now(), stage: "convert", message, level: "error" }]);
                                  setConversion({ status: "error", message });
                                }
                              }}
                            >
                              {conversion.status === "running" ? "Converting…" : "Convert all → MCQ"}
                            </button>
                            <button
                              className="btn-secondary"
                              disabled={conversion.status === "running"}
                              onClick={() => setConversion({ status: "done", addedCount: 0, message: "skipped" })}
                            >
                              Skip
                            </button>
                          </div>
                        </div>

                        {conversion.status === "error" ? (
                          <p className="status error">{conversion.message}</p>
                        ) : null}
                      </>
                    )}
                  </section>
                );
              })()
            : null}

          {/* Post-generation answer-fill card */}
          {phase.kind === "ready_to_extract" && fullRun.result && !fullRun.running
            ? (() => {
                const pageImages = phase.pageImages;
                return (
                  <section className="card conversion-card">
                    <label className="block-label">Fill answers with AI</label>
                    <p className="hint">
                      Have the AI answer any questions that came out without an answer (e.g. this
                      unmarked exam) and fill the empty answer fields. Existing answers are kept;
                      filled rows are flagged for review.
                    </p>
                    {answerFill.status === "done" ? (
                      <p className="status saved">
                        {answerFill.filledCount && answerFill.filledCount > 0
                          ? `Filled answers for ${answerFill.filledCount} question${answerFill.filledCount === 1 ? "" : "s"}. Open in Review to see them.`
                          : "Nothing to fill — every question already had an answer."}
                      </p>
                    ) : (
                      <div className="conversion-controls">
                        <div className="conversion-actions">
                          <button
                            className="btn-primary"
                            disabled={answerFill.status === "running"}
                            onClick={async () => {
                              const result = fullRun.result;
                              if (!result || !selectedSchema || !settings) return;
                              setAnswerFill({ status: "running" });
                              try {
                                const apiKey = await getApiKey();
                                if (!apiKey) throw new Error("API key not found — set it in Settings.");
                                const res = await runAnswerFill({
                                  apiKey,
                                  schema: selectedSchema.content,
                                  settings,
                                  cacheKey: result.cacheKey,
                                  pageImages,
                                  existingPages: result.pages,
                                  onProgress: (ev) =>
                                    setLogs((prev) => [
                                      ...prev,
                                      { ts: Date.now(), stage: ev.stage, message: ev.message, level: "info" },
                                    ]),
                                });
                                setFullRun((s) =>
                                  s.result
                                    ? {
                                        ...s,
                                        result: {
                                          ...s.result,
                                          summary: {
                                            ...s.result.summary,
                                            needsReviewCount:
                                              s.result.summary.needsReviewCount + res.filledCount,
                                          },
                                        },
                                      }
                                    : s,
                                );
                                setAnswerFill({ status: "done", filledCount: res.filledCount });
                              } catch (err) {
                                const message = err instanceof Error ? err.message : String(err);
                                setLogs((prev) => [...prev, { ts: Date.now(), stage: "answer_fill", message, level: "error" }]);
                                setAnswerFill({ status: "error", message });
                              }
                            }}
                          >
                            {answerFill.status === "running" ? "Answering…" : "Fill answers with AI"}
                          </button>
                        </div>
                        {answerFill.status === "error" ? (
                          <p className="status error">{answerFill.message}</p>
                        ) : null}
                      </div>
                    )}
                  </section>
                );
              })()
            : null}

          {/* Validation errors card */}
          {phase.kind === "error" ? (
            <section className="card validation-errors">
              <strong>Something went wrong</strong>
              <p className="status error">{phase.message}</p>
              <button className="btn-secondary" onClick={handleReset}>
                Try again
              </button>
            </section>
          ) : null}

          {/* Start Analysis CTA when idle */}
          {phase.kind === "idle" ? (
            <div className="card start-analysis-card">
              <h3>Start Document Analysis</h3>
              <p>
                Once you select a schema and a PDF document, click the button below to start the analysis phase.
                The AI will scan the layout, detect the structure, and identify the question format.
              </p>
              <button
                className="btn-primary big"
                onClick={handleStart}
                disabled={preflight.length > 0}
              >
                Start Analysis
              </button>
            </div>
          ) : null}
        </div>
      </div>


      {failedPageDetail ? (
        <FailedPageModal
          failure={failedPageDetail}
          onClose={() => setFailedPageDetail(null)}
        />
      ) : null}
    </div>
  );
}

// ─── Analysis Readout ────────────────────────────────────────────────────────

interface AnalysisReadoutProps {
  result: DocumentAnalysisResult;
  onConfirm: (format: ExamFormat, markingRegions: MarkingRegion[]) => void;
  onReset: () => void;
}

function AnalysisReadout({ result, onConfirm, onReset }: AnalysisReadoutProps) {
  const regions = result.marking_regions ?? [];
  const isMultiRegion = regions.length > 1;
  const [override, setOverride] = useState<ExamFormat>(result.marking_format);
  // Per-region format overrides (only used when the document mixes marking methods).
  const [regionFormats, setRegionFormats] = useState<ExamFormat[]>(() =>
    regions.map((r) => r.marking_format),
  );
  const mustConfirm = needsManualConfirmation(result.marking_format, result.marking_format_confidence);
  const confPct = (result.marking_format_confidence * 100).toFixed(0);
  const confClass = result.marking_format_confidence >= DETECTOR_AUTO_PROCEED_THRESHOLD ? "conf-high" : "conf-low";

  // Build the marking regions to hand downstream, applying any per-region overrides.
  const editedRegions = (): MarkingRegion[] =>
    regions.map((r, i) => ({ ...r, marking_format: regionFormats[i] ?? r.marking_format }));

  return (
    <div className="detector-readout">
      <header>
        <h3>Analysis complete</h3>
      </header>

      {result.document_summary ? (
        <p className="format-desc">{result.document_summary}</p>
      ) : null}

      <div className="detector-grid">
        <div>
          <span className="label">Total questions</span>
          <span>{result.total_questions ?? "?"}</span>
        </div>
        <div>
          <span className="label">MCQ</span>
          <span>{result.total_mcq_count ?? "?"}</span>
        </div>
        <div>
          <span className="label">True/False</span>
          <span>{result.total_true_false_count ?? 0}</span>
        </div>
        <div>
          <span className="label">Written</span>
          <span>{result.total_written_count ?? 0}</span>
        </div>
        <div>
          <span className="label">Answer key present</span>
          <span>{result.has_answer_key ? "yes" : "no"}</span>
        </div>
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
      </div>

      {/* Per-page breakdown */}
      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: "pointer", fontWeight: 500 }}>
          Per-page breakdown ({result.page_map.length} pages)
        </summary>
        <div style={{ overflowX: "auto", marginTop: 8 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
                <th style={{ padding: "4px 8px" }}>Page</th>
                <th style={{ padding: "4px 8px" }}>Type</th>
                <th style={{ padding: "4px 8px" }}>Summary</th>
                <th style={{ padding: "4px 8px" }}>MCQ</th>
                <th style={{ padding: "4px 8px" }}>T/F</th>
                <th style={{ padding: "4px 8px" }}>Written</th>
                <th style={{ padding: "4px 8px" }}>Match</th>
                <th style={{ padding: "4px 8px" }}>Img</th>
              </tr>
            </thead>
            <tbody>
              {result.page_map.map((p) => (
                <tr key={p.page_number} style={{ borderBottom: "1px solid var(--border-faint)" }}>
                  <td style={{ padding: "3px 8px", fontVariantNumeric: "tabular-nums" }}>{p.page_number}</td>
                  <td style={{ padding: "3px 8px" }}>
                    <code style={{ fontSize: 11 }}>{p.content_type}</code>
                  </td>
                  <td style={{ padding: "3px 8px", color: "var(--fg-secondary)" }}>{p.page_summary}</td>
                  <td style={{ padding: "3px 8px", textAlign: "center" }}>{p.mcq_count || ""}</td>
                  <td style={{ padding: "3px 8px", textAlign: "center" }}>{p.true_false_count || ""}</td>
                  <td style={{ padding: "3px 8px", textAlign: "center" }}>{p.written_count || ""}</td>
                  <td style={{ padding: "3px 8px", textAlign: "center" }}>{p.matching_count || ""}</td>
                  <td style={{ padding: "3px 8px", textAlign: "center" }}>{p.image_count || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {/* Detected marking format */}
      <div style={{ marginTop: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <strong>Detected format:</strong>
          <code>{result.marking_format}</code>
          <span className={`conf-badge ${confClass}`}>{confPct}% confidence</span>
        </div>
        <p className="format-desc">{FORMAT_LABELS[result.marking_format]}</p>
        {result.marking_format_notes ? (
          <p className="detector-notes">
            <span className="label">Notes</span> {result.marking_format_notes}
          </p>
        ) : null}
      </div>

      {isMultiRegion ? (
        <div className="must-confirm">
          <p>
            This document uses <strong>different marking methods across sections</strong>. Each
            range below will be extracted with its own method — confirm or override each before continuing.
          </p>
          <div style={{ overflowX: "auto", marginTop: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
                  <th style={{ padding: "4px 8px" }}>Questions</th>
                  <th style={{ padding: "4px 8px" }}>Marking method</th>
                  <th style={{ padding: "4px 8px" }}>Conf.</th>
                  <th style={{ padding: "4px 8px" }}>Notes</th>
                </tr>
              </thead>
              <tbody>
                {regions.map((r, i) => (
                  <tr key={`${r.question_range_start}-${r.question_range_end}-${i}`} style={{ borderBottom: "1px solid var(--border-faint)" }}>
                    <td style={{ padding: "3px 8px", fontVariantNumeric: "tabular-nums" }}>
                      {r.question_range_start}–{r.question_range_end}
                    </td>
                    <td style={{ padding: "3px 8px" }}>
                      <select
                        value={regionFormats[i] ?? r.marking_format}
                        onChange={(e) =>
                          setRegionFormats((prev) => {
                            const next = [...prev];
                            next[i] = e.target.value as ExamFormat;
                            return next;
                          })
                        }
                      >
                        {EXAM_FORMATS.map((f) => (
                          <option key={f} value={f}>
                            {f}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ padding: "3px 8px" }}>{(r.confidence * 100).toFixed(0)}%</td>
                    <td style={{ padding: "3px 8px", color: "var(--fg-secondary)" }}>{r.notes ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="override-row" style={{ marginTop: 8 }}>
            <button className="btn-primary" onClick={() => onConfirm(result.marking_format, editedRegions())}>
              Confirm {regions.length} regions
            </button>
          </div>
        </div>
      ) : mustConfirm ? (
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
            <button className="btn-primary" onClick={() => onConfirm(override, editedRegions())}>
              Confirm {override}
            </button>
          </div>
        </div>
      ) : (
        <div className="auto-proceed">
          <p>
            Confidence above {(DETECTOR_AUTO_PROCEED_THRESHOLD * 100).toFixed(0)}% — format confirmed automatically.
          </p>
          <div className="override-row">
            <button className="btn-primary" onClick={() => onConfirm(result.marking_format, editedRegions())}>
              Use {result.marking_format}
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
              onClick={() => onConfirm(override, editedRegions())}
              disabled={override === result.marking_format}
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

// ─── Injected props types ────────────────────────────────────────────────────

interface NewConversionInjectedProps {
  onOpenInReview: (cacheKey: string) => void;
  /** True while this tab is the visible view. The component stays mounted across tab
   *  switches, so we use this to re-fetch saved schemas when the user returns. */
  active?: boolean;
}

// ─── Ready to Extract Readout ────────────────────────────────────────────────

interface ReadyToExtractReadoutProps {
  mode: RunMode;
  format: ExamFormat | null;
  analysis: DocumentAnalysisResult | null;
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
  logs: LogEntry[];
  showLogs: boolean;
  onToggleLogs: () => void;
}

function ReadyToExtractReadout({
  mode,
  format,
  analysis,
  contentType,
  onReset,
  onTestExtract,
  testExtract,
  fullRun,
  onRunFullPipeline,
  onOpenInReview,
  onOpenFailedPage,
  logs,
  showLogs,
  onToggleLogs,
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
        {analysis ? (
          <li>
            <span className="label">format confidence</span>
            <code>{(analysis.marking_format_confidence * 100).toFixed(0)}%</code>
          </li>
        ) : null}
        {analysis?.total_questions ? (
          <li>
            <span className="label">total questions</span>
            <code>{analysis.total_questions}</code>
          </li>
        ) : null}
      </ul>
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

      {(logs.length > 0 || fullRun.running) && (
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            className="btn-secondary small"
            onClick={onToggleLogs}
          >
            {showLogs ? "Hide logs" : `Show logs${logs.length > 0 ? ` (${logs.length})` : ""}`}
          </button>
        </div>
      )}

      {showLogs && (
        <div className="log-panel">
          <div className="log-panel-header">
            <span className="log-panel-title">Pipeline log</span>
            {fullRun.running && <div className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />}
          </div>
          <div className="log-panel-body" ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}>
            {logs.length === 0 ? (
              <div className="log-entry"><span className="log-entry-msg" style={{ color: "var(--fg-faint)" }}>Waiting for pipeline to start…</span></div>
            ) : logs.map((entry, i) => (
              <div key={i} className={`log-entry level-${entry.level}`}>
                <span className="log-entry-ts">{new Date(entry.ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                <span className="log-entry-stage">{entry.stage}</span>
                <span className="log-entry-msg">{entry.message}</span>
                {entry.done != null && entry.total != null && (
                  <span className="log-entry-progress">{entry.done}/{entry.total}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

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
            Asking the model to extract page {testExtract.pageNumber}. First call usually takes 5–15s.
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
