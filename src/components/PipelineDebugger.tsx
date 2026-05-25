import { useEffect, useState, type ReactNode } from "react";
import { getTraceHistory, getTraceByRunId, loadAllTracesFromDb, type PhaseEntry, type PipelineTrace, type AiCallEntry } from "../lib/pipelineTrace";
import { listRuns, type SqliteRunRecord } from "../lib/sqliteCache";

// ── Helpers ─────────────────────────────────────────────────────

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="dbg-section">
      <div className="dbg-section-label">{label}</div>
      {children}
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="dbg-json">{JSON.stringify(value, null, 2)}</pre>
  );
}

function ConfBar({ value }: { value: number }) {
  const cls = value >= 0.75 ? "green" : value >= 0.5 ? "yellow" : "red";
  return (
    <span className={`dbg-conf dbg-conf-${cls}`}>
      <span className="dbg-conf-track">
        <span className="dbg-conf-fill" style={{ width: `${value * 100}%` }} />
      </span>
      <span className="dbg-conf-num">{value.toFixed(2)}</span>
    </span>
  );
}

function Badge({ text, color }: { text: string; color: "green" | "red" | "yellow" | "blue" | "purple" | "dim" }) {
  return <span className={`dbg-badge dbg-badge-${color}`}>{text}</span>;
}

function KVPairs({ pairs }: { pairs: [string, ReactNode][] }) {
  return (
    <div className="dbg-kv">
      {pairs.map(([k, v]) => (
        <div key={k} className="dbg-kv-row">
          <span className="dbg-kv-key">{k}</span>
          <span className="dbg-kv-val">{v}</span>
        </div>
      ))}
    </div>
  );
}

// ── Phase input renderers ─────────────────────────────────────

function renderTriageInput(input: unknown) {
  const i = input as { pdfPath: string; runId: string; dpi: number };
  return (
    <Section label="Rust command: triage_pdf">
      <KVPairs pairs={[
        ["pdf_path", i.pdfPath],
        ["run_id", i.runId],
        ["dpi_hint", String(i.dpi)],
      ]} />
      <div className="dbg-note">
        Checks each page: extracts text (text_density), runs pixel histogram (is_blank),
        classifies digital vs scanned, estimates skew angle via Hough transform.
      </div>
    </Section>
  );
}

function renderRasterizeInput(input: unknown) {
  const i = input as { targetPages: number[]; blankPages: number[]; deskewPages: number[]; dpi: number };
  return (
    <Section label="Rust command: rasterize_pdf">
      <KVPairs pairs={[
        ["dpi", String(i.dpi)],
        ["pages to render", i.targetPages.join(", ") || "—"],
        ["blank pages skipped", i.blankPages.length > 0 ? i.blankPages.join(", ") : "none"],
        ["pages deskewed", i.deskewPages.length > 0 ? i.deskewPages.join(", ") : "none"],
        ["jpeg quality", "82"],
        ["max long edge", "2048 px"],
      ]} />
    </Section>
  );
}

function renderDetectInput(input: unknown) {
  const i = input as { contentType: string; mode: string; confirmedFormat: string | null };
  return (
    <Section label="Format detection">
      <KVPairs pairs={[
        ["content type", i.contentType],
        ["mode", i.mode],
        ["format passed in", i.confirmedFormat ?? "null"],
      ]} />
      <div className="dbg-note">
        Format detection runs in the Convert page before the pipeline starts. The confirmed
        format is passed into runPipeline as a parameter.
      </div>
    </Section>
  );
}

function renderExtractInput(input: unknown) {
  const i = input as { batches: Array<{ batchIndex: number; pageNumbers: number[] }>; modelId: string; format: string; batchSize: number };
  return (
    <>
      <Section label="Extractor configuration">
        <KVPairs pairs={[
          ["model", i.modelId],
          ["format / variant", i.format],
          ["batch size", String(i.batchSize)],
          ["total batches", String(i.batches.length)],
        ]} />
      </Section>
      <Section label="Batch plan">
        <table className="dbg-table">
          <thead>
            <tr><th>Batch</th><th>Pages</th></tr>
          </thead>
          <tbody>
            {i.batches.map((b) => (
              <tr key={b.batchIndex}>
                <td>{b.batchIndex + 1}</td>
                <td>{b.pageNumbers.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </>
  );
}

function renderMergeInput(input: unknown) {
  const i = input as { pageCount: number; partialRows: Array<{ questionNumber: string; pageNumber: number }> };
  return (
    <Section label="Merge input">
      <KVPairs pairs={[
        ["total pages", String(i.pageCount)],
        ["partial rows detected", String(i.partialRows.length)],
      ]} />
      {i.partialRows.length > 0 && (
        <table className="dbg-table" style={{ marginTop: 10 }}>
          <thead>
            <tr><th>Q#</th><th>Split at page</th></tr>
          </thead>
          <tbody>
            {i.partialRows.map((r, idx) => (
              <tr key={idx}>
                <td>{r.questionNumber}</td>
                <td>{r.pageNumber}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {i.partialRows.length === 0 && (
        <div className="dbg-note">No partial rows — all questions fit on a single page.</div>
      )}
    </Section>
  );
}

function renderValidateInput(input: unknown) {
  const i = input as {
    candidateCount: number;
    threshold: number;
    primaryModel: string;
    secondaryModel: string | null;
    lowConfRows: Array<{ questionNumber: string; pageNumber: number; confidence: unknown }>;
  };
  return (
    <>
      <Section label="Validator configuration">
        <KVPairs pairs={[
          ["confidence threshold", String(i.threshold)],
          ["primary model", i.primaryModel],
          ["secondary model", i.secondaryModel ?? "none (single-model re-prompt)"],
          ["rows below threshold", String(i.candidateCount)],
        ]} />
      </Section>
      {i.lowConfRows.length > 0 && (
        <Section label="Low-confidence rows sent for re-checking">
          <table className="dbg-table">
            <thead>
              <tr><th>Q#</th><th>Page</th><th>Confidence</th></tr>
            </thead>
            <tbody>
              {i.lowConfRows.map((r, idx) => (
                <tr key={idx}>
                  <td>{r.questionNumber}</td>
                  <td>{r.pageNumber}</td>
                  <td>{typeof r.confidence === "number" ? <ConfBar value={r.confidence} /> : String(r.confidence)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
    </>
  );
}

function renderSolveInput(input: unknown) {
  const i = input as { modelId: string; mode: string };
  return (
    <Section label="Solver configuration">
      <KVPairs pairs={[
        ["model", i.modelId],
        ["mode", i.mode],
      ]} />
      <div className="dbg-note">
        The solver independently answers every question using knowledge only — it does not see
        marked answers. Batched by source page (~8 questions per batch).
      </div>
    </Section>
  );
}

function renderCompareInput(input: unknown) {
  const i = input as { rowCount: number };
  return (
    <Section label="Compare input">
      <KVPairs pairs={[["rows to join", String(i.rowCount)]]} />
      <div className="dbg-note">
        Joins extracted rows with solver answers on question_number. Marked answer is treated as
        truth; AI answer is compared against it.
      </div>
    </Section>
  );
}

function renderAnswerKeyInput(input: unknown) {
  const i = input as { keyPages: number[]; modelId: string };
  return (
    <Section label="Answer key parser">
      <KVPairs pairs={[
        ["model", i.modelId],
        ["key pages", i.keyPages.join(", ")],
      ]} />
    </Section>
  );
}

function renderPersistInput(input: unknown) {
  const i = input as { cacheKey: string };
  return (
    <Section label="Persist to SQLite cache">
      <KVPairs pairs={[["cache key (SHA-256)", i.cacheKey]]} />
    </Section>
  );
}

// ── Phase output renderers ─────────────────────────────────────

function renderTriageOutput(output: unknown) {
  const o = output as {
    pdfType: string;
    pageCount: number;
    blankCount: number;
    pages: Array<{ page_number: number; is_blank: boolean; page_type: string; text_density: number; skew_angle_deg: number }>;
  };
  return (
    <>
      <Section label="Summary">
        <KVPairs pairs={[
          ["PDF type", o.pdfType],
          ["Total pages", String(o.pageCount)],
          ["Blank pages", o.blankCount > 0 ? <Badge text={String(o.blankCount)} color="yellow" /> : "0"],
        ]} />
      </Section>
      <Section label="Per-page metadata">
        <table className="dbg-table">
          <thead>
            <tr><th>Page</th><th>Type</th><th>Blank</th><th>Text density</th><th>Skew</th></tr>
          </thead>
          <tbody>
            {o.pages.map((p) => (
              <tr key={p.page_number} className={p.is_blank ? "dbg-row-dim" : ""}>
                <td>{p.page_number}</td>
                <td>{p.page_type}</td>
                <td>{p.is_blank ? <Badge text="BLANK" color="yellow" /> : "—"}</td>
                <td>{p.text_density}</td>
                <td>{p.skew_angle_deg.toFixed(1)}°</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </>
  );
}

function renderRasterizeOutput(output: unknown) {
  const o = output as {
    pages: Array<{ pageNumber: number; width: number; height: number; deskewed: boolean; skipped: boolean }>;
  };
  return (
    <Section label="Rasterized pages">
      <table className="dbg-table">
        <thead>
          <tr><th>Page</th><th>Width</th><th>Height</th><th>Deskewed</th><th>Skipped</th></tr>
        </thead>
        <tbody>
          {o.pages.map((p) => (
            <tr key={p.pageNumber} className={p.skipped ? "dbg-row-dim" : ""}>
              <td>{p.pageNumber}</td>
              <td>{p.skipped ? "—" : `${p.width}px`}</td>
              <td>{p.skipped ? "—" : `${p.height}px`}</td>
              <td>{p.deskewed ? <Badge text="yes" color="blue" /> : "no"}</td>
              <td>{p.skipped ? <Badge text="SKIPPED" color="dim" /> : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function renderDetectOutput(output: unknown) {
  const o = output as { confirmedFormat: string };
  return (
    <Section label="Confirmed format">
      <Badge text={o.confirmedFormat} color="purple" />
    </Section>
  );
}

type ExtractRow = {
  question_number?: unknown;
  correct_answer?: unknown;
  confidence?: unknown;
  is_partial?: boolean;
  multiple_marks_detected?: boolean;
  _page?: number;
};

function renderExtractOutput(output: unknown) {
  const o = output as {
    batchCount: number;
    failedPageCount: number;
    failedPages: Array<{ pageNumber: number; reason: string }>;
    batches: Array<{ pages: Array<{ page_number: number; rows: ExtractRow[] }> }>;
  };
  const allRows: ExtractRow[] = o.batches.flatMap((b) =>
    b.pages.flatMap((p) => p.rows.map((r) => ({ ...r, _page: p.page_number }))),
  );
  return (
    <>
      <Section label="Summary">
        <KVPairs pairs={[
          ["Batches", String(o.batchCount)],
          ["Total rows", String(allRows.length)],
          ["Failed pages", o.failedPageCount > 0 ? <Badge text={String(o.failedPageCount)} color="red" /> : "0"],
        ]} />
      </Section>
      {o.failedPages.length > 0 && (
        <Section label="Failed pages">
          <table className="dbg-table">
            <thead><tr><th>Page</th><th>Reason</th></tr></thead>
            <tbody>
              {o.failedPages.map((f) => (
                <tr key={f.pageNumber} className="dbg-row-error">
                  <td>{f.pageNumber}</td>
                  <td>{f.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
      <Section label="Extracted rows">
        <table className="dbg-table">
          <thead>
            <tr><th>Page</th><th>Q#</th><th>Answer</th><th>Confidence</th><th>Flags</th></tr>
          </thead>
          <tbody>
            {allRows.map((row, i) => {
              const conf = typeof row.confidence === "number" ? row.confidence : null;
              const isWarn = conf !== null && conf < 0.75;
              return (
                <tr key={i} className={isWarn ? "dbg-row-warn" : ""}>
                  <td>{row._page ?? "?"}</td>
                  <td>{String(row.question_number ?? "?")}</td>
                  <td>{String(row.correct_answer ?? "—")}</td>
                  <td>{conf !== null ? <ConfBar value={conf} /> : "—"}</td>
                  <td>
                    {row.is_partial && <Badge text="partial" color="blue" />}
                    {" "}
                    {row.multiple_marks_detected && <Badge text="multi-mark" color="yellow" />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>
    </>
  );
}

function renderMergeOutput(output: unknown) {
  const o = output as {
    mergedCount: number;
    pages: Array<{ page_number: number; rows: ExtractRow[] }>;
  };
  const allRows = o.pages.flatMap((p) => p.rows.map((r) => ({ ...r, _page: p.page_number })));
  return (
    <>
      <Section label="Summary">
        <KVPairs pairs={[
          ["Questions merged", String(o.mergedCount)],
          ["Total rows after merge", String(allRows.length)],
        ]} />
      </Section>
      <Section label="Rows after merge">
        <table className="dbg-table">
          <thead>
            <tr><th>Page</th><th>Q#</th><th>Answer</th><th>Confidence</th></tr>
          </thead>
          <tbody>
            {allRows.map((row, i) => {
              const conf = typeof row.confidence === "number" ? row.confidence : null;
              return (
                <tr key={i}>
                  <td>{(row as { _page?: number })._page ?? "?"}</td>
                  <td>{String(row.question_number ?? "?")}</td>
                  <td>{String(row.correct_answer ?? "—")}</td>
                  <td>{conf !== null ? <ConfBar value={conf} /> : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>
    </>
  );
}

function renderValidateOutput(output: unknown) {
  const o = output as {
    needsReviewCount: number;
    pages: Array<{ page_number: number; rows: ExtractRow[] }>;
  };
  const allRows = o.pages.flatMap((p) => p.rows.map((r) => ({ ...r, _page: p.page_number })));
  return (
    <>
      <Section label="Summary">
        <KVPairs pairs={[
          ["Rows flagged needs_review", o.needsReviewCount > 0 ? <Badge text={String(o.needsReviewCount)} color="red" /> : "0"],
          ["Total rows", String(allRows.length)],
        ]} />
      </Section>
      <Section label="Validated rows">
        <table className="dbg-table">
          <thead>
            <tr><th>Page</th><th>Q#</th><th>Answer</th><th>Confidence</th></tr>
          </thead>
          <tbody>
            {allRows.map((row, i) => {
              const conf = typeof row.confidence === "number" ? row.confidence : null;
              const isWarn = conf !== null && conf < 0.75;
              return (
                <tr key={i} className={isWarn ? "dbg-row-warn" : ""}>
                  <td>{(row as { _page?: number })._page ?? "?"}</td>
                  <td>{String(row.question_number ?? "?")}</td>
                  <td>{String(row.correct_answer ?? "—")}</td>
                  <td>{conf !== null ? <ConfBar value={conf} /> : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>
    </>
  );
}

type SolverAnswer = { question_number?: unknown; ai_answer?: unknown; ai_explanation?: unknown; ai_confidence?: unknown };

function renderSolveOutput(output: unknown) {
  const o = output as { questionCount: number; batchCount: number; answers: SolverAnswer[] };
  return (
    <>
      <Section label="Summary">
        <KVPairs pairs={[
          ["Questions answered", String(o.questionCount)],
          ["Solver batches", String(o.batchCount)],
        ]} />
      </Section>
      {o.answers.length > 0 && (
        <Section label="AI answers">
          <table className="dbg-table">
            <thead>
              <tr><th>Q#</th><th>AI answer</th><th>AI confidence</th><th>Explanation</th></tr>
            </thead>
            <tbody>
              {o.answers.map((a, i) => {
                const conf = typeof a.ai_confidence === "number" ? a.ai_confidence : null;
                return (
                  <tr key={i}>
                    <td>{String(a.question_number ?? "?")}</td>
                    <td>{String(a.ai_answer ?? "—")}</td>
                    <td>{conf !== null ? <ConfBar value={conf} /> : "—"}</td>
                    <td style={{ maxWidth: 280, fontSize: 11, color: "var(--fg-muted)" }}>
                      {String(a.ai_explanation ?? "")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Section>
      )}
    </>
  );
}

type ComparedRow = ExtractRow & { ai_answer?: unknown; ai_confidence?: unknown; agreement?: boolean | null; disagreement_reason?: unknown };

function renderCompareOutput(output: unknown) {
  const o = output as {
    summary: { total: number; agreements: number; disagreements: number } | null;
    rows: ComparedRow[];
  };
  return (
    <>
      {o.summary && (
        <Section label="Summary">
          <KVPairs pairs={[
            ["Total", String(o.summary.total)],
            ["Agreements", <Badge text={`${o.summary.agreements} ok`} color="green" />],
            ["Disagreements", o.summary.disagreements > 0 ? <Badge text={`${o.summary.disagreements} diff`} color="red" /> : <Badge text="0" color="green" />],
          ]} />
        </Section>
      )}
      <Section label="Compared rows">
        <table className="dbg-table">
          <thead>
            <tr><th>Q#</th><th>Marked</th><th>AI answer</th><th>Agreement</th><th>AI confidence</th></tr>
          </thead>
          <tbody>
            {o.rows.map((row, i) => {
              const conf = typeof row.ai_confidence === "number" ? row.ai_confidence : null;
              const agree = row.agreement;
              return (
                <tr key={i} className={agree === false ? "dbg-row-warn" : ""}>
                  <td>{String(row.question_number ?? "?")}</td>
                  <td>{String(row.correct_answer ?? "—")}</td>
                  <td>{String(row.ai_answer ?? "—")}</td>
                  <td>
                    {agree === true && <span style={{ color: "var(--success)" }}>yes</span>}
                    {agree === false && <span style={{ color: "var(--danger)" }}>no</span>}
                    {agree == null && <span style={{ color: "var(--fg-faint)" }}>—</span>}
                  </td>
                  <td>{conf !== null ? <ConfBar value={conf} /> : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>
    </>
  );
}

function renderAnswerKeyOutput(output: unknown) {
  const o = output as { entries?: Array<{ question_number: string; answer: string }>; note?: string };
  if (o.note) return <Section label="Result"><div className="dbg-note">{o.note}</div></Section>;
  return (
    <Section label="Answer key entries">
      <table className="dbg-table">
        <thead><tr><th>Q#</th><th>Answer</th></tr></thead>
        <tbody>
          {(o.entries ?? []).map((e) => (
            <tr key={e.question_number}><td>{e.question_number}</td><td>{e.answer}</td></tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function renderPersistOutput(output: unknown) {
  const o = output as { totalRows: number; cacheKey: string; rows?: unknown[] };
  return (
    <Section label="Persisted">
      <KVPairs pairs={[
        ["Rows saved", String(o.totalRows)],
        ["Cache key", o.cacheKey],
      ]} />
      {o.rows && o.rows.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="dbg-section-label">Persisted Rows Details</div>
          <table className="dbg-table">
            <thead>
              <tr><th>Q#</th><th>Answer</th><th>Confidence</th></tr>
            </thead>
            <tbody>
              {o.rows.map((row: any, i: number) => {
                const conf = typeof row.confidence === "number" ? row.confidence : null;
                return (
                  <tr key={i}>
                    <td>{String(row.question_number ?? "?")}</td>
                    <td>{String(row.correct_answer ?? "—")}</td>
                    <td>{conf !== null ? <ConfBar value={conf} /> : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function renderAiPrompts(aiCalls: AiCallEntry[]) {
  return (
    <div className="dbg-ai-calls-list">
      {aiCalls.map((call, idx) => (
        <div key={idx} className="dbg-ai-call-box">
          <div className="dbg-ai-call-header">
            <span className="dbg-ai-call-title">Call #{idx + 1} ({call.modelId})</span>
            <span className="dbg-ai-call-time">{fmtDuration(call.durationMs)}</span>
          </div>
          {call.systemInstruction && (
            <div className="dbg-ai-call-section">
              <div className="dbg-ai-call-label">System Instruction</div>
              <pre className="dbg-ai-code">{call.systemInstruction}</pre>
            </div>
          )}
          <div className="dbg-ai-call-section">
            <div className="dbg-ai-call-label">User Prompt / Parts</div>
            <div className="dbg-ai-parts">
              {call.parts.map((p, pIdx) => {
                if (p.kind === "image") {
                  return (
                    <div key={pIdx} className="dbg-ai-part-image">
                      <span className="dbg-ai-part-icon">🖼️</span>
                      <span className="dbg-ai-part-meta">{p.mimeType} — {p.base64}</span>
                    </div>
                  );
                }
                return (
                  <pre key={pIdx} className="dbg-ai-code text-part">{p.text}</pre>
                );
              })}
            </div>
          </div>
          {!!call.responseSchema && (
            <details className="dbg-ai-call-section">
              <summary className="dbg-ai-call-label clickable" style={{ cursor: "pointer", userSelect: "none" }}>
                Response Schema (click to expand)
              </summary>
              <pre className="dbg-json" style={{ marginTop: 6 }}>{JSON.stringify(call.responseSchema, null, 2)}</pre>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}

function renderAiResponses(aiCalls: AiCallEntry[]) {
  return (
    <div className="dbg-ai-calls-list">
      {aiCalls.map((call, idx) => (
        <div key={idx} className="dbg-ai-call-box">
          <div className="dbg-ai-call-header">
            <span className="dbg-ai-call-title">Call #{idx + 1} ({call.modelId})</span>
            <span className="dbg-ai-call-time">{fmtDuration(call.durationMs)}</span>
          </div>
          <div className="dbg-ai-call-section">
            <div className="dbg-ai-call-label">Raw Text Response</div>
            <pre className="dbg-ai-code response-text">{call.rawResponse}</pre>
          </div>
          {call.parsedResponse !== undefined && (
            <div className="dbg-ai-call-section">
              <div className="dbg-ai-call-label">Parsed JSON Output</div>
              <pre className="dbg-json">{JSON.stringify(call.parsedResponse, null, 2)}</pre>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Skipped / failed states ────────────────────────────────────

function SkippedState({ reason }: { reason: string }) {
  return (
    <div className="dbg-skip-state">
      <span className="dbg-skip-icon">⊘</span>
      <span>Skipped — {reason}</span>
    </div>
  );
}

function ErrorState({ error }: { error: string }) {
  return (
    <div className="dbg-error-state">
      <span>Error: {error}</span>
    </div>
  );
}

// ── Dispatchers ────────────────────────────────────────────────

function renderInput(phase: PhaseEntry): ReactNode {
  if (phase.status === "skipped") return <SkippedState reason={phase.skipReason ?? "—"} />;
  switch (phase.id) {
    case "triage":      return renderTriageInput(phase.input);
    case "rasterize":   return renderRasterizeInput(phase.input);
    case "detect":      return renderDetectInput(phase.input);
    case "extract":     return renderExtractInput(phase.input);
    case "merge":       return renderMergeInput(phase.input);
    case "validate":    return renderValidateInput(phase.input);
    case "solve":       return renderSolveInput(phase.input);
    case "compare":     return renderCompareInput(phase.input);
    case "answer_key":  return renderAnswerKeyInput(phase.input);
    case "persist":     return renderPersistInput(phase.input);
    default:            return <Section label="Input"><JsonBlock value={phase.input} /></Section>;
  }
}

function renderOutput(phase: PhaseEntry): ReactNode {
  if (phase.status === "skipped") return <SkippedState reason={phase.skipReason ?? "—"} />;
  if (phase.status === "failed")  return <ErrorState error={phase.error ?? "Unknown error"} />;
  if (phase.status === "running") return <div className="dbg-note">Running…</div>;
  if (phase.output === undefined) return <div className="dbg-note">No output captured.</div>;
  switch (phase.id) {
    case "triage":      return renderTriageOutput(phase.output);
    case "rasterize":   return renderRasterizeOutput(phase.output);
    case "detect":      return renderDetectOutput(phase.output);
    case "extract":     return renderExtractOutput(phase.output);
    case "merge":       return renderMergeOutput(phase.output);
    case "validate":    return renderValidateOutput(phase.output);
    case "solve":       return renderSolveOutput(phase.output);
    case "compare":     return renderCompareOutput(phase.output);
    case "answer_key":  return renderAnswerKeyOutput(phase.output);
    case "persist":     return renderPersistOutput(phase.output);
    default:            return <Section label="Output"><JsonBlock value={phase.output} /></Section>;
  }
}

// ── Duration helper ────────────────────────────────────────────

function fmtDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ── Run history sidebar ────────────────────────────────────────

type RunState = "running" | "completed" | "crashed" | "cancelled" | string;

interface RunEntry {
  runId: string;
  label: string;
  sub: string;
  state: RunState;
  startedAt: number;
  hasTrace: boolean;
}

function stateDot(state: RunState) {
  const cls =
    state === "running"   ? "running"   :
    state === "completed" ? "completed" :
    state === "crashed"   ? "crashed"   :
    state === "cancelled" ? "cancelled" : "other";
  return <span className={`dbg-run-state-dot ${cls}`} />;
}

function RunList({
  runs,
  selectedId,
  onSelect,
}: {
  runs: RunEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (runs.length === 0) {
    return (
      <div className="dbg-history-empty">
        No runs yet. Start a conversion on the Convert page.
      </div>
    );
  }
  return (
    <>
      {runs.map((r) => (
        <button
          key={r.runId}
          type="button"
          className={`dbg-run-btn ${selectedId === r.runId ? "active" : ""}`}
          onClick={() => onSelect(r.runId)}
        >
          <span className="dbg-run-name" title={r.label}>{r.label}</span>
          <span className="dbg-run-meta">
            {stateDot(r.state)}
            <span>{r.state}</span>
            {r.state === "running" && <span className="dbg-run-live">live</span>}
            <span style={{ marginLeft: "auto" }}>{fmtTime(r.startedAt)}</span>
          </span>
          <span className="dbg-run-sub">{r.sub}</span>
        </button>
      ))}
    </>
  );
}

// ── Trace header ───────────────────────────────────────────────

function TraceHeader({ trace }: { trace: PipelineTrace }) {
  const totalMs = trace.completedAt ? trace.completedAt - trace.startedAt : null;
  return (
    <div className="dbg-trace-header">
      <div className="dbg-trace-title">{trace.pdfName}</div>
      <div className="dbg-trace-meta">
        <span>{trace.contentType}</span>
        <span>·</span>
        <span>{trace.mode}</span>
        {trace.format && <><span>·</span><span>{trace.format}</span></>}
        <span>·</span>
        <span>{trace.schemaName}</span>
        {totalMs && <><span>·</span><span>{fmtDuration(totalMs)} total</span></>}
        {!trace.completedAt && <><span>·</span><span className="dbg-running-label">running</span></>}
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────

export function PipelineDebugger() {
  const [tick, setTick] = useState(0);
  const [sqliteRuns, setSqliteRuns] = useState<SqliteRunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [activePhaseIdx, setActivePhaseIdx] = useState(0);
  const [activeInputTab, setActiveInputTab] = useState<"visual" | "raw" | "ai">("visual");
  const [activeOutputTab, setActiveOutputTab] = useState<"visual" | "raw" | "ai">("visual");

  useEffect(() => {
    setActiveInputTab("visual");
    setActiveOutputTab("visual");
  }, [selectedRunId, activePhaseIdx]);

  // Poll every 600ms so in-progress traces update live.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 600);
    return () => clearInterval(id);
  }, []);

  // Load SQLite runs and persisted traces on mount (and on manual refresh).
  function loadSqliteRuns() {
    listRuns().then(setSqliteRuns).catch(() => {});
  }
  function loadPersistedTraces() {
    loadAllTracesFromDb().then(() => setTick((t) => t + 1)).catch(() => {});
  }
  useEffect(() => {
    loadSqliteRuns();
    loadPersistedTraces();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-read trace history on every tick.
  const traceHistory = getTraceHistory(); // always fresh because tick changes
  void tick; // suppress lint — tick is the re-render trigger

  // Auto-select the most recent in-memory trace on first render.
  useEffect(() => {
    if (selectedRunId === null && traceHistory.length > 0) {
      setSelectedRunId(traceHistory[0].runId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceHistory.length]);

  // Build combined run list: in-memory traces first, then SQLite-only runs.
  const inMemoryIds = new Set(traceHistory.map((t) => t.runId));
  const runs: RunEntry[] = [
    ...traceHistory.map((t): RunEntry => ({
      runId: t.runId,
      label: t.pdfName,
      sub: `${t.mode}${t.format ? ` · ${t.format}` : ""}`,
      state: t.completedAt ? "completed" : "running",
      startedAt: t.startedAt,
      hasTrace: true,
    })),
    ...sqliteRuns
      .filter((r) => !inMemoryIds.has(r.cache_key))
      .map((r): RunEntry => ({
        runId: r.cache_key,
        label: r.cache_key.slice(0, 12),
        sub: `${r.mode ?? "?"}${r.confirmed_format ? ` · ${r.confirmed_format}` : ""} · no trace`,
        state: r.state ?? "?",
        startedAt: r.started_at ? Number(r.started_at) * 1000 || 0 : 0,
        hasTrace: false,
      })),
  ];

  const selectedEntry = runs.find((r) => r.runId === selectedRunId) ?? null;
  const trace = selectedRunId ? getTraceByRunId(selectedRunId) : null;
  const phase = trace?.phases[activePhaseIdx] ?? null;
  const hasAiCalls = !!(phase && phase.kind === "ai" && phase.aiCalls && phase.aiCalls.length > 0);

  function handleSelectRun(id: string) {
    setSelectedRunId(id);
    setActivePhaseIdx(0);
  }

  function handleRefresh() {
    setTick((t) => t + 1);
    loadSqliteRuns();
    loadPersistedTraces();
  }

  return (
    <div className="debugger-layout">

      {/* Top bar */}
      <div className="debugger-topbar">
        <div>
          <span className="debugger-title">Pipeline Debugger</span>
          <span className="debugger-subtitle">Select a run from the history to inspect each phase</span>
        </div>
        <button type="button" className="btn btn-secondary dbg-refresh-btn" onClick={handleRefresh}>
          Refresh
        </button>
      </div>

      {/* Body: history sidebar + trace area */}
      <div className="debugger-body">

        {/* Left: run history */}
        <div className="debugger-history">
          <div className="debugger-history-label">Runs</div>
          <RunList runs={runs} selectedId={selectedRunId} onSelect={handleSelectRun} />
        </div>

        {/* Right: trace view */}
        <div className="debugger-trace-area">
          {!selectedEntry ? (
            <div className="dbg-empty">
              <div className="dbg-empty-title">No run selected</div>
              <div className="dbg-empty-sub">
                Start a conversion on the Convert page, then select a run from the list on the left.
              </div>
            </div>
          ) : !selectedEntry.hasTrace ? (
            <div className="dbg-empty">
              <div className="dbg-empty-title">No trace data</div>
              <div className="dbg-empty-sub">
                Phase trace data was not saved for this run. All future runs will have full
                trace history available here.
              </div>
            </div>
          ) : !trace ? (
            <div className="dbg-empty">
              <div className="dbg-empty-title">Trace not found</div>
              <div className="dbg-empty-sub">Try refreshing.</div>
            </div>
          ) : (
            <>
              <TraceHeader trace={trace} />

              <div className="dbg-stepper">
                {trace.phases.map((p, i) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`dbg-step ${i === activePhaseIdx ? "active" : ""} status-${p.status}`}
                    onClick={() => setActivePhaseIdx(i)}
                  >
                    <span className="dbg-step-num">{i + 1}</span>
                    <span className="dbg-step-name">{p.label}</span>
                    <span className="dbg-step-kind">{p.kind === "ai" ? "ai" : "sys"}</span>
                    <span className="dbg-step-dur">
                      {p.durationMs !== undefined && p.status !== "skipped" ? fmtDuration(p.durationMs) : ""}
                    </span>
                  </button>
                ))}
                {trace.phases.length === 0 && (
                  <span style={{ padding: "10px 16px", fontSize: 12, color: "var(--fg-faint)" }}>
                    Waiting for first phase…
                  </span>
                )}
              </div>

              {phase ? (
                <div className="dbg-panels">
                  <div className="dbg-panel">
                    <div className="dbg-panel-header">
                      <span className="dbg-panel-title">Input</span>
                      <span className={`dbg-kind-tag dbg-kind-${phase.kind}`}>
                        {phase.kind === "ai" ? "AI phase" : "System phase"}
                      </span>
                      <div className="dbg-panel-tabs">
                        <button
                          type="button"
                          className={`dbg-panel-tab-btn ${activeInputTab === "visual" ? "active" : ""}`}
                          onClick={() => setActiveInputTab("visual")}
                        >
                          Visual
                        </button>
                        <button
                          type="button"
                          className={`dbg-panel-tab-btn ${activeInputTab === "raw" ? "active" : ""}`}
                          onClick={() => setActiveInputTab("raw")}
                        >
                          Raw JSON
                        </button>
                        {hasAiCalls && (
                          <button
                            type="button"
                            className={`dbg-panel-tab-btn ${activeInputTab === "ai" ? "active" : ""}`}
                            onClick={() => setActiveInputTab("ai")}
                          >
                            AI Prompts
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="dbg-panel-body">
                      {activeInputTab === "visual" && renderInput(phase)}
                      {activeInputTab === "raw" && <JsonBlock value={phase.input} />}
                      {activeInputTab === "ai" && hasAiCalls && renderAiPrompts(phase.aiCalls || [])}
                    </div>
                  </div>
                  <div className="dbg-panel">
                    <div className="dbg-panel-header">
                      <span className="dbg-panel-title">Output</span>
                      <span className={`dbg-status-tag status-${phase.status}`}>{phase.status}</span>
                      {phase.durationMs !== undefined && phase.status === "completed" && (
                        <span className="dbg-dur-tag">{fmtDuration(phase.durationMs)}</span>
                      )}
                      <div className="dbg-panel-tabs">
                        <button
                          type="button"
                          className={`dbg-panel-tab-btn ${activeOutputTab === "visual" ? "active" : ""}`}
                          onClick={() => setActiveOutputTab("visual")}
                        >
                          Visual
                        </button>
                        <button
                          type="button"
                          className={`dbg-panel-tab-btn ${activeOutputTab === "raw" ? "active" : ""}`}
                          onClick={() => setActiveOutputTab("raw")}
                        >
                          Raw JSON
                        </button>
                        {hasAiCalls && (
                          <button
                            type="button"
                            className={`dbg-panel-tab-btn ${activeOutputTab === "ai" ? "active" : ""}`}
                            onClick={() => setActiveOutputTab("ai")}
                          >
                            AI Responses
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="dbg-panel-body">
                      {activeOutputTab === "visual" && renderOutput(phase)}
                      {activeOutputTab === "raw" && <JsonBlock value={phase.output} />}
                      {activeOutputTab === "ai" && hasAiCalls && renderAiResponses(phase.aiCalls || [])}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="dbg-empty" style={{ flex: 1 }}>
                  <div className="dbg-empty-sub">Select a phase from the stepper above.</div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
