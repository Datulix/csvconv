import { invoke } from "@tauri-apps/api/core";
import type { FieldDefinition, Schema } from "../schema/types";
import type { ExtractedRow } from "../pipelines/extractors/types";

/**
 * Build a CSV string from extracted rows + user schema. Column order matches schema.fields.
 *
 * For each field:
 *   - if `template` is set, render it with mustache-style `{{field}}` substitution against
 *     the canonical row data (supports nested `options.A` syntax).
 *   - if `semantic_role` is set and maps to a canonical field, read it directly.
 *   - if `semantic_role` is null, read the row by the field's `name`.
 */

const SEMANTIC_ROLE_TO_KEY: Record<string, string> = {
  question_text: "question_text",
  question_number: "question_number",
  correct_answer: "correct_answer",
  marking_style: "marking_style",
  mcq_type: "mcq_type",
  page_number: "page_number",
  is_partial: "is_partial",
  term: "term",
  definition: "definition",
  example: "example",
  question: "question",
  answer: "answer",
  ai_answer: "ai_answer",
  ai_explanation: "ai_explanation",
  ai_confidence: "ai_confidence",
  agreement: "agreement",
  disagreement_reason: "disagreement_reason",
};

function lookupNested(obj: unknown, path: string): unknown {
  const segments = path.split(".");
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function renderTemplate(template: string, row: ExtractedRow): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) => {
    const value = lookupNested(row, expr);
    if (value === null || value === undefined) return "";
    return String(value);
  });
}

function resolveOptionsConcatenated(row: ExtractedRow): string {
  const options = (row.options as Record<string, string | null> | undefined) ?? {};
  return (["A", "B", "C", "D", "E"] as const)
    .map((letter) => (options[letter] != null ? `${letter}) ${options[letter]}` : null))
    .filter((s): s is string => s !== null)
    .join("\n");
}

function resolveFieldValue(field: FieldDefinition, row: ExtractedRow): unknown {
  if (field.template) {
    return renderTemplate(field.template, row);
  }
  if (field.semantic_role === "options_concatenated") {
    return resolveOptionsConcatenated(row);
  }
  if (field.semantic_role && SEMANTIC_ROLE_TO_KEY[field.semantic_role]) {
    return row[SEMANTIC_ROLE_TO_KEY[field.semantic_role]];
  }
  if (field.semantic_role && field.semantic_role.startsWith("option_")) {
    const letter = field.semantic_role.slice("option_".length);
    const options = (row.options as Record<string, string | null> | undefined) ?? {};
    return options[letter] ?? null;
  }
  return row[field.name];
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function buildCsv(schema: Schema, rows: ExtractedRow[]): string {
  const header = schema.fields.map((f) => csvEscape(f.name)).join(",");
  const lines = [header];
  for (const row of rows) {
    const values = schema.fields.map((f) => csvEscape(resolveFieldValue(f, row)));
    lines.push(values.join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

export interface AuditExport {
  generated_at: string;
  schema_name: string;
  content_type: string;
  schema_hash: string;
  cache_key: string;
  mode: string;
  confirmed_format: string | null;
  models: {
    primary: string | null;
    detector: string | null;
    extractor: string | null;
    validator: string | null;
    solver: string | null;
  };
  page_count: number;
  row_count: number;
  needs_review_count: number;
  ai_needs_review_count: number;
  compare_summary: unknown;
  answer_key: unknown;
  rows: ExtractedRow[];
}

export function buildAuditJson(data: AuditExport): string {
  return JSON.stringify(data, null, 2);
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  await invoke("write_text_file", { path, content });
}
