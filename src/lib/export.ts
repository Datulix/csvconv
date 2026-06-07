import { writeTextFile as fsWriteTextFile } from "@tauri-apps/plugin-fs";
import type { FieldDefinition, Schema } from "../schema/types";
import type { ExtractedRow } from "../pipelines/extractors/types";

/**
 * Build a CSV string from extracted rows + user schema. Column order matches schema.fields.
 *
 * For each field:
 *   - if `template` is set, render it with mustache-style `{{field}}` substitution against
 *     the row data (supports nested `options.A` syntax).
 *   - otherwise read the row by the field's `name` (extraction is description-driven, so the
 *     model fills each field under its declared name).
 */

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

function resolveFieldValue(field: FieldDefinition, row: ExtractedRow): unknown {
  if (field.template) {
    return renderTemplate(field.template, row);
  }
  return row[field.name];
}

/**
 * Project a canonical row through the schema's fields, in field order. This is the single
 * source of truth for "what the schema produces" — shared by CSV export and the Review table
 * so the two can never diverge. Returns `{ name, value }` per field (column).
 */
export function projectRow(schema: Schema, row: ExtractedRow): Array<{ name: string; value: unknown }> {
  return schema.fields.map((f) => ({ name: f.name, value: resolveFieldValue(f, row) }));
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
  // The CSV contains exactly the schema's fields — no auto-appended columns. Figure crops
  // are local file paths, not portable, so they are intentionally left out of the export.
  const headerLine = schema.fields.map((f) => csvEscape(f.name)).join(",");
  const lines = [headerLine];
  for (const row of rows) {
    const values = projectRow(schema, row).map((c) => csvEscape(c.value));
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

/**
 * Write text to a path chosen via the save dialog. Uses the fs plugin (not a custom
 * std::fs command) so it works on Android too: there `save()` returns a `content://`
 * URI that std::fs can't write to — which is why phone exports produced empty files —
 * but the fs plugin writes through the Android content resolver. On desktop the path
 * is a normal filesystem path and the dialog grants it write scope.
 */
export async function writeTextFile(path: string, content: string): Promise<void> {
  await fsWriteTextFile(path, content);
}
