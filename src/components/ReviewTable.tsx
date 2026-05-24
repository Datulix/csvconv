import { useCallback, useEffect, useMemo, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { loadRows, type SqliteRowRecord } from "../lib/sqliteCache";
import { buildAuditJson, buildCsv, writeTextFile, type AuditExport } from "../lib/export";
import { loadSchemas } from "../lib/schemaStorage";
import type { Schema } from "../schema/types";
import type { ExtractedRow } from "../pipelines/extractors/types";

type Filter = "all" | "needs_review" | "ai_needs_review" | "ok";

interface ReviewTableProps {
  cacheKey: string | null;
}

export function ReviewTable({ cacheKey }: ReviewTableProps) {
  const [rows, setRows] = useState<SqliteRowRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [savedSchemas, setSavedSchemas] = useState<Schema[]>([]);
  const [selectedSchemaName, setSelectedSchemaName] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const list = await loadSchemas();
        setSavedSchemas(list.map((s) => s.content));
      } catch (err) {
        console.error(err);
      }
    })();
  }, []);

  useEffect(() => {
    if (!cacheKey) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadRows(cacheKey)
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cacheKey]);

  const filteredRows = useMemo(() => {
    if (filter === "all") return rows;
    return rows.filter((r) => {
      if (filter === "needs_review") return r.needs_review;
      if (filter === "ai_needs_review") return r.ai_needs_review;
      if (filter === "ok") return !r.needs_review && !r.ai_needs_review;
      return true;
    });
  }, [rows, filter]);

  const selectedSchema = useMemo(
    () => savedSchemas.find((s) => s.name === selectedSchemaName) ?? null,
    [savedSchemas, selectedSchemaName],
  );

  const columns = useMemo(() => deriveColumns(rows), [rows]);

  const handleExportCsv = useCallback(async () => {
    const schema = selectedSchema ?? inferSchemaFromRows(rows);
    if (!schema) {
      alert("Pick a schema for export (the run's original schema or any saved one).");
      return;
    }
    const path = await saveDialog({
      defaultPath: `csvconv-${cacheKey?.slice(0, 8) ?? "export"}.csv`,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!path) return;
    const extractedRows: ExtractedRow[] = rows.map((r) => r.canonical_json as ExtractedRow);
    const content = buildCsv(schema, extractedRows);
    await writeTextFile(path, content);
  }, [rows, selectedSchema, cacheKey]);

  const handleExportAudit = useCallback(async () => {
    if (!cacheKey) return;
    const path = await saveDialog({
      defaultPath: `csvconv-${cacheKey.slice(0, 8)}.audit.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return;
    const extractedRows: ExtractedRow[] = rows.map((r) => r.canonical_json as ExtractedRow);
    const data: AuditExport = {
      generated_at: new Date().toISOString(),
      schema_name: selectedSchema?.name ?? "(unknown)",
      content_type: selectedSchema?.content_type ?? "(unknown)",
      schema_hash: "(see run record)",
      cache_key: cacheKey,
      mode: "(see run record)",
      confirmed_format: null,
      models: {
        primary: null,
        detector: null,
        extractor: null,
        validator: null,
        solver: null,
      },
      page_count: new Set(rows.map((r) => r.page_number)).size,
      row_count: rows.length,
      needs_review_count: rows.filter((r) => r.needs_review).length,
      ai_needs_review_count: rows.filter((r) => r.ai_needs_review).length,
      compare_summary: null,
      answer_key: null,
      rows: extractedRows,
    };
    await writeTextFile(path, buildAuditJson(data));
  }, [rows, selectedSchema, cacheKey]);

  if (!cacheKey) {
    return (
      <div className="review-empty">
        <h1>Review</h1>
        <p className="hint">
          No run loaded. Run a conversion from the <strong>New conversion</strong> tab, then click
          "View in Review" — or pick a past run from <strong>History</strong>.
        </p>
      </div>
    );
  }

  return (
    <div className="review-table">
      <header className="review-header">
        <div>
          <h1>Review</h1>
          <p className="hint">
            Cache key: <code>{cacheKey.slice(0, 16)}…</code> · {rows.length} row
            {rows.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="review-actions">
          <select
            value={selectedSchemaName ?? ""}
            onChange={(e) => setSelectedSchemaName(e.target.value || null)}
          >
            <option value="">— pick export schema —</option>
            {savedSchemas.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name} ({s.content_type})
              </option>
            ))}
          </select>
          <button
            className="btn-secondary"
            onClick={handleExportCsv}
            disabled={rows.length === 0 || !selectedSchema}
          >
            Export CSV
          </button>
          <button
            className="btn-secondary"
            onClick={handleExportAudit}
            disabled={rows.length === 0}
          >
            Export audit JSON
          </button>
        </div>
      </header>

      {loading ? <p className="hint">Loading rows…</p> : null}
      {error ? <p className="status error">{error}</p> : null}

      {rows.length > 0 ? (
        <div className="review-filter-chips">
          {(["all", "needs_review", "ai_needs_review", "ok"] as Filter[]).map((f) => (
            <button
              key={f}
              className={`chip-button ${filter === f ? "active" : ""}`}
              onClick={() => setFilter(f)}
            >
              {f}
              <span className="chip-count">
                {f === "all"
                  ? rows.length
                  : f === "needs_review"
                  ? rows.filter((r) => r.needs_review).length
                  : f === "ai_needs_review"
                  ? rows.filter((r) => r.ai_needs_review).length
                  : rows.filter((r) => !r.needs_review && !r.ai_needs_review).length}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {filteredRows.length > 0 ? (
        <div className="review-table-wrap">
          <table>
            <thead>
              <tr>
                <th>page</th>
                <th>row</th>
                {columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
                <th>flags</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r, i) => {
                const row = r.canonical_json as Record<string, unknown>;
                return (
                  <tr
                    key={`${r.page_number}-${r.row_index_within_page}-${i}`}
                    className={
                      r.needs_review
                        ? "row-needs-review"
                        : r.ai_needs_review
                        ? "row-ai-needs-review"
                        : ""
                    }
                  >
                    <td>{r.page_number}</td>
                    <td>{r.row_index_within_page}</td>
                    {columns.map((c) => (
                      <td key={c}>{formatCell(row[c])}</td>
                    ))}
                    <td>
                      {r.needs_review ? <span className="chip warn">needs review</span> : null}
                      {r.ai_needs_review ? (
                        <span className="chip warn">ai uncertain</span>
                      ) : null}
                      {r.user_edited ? <span className="chip">edited</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : rows.length > 0 ? (
        <p className="hint">No rows match the current filter.</p>
      ) : null}
    </div>
  );
}

function deriveColumns(rows: SqliteRowRecord[]): string[] {
  if (rows.length === 0) return [];
  const seen = new Set<string>();
  // Try canonical-ish ordering first
  const preferred = [
    "question_number",
    "question_text",
    "term",
    "definition",
    "question",
    "answer",
    "correct_answer",
    "ai_answer",
    "agreement",
    "ai_confidence",
    "confidence",
    "marking_style",
    "mcq_type",
  ];
  const sampled = rows[0].canonical_json as Record<string, unknown>;
  const cols: string[] = [];
  for (const k of preferred) {
    if (k in sampled && !seen.has(k)) {
      cols.push(k);
      seen.add(k);
    }
  }
  for (const k of Object.keys(sampled)) {
    if (seen.has(k)) continue;
    if (k === "options" || k === "source_snippet" || k === "notes") continue;
    cols.push(k);
    seen.add(k);
  }
  return cols.slice(0, 8); // cap columns shown in the table
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") {
    return value.length > 80 ? value.slice(0, 78) + "…" : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "object") {
    const s = JSON.stringify(value);
    return s.length > 80 ? s.slice(0, 78) + "…" : s;
  }
  return String(value);
}

function inferSchemaFromRows(_rows: SqliteRowRecord[]): Schema | null {
  // Without metadata, we can't reconstruct the original schema reliably.
  // The user is prompted to pick one explicitly via the dropdown.
  return null;
}
