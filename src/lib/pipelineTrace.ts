import { saveTrace, loadAllTraces } from "./sqliteCache";

export type PhaseKind = "system" | "ai";
export type PhaseStatus = "running" | "completed" | "failed" | "skipped";

export interface AiCallEntry {
  modelId: string;
  systemInstruction?: string;
  parts: Array<{ kind: "text"; text: string } | { kind: "image"; mimeType: string; base64: string }>;
  responseSchema?: unknown;
  rawResponse: string;
  durationMs: number;
  timestamp: number;
  parsedResponse?: unknown;
}

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
  aiCalls?: AiCallEntry[];
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

function persistTrace(trace: PipelineTrace): void {
  const json = JSON.stringify(trace);
  saveTrace(trace.runId, json).catch(() => {});
}

export function startTrace(info: Omit<PipelineTrace, "phases">): void {
  let trace = _traces.get(info.runId);
  if (!trace) {
    trace = { ...info, phases: [] };
    _traces.set(info.runId, trace);
  } else {
    Object.assign(trace, info);
  }
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
  if (idx >= 0) {
    const existing = trace.phases[idx];
    if (existing.aiCalls) {
      entry.aiCalls = existing.aiCalls;
    }
    trace.phases[idx] = entry;
  } else {
    trace.phases.push(entry);
  }
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
  persistTrace(trace);
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
  persistTrace(trace);
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
  persistTrace(trace);
}

export function recordAiCallInCurrentPhase(call: AiCallEntry): void {
  const trace = currentTrace();
  if (!trace) return;

  let phase = trace.phases.find((p) => p.status === "running" && p.kind === "ai");
  if (!phase) {
    const aiPhases = trace.phases.filter((p) => p.kind === "ai");
    phase = aiPhases[aiPhases.length - 1];
  }
  if (!phase) return;

  if (!phase.aiCalls) {
    phase.aiCalls = [];
  }

  const cleanedParts = call.parts.map((p) => {
    if (p.kind === "image") {
      return {
        kind: "image",
        mimeType: p.mimeType,
        base64: `[Image data omitted (${(p.base64.length / 1024).toFixed(1)} KB)]`,
      };
    }
    return p;
  });

  phase.aiCalls.push({
    ...call,
    parts: cleanedParts as any,
  });

  persistTrace(trace);
}

export function finishTrace(): void {
  const trace = currentTrace();
  if (!trace) return;
  trace.completedAt = Date.now();
  persistTrace(trace);
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

export async function loadAllTracesFromDb(): Promise<void> {
  try {
    const jsonList = await loadAllTraces();
    for (const json of jsonList) {
      try {
        const trace = JSON.parse(json) as PipelineTrace;
        if (trace.runId && !_traces.has(trace.runId)) {
          _traces.set(trace.runId, trace);
        }
      } catch {
        // skip malformed entries
      }
    }
  } catch {
    // Tauri not available (e.g. browser dev mode)
  }
}
