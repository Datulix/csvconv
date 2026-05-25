export type PhaseKind = "system" | "ai";
export type PhaseStatus = "running" | "completed" | "failed" | "skipped";

export interface PhaseEntry {
  id: string;
  label: string;
  kind: PhaseKind;
  status: PhaseStatus;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  input: unknown;
  output?: unknown;
  error?: string;
  skipReason?: string;
}

export interface PipelineTrace {
  runId: string;
  pdfPath: string;
  pdfName: string;
  mode: string;
  format: string | null;
  contentType: string;
  schemaName: string;
  startedAt: number;
  completedAt?: number;
  phases: PhaseEntry[];
}

const _traces: Map<string, PipelineTrace> = new Map();
let _currentRunId: string | null = null;

export function startTrace(info: Omit<PipelineTrace, "phases">): void {
  const trace: PipelineTrace = { ...info, phases: [] };
  _traces.set(info.runId, trace);
  _currentRunId = info.runId;
}

function currentTrace(): PipelineTrace | null {
  return _currentRunId ? (_traces.get(_currentRunId) ?? null) : null;
}

export function beginPhase(id: string, label: string, kind: PhaseKind, input: unknown): void {
  const trace = currentTrace();
  if (!trace) return;
  const idx = trace.phases.findIndex((p) => p.id === id);
  const entry: PhaseEntry = { id, label, kind, status: "running", startedAt: Date.now(), input };
  if (idx >= 0) trace.phases[idx] = entry;
  else trace.phases.push(entry);
}

export function completePhase(id: string, output: unknown): void {
  const trace = currentTrace();
  if (!trace) return;
  const phase = trace.phases.find((p) => p.id === id);
  if (!phase) return;
  phase.status = "completed";
  phase.completedAt = Date.now();
  phase.durationMs = phase.completedAt - phase.startedAt;
  phase.output = output;
}

export function failPhase(id: string, error: string): void {
  const trace = currentTrace();
  if (!trace) return;
  const phase = trace.phases.find((p) => p.id === id);
  if (!phase) return;
  phase.status = "failed";
  phase.completedAt = Date.now();
  phase.durationMs = phase.completedAt - phase.startedAt;
  phase.error = error;
}

export function skipPhase(id: string, label: string, kind: PhaseKind, reason: string): void {
  const trace = currentTrace();
  if (!trace) return;
  trace.phases.push({
    id,
    label,
    kind,
    status: "skipped",
    startedAt: Date.now(),
    completedAt: Date.now(),
    durationMs: 0,
    input: null,
    skipReason: reason,
  });
}

export function finishTrace(): void {
  const trace = currentTrace();
  if (trace) trace.completedAt = Date.now();
}

export function getTrace(): PipelineTrace | null {
  return currentTrace();
}

export function getTraceHistory(): PipelineTrace[] {
  return Array.from(_traces.values()).reverse();
}

export function getTraceByRunId(runId: string): PipelineTrace | null {
  return _traces.get(runId) ?? null;
}
