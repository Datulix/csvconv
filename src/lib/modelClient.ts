import { GoogleGenAI } from "@google/genai";
import { z, ZodError } from "zod";
import type { ModelId } from "./models";
import { recordAiCallInCurrentPhase } from "./pipelineTrace";

export type ContentPart =
  | { kind: "text"; text: string }
  | { kind: "image"; mimeType: string; base64: string };

export interface ResponseSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown;
  [key: string]: unknown;
}

export interface ModelCallOptions {
  modelId: ModelId;
  apiKey: string;
  systemInstruction?: string;
  parts: ContentPart[];
  responseSchema?: ResponseSchema;
  maxRetries?: number;
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelCallResult<T> {
  data: T;
  usage: TokenUsage;
  modelId: ModelId;
  rawText: string;
}

export class TruncationError extends Error {
  readonly name = "TruncationError";
  constructor(
    public rawText: string,
    public finishReason: string,
  ) {
    super(`Response truncated (finishReason=${finishReason})`);
  }
}

export class SafetyBlockedError extends Error {
  readonly name = "SafetyBlockedError";
  constructor(
    public finishReason: string,
    public safetyRatings?: unknown,
    public citationMetadata?: unknown,
    public promptFeedback?: unknown,
  ) {
    super(
      `Gemini blocked the response (finishReason=${finishReason}). This usually means a safety filter triggered on the page content or the model's draft response. Try a different model or remove the affected pages.`,
    );
  }
}

export class EmptyResponseError extends Error {
  readonly name = "EmptyResponseError";
  constructor(public finishReason: string) {
    super(`Gemini returned an empty response (finishReason=${finishReason}).`);
  }
}

export class PayloadTooLargeError extends Error {
  readonly name = "PayloadTooLargeError";
  constructor(
    public estimatedBytes: number,
    public limit: number,
  ) {
    super(`Payload ${estimatedBytes} bytes exceeds limit ${limit}`);
  }
}

export class RateLimitError extends Error {
  readonly name = "RateLimitError";
  constructor(public retryAfterMs?: number) {
    super(`Rate limited${retryAfterMs ? ` for ${retryAfterMs}ms` : ""}`);
  }
}

const DEFAULT_CONCURRENCY: Record<string, number> = {
  "gemini-3.1-flash-lite": 3,
  "gemma-4-31B-it": 3,
};

const PER_MODEL_MAX_PAYLOAD_BYTES: Record<string, number> = {
  "gemini-3.1-flash-lite": 20 * 1024 * 1024,
  "gemma-4-31B-it": 20 * 1024 * 1024,
};

class ConcurrencyLimiter {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private max: number) { }

  setMax(max: number) {
    this.max = max;
    while (this.active < this.max && this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      next();
    }
  }

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  release() {
    this.active--;
    const next = this.waiting.shift();
    if (next) next();
  }
}

const limiters = new Map<string, ConcurrencyLimiter>();

function getLimiter(modelId: string): ConcurrencyLimiter {
  let l = limiters.get(modelId);
  if (!l) {
    l = new ConcurrencyLimiter(DEFAULT_CONCURRENCY[modelId] ?? 3);
    limiters.set(modelId, l);
  }
  return l;
}

export function setModelConcurrency(modelId: ModelId, max: number) {
  getLimiter(modelId).setMax(max);
}

let clientCache: { apiKey: string; client: GoogleGenAI } | null = null;
function getClient(apiKey: string): GoogleGenAI {
  if (!clientCache || clientCache.apiKey !== apiKey) {
    clientCache = { apiKey, client: new GoogleGenAI({ apiKey }) };
  }
  return clientCache.client;
}

function estimatePayloadBytes(parts: ContentPart[]): number {
  let total = 0;
  for (const p of parts) {
    if (p.kind === "text") total += p.text.length;
    else total += p.base64.length;
  }
  return total;
}

function toGenaiParts(parts: ContentPart[]): Array<Record<string, unknown>> {
  return parts.map((p) => {
    if (p.kind === "text") return { text: p.text };
    return { inlineData: { mimeType: p.mimeType, data: p.base64 } };
  });
}

function backoffMs(attempt: number): number {
  const base = 1000 * Math.pow(2, attempt);
  return base + Math.floor(Math.random() * 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function isRateLimitError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("resource_exhausted") ||
    msg.includes("too many requests")
  );
}

function extractRetryAfterMs(err: unknown): number | undefined {
  const msg = errorMessage(err);
  const match = msg.match(/retry[\s_-]?after[":\s]+(\d+)/i);
  if (match) return parseInt(match[1], 10) * 1000;
  return undefined;
}

function looksTruncated(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const last = trimmed[trimmed.length - 1];
  if (last === "}" || last === "]") return false;
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escaped = false;
  for (const ch of trimmed) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") openBraces++;
    if (ch === "}") openBraces--;
    if (ch === "[") openBrackets++;
    if (ch === "]") openBrackets--;
  }
  return openBraces > 0 || openBrackets > 0;
}

export async function callModel<T>(
  options: ModelCallOptions,
  validator: z.ZodType<T>,
): Promise<ModelCallResult<T>> {
  const payloadBytes = estimatePayloadBytes(options.parts);
  const limit = PER_MODEL_MAX_PAYLOAD_BYTES[options.modelId] ?? 20 * 1024 * 1024;
  if (payloadBytes > limit) {
    throw new PayloadTooLargeError(payloadBytes, limit);
  }

  const limiter = getLimiter(options.modelId);
  await limiter.acquire();
  try {
    return await callOnce(options, validator);
  } finally {
    limiter.release();
  }
}

async function callOnce<T>(
  options: ModelCallOptions,
  validator: z.ZodType<T>,
): Promise<ModelCallResult<T>> {
  const client = getClient(options.apiKey);
  const maxRetries = options.maxRetries ?? 4;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (options.signal?.aborted) {
      throw new Error("aborted");
    }
    try {
      const config: Record<string, unknown> = {};
      if (options.systemInstruction) config.systemInstruction = options.systemInstruction;
      if (options.responseSchema) {
        config.responseMimeType = "application/json";
        config.responseSchema = options.responseSchema;
      }

      const startTime = Date.now();
      const response = await client.models.generateContent({
        model: options.modelId,
        contents: [{ role: "user", parts: toGenaiParts(options.parts) }],
        config,
      });

      const text = response.text ?? "";
      const candidate = response.candidates?.[0];
      const finishReason = candidate?.finishReason ?? "STOP";
      const safetyRatings = candidate?.safetyRatings;
      const promptFeedback = response.promptFeedback;

      if (finishReason === "MAX_TOKENS") {
        throw new TruncationError(text, finishReason);
      }

      // Treat SAFETY / RECITATION / PROHIBITED_CONTENT / BLOCKLIST as fatal —
      // retrying won't help. Surface the finishReason so the user knows what's up.
      if (
        finishReason === "SAFETY" ||
        finishReason === "RECITATION" ||
        finishReason === "PROHIBITED_CONTENT" ||
        finishReason === "BLOCKLIST" ||
        finishReason === "SPII"
      ) {
        const citationMetadata = (candidate as unknown as { citationMetadata?: unknown })
          ?.citationMetadata;
        throw new SafetyBlockedError(
          finishReason,
          safetyRatings,
          citationMetadata,
          promptFeedback,
        );
      }

      // Empty text body with no clear blocker → transient. Retry.
      if (text.trim().length === 0) {
        lastError = new EmptyResponseError(finishReason);
        if (attempt < maxRetries - 1) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new EmptyResponseError(finishReason);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (parseErr) {
        if (looksTruncated(text)) {
          throw new TruncationError(text, "PARSE_FAIL_LOOKS_TRUNCATED");
        }
        lastError = parseErr;
        if (attempt < maxRetries - 1) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new Error(
          `failed to parse JSON: ${errorMessage(parseErr)}\nfinishReason=${finishReason}\nRaw (first 500 chars): ${text.slice(0, 500)}`,
        );
      }

      let validated: T;
      try {
        validated = validator.parse(parsed);
      } catch (zerr) {
        if (zerr instanceof ZodError) {
          lastError = zerr;
          if (attempt < maxRetries - 1) {
            await sleep(backoffMs(attempt));
            continue;
          }
          throw new Error(
            `response failed schema validation: ${zerr.message}\nRaw (first 500 chars): ${text.slice(0, 500)}`,
          );
        }
        throw zerr;
      }

      const usageMeta = response.usageMetadata;
      const durationMs = Date.now() - startTime;
      try {
        recordAiCallInCurrentPhase({
          modelId: options.modelId,
          systemInstruction: options.systemInstruction,
          parts: options.parts,
          responseSchema: options.responseSchema,
          rawResponse: text,
          durationMs,
          timestamp: Date.now(),
          parsedResponse: validated,
        });
      } catch {
        // ignore tracing error
      }

      return {
        data: validated,
        usage: {
          inputTokens: usageMeta?.promptTokenCount ?? 0,
          outputTokens: usageMeta?.candidatesTokenCount ?? 0,
        },
        modelId: options.modelId,
        rawText: text,
      };
    } catch (err) {
      lastError = err;
      if (
        err instanceof TruncationError ||
        err instanceof PayloadTooLargeError ||
        err instanceof SafetyBlockedError
      ) {
        throw err;
      }
      if (isRateLimitError(err)) {
        const wait = extractRetryAfterMs(err) ?? backoffMs(attempt);
        await sleep(wait);
        continue;
      }
      if (attempt < maxRetries - 1) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastError ?? new Error("callModel: retries exhausted");
}
