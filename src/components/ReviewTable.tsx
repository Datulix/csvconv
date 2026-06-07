import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import { loadRows, listRuns, getRunPdfBase64, exportFigures, saveRows, type SqliteRowRecord, type SqliteRunRecord } from "../lib/sqliteCache";
import { buildAuditJson, buildCsv, projectRow, writeTextFile, type AuditExport } from "../lib/export";
import { loadSchemas } from "../lib/schemaStorage";
import { loadSettings } from "../lib/settings";
import { PRESETS } from "../schema/presets";
import { schemaHash } from "../schema/hash";
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
  const [runRecord, setRunRecord] = useState<SqliteRunRecord | null>(null);
  const [hashMatchedSchema, setHashMatchedSchema] = useState<Schema | null>(null);
  const [activeLightbox, setActiveLightbox] = useState<{ path?: string; explanation: string; kind: string } | null>(null);

  // Source-PDF preview panel beside the columns.
  const [showPdf, setShowPdf] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfStatus, setPdfStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [pdfPage, setPdfPage] = useState(1);
  const pdfFrameRef = useRef<HTMLIFrameElement>(null);

  // Per-column widths (px) set by drag-resizing the header borders.
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const [resizing, setResizing] = useState(false);

  // Image export: base URL from settings + a transient status line.
  const [imageBaseUrl, setImageBaseUrl] = useState<string | null>(null);
  const [imgExportMsg, setImgExportMsg] = useState<string | null>(null);
  const [imgExporting, setImgExporting] = useState(false);

  const startResize = useCallback((col: string, e: RMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = (e.currentTarget as HTMLElement)
      .closest("th")!
      .getBoundingClientRect().width;
    setResizing(true);
    const onMove = (ev: globalThis.MouseEvent) => {
      const newW = Math.max(40, startW + ev.clientX - startX);
      setColWidths((prev) => ({ ...prev, [col]: newW }));
    };
    const onUp = () => {
      setResizing(false);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  // The schema the run was executed with, recovered from the persisted run record.
  const runSchema = useMemo<Schema | null>(() => {
    if (!runRecord?.schema_json) return null;
    try {
      return JSON.parse(runRecord.schema_json) as Schema;
    } catch {
      return null;
    }
  }, [runRecord]);

  const hasFigures = useMemo(() => {
    return rows.some((r) => {
      const row = r.canonical_json as any;
      return row?.figures && row.figures.length > 0;
    });
  }, [rows]);

  useEffect(() => {
    (async () => {
      try {
        const list = await loadSchemas();
        setSavedSchemas(list.map((s) => s.content));
      } catch (err) {
        console.error(err);
      }
      try {
        const s = await loadSettings();
        setImageBaseUrl(s.image_base_url ?? null);
      } catch (err) {
        console.error("loading settings for image base url", err);
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

  // Recover the run record (which now persists the schema used for the conversion).
  // Reset the user's manual schema override whenever the run changes.
  useEffect(() => {
    setSelectedSchemaName(null);
    setHashMatchedSchema(null);
    if (!cacheKey) {
      setRunRecord(null);
      return;
    }
    let cancelled = false;
    listRuns()
      .then((runs) => {
        if (!cancelled) setRunRecord(runs.find((r) => r.cache_key === cacheKey) ?? null);
      })
      .catch((err) => console.error("loading run record", err));
    return () => {
      cancelled = true;
    };
  }, [cacheKey]);

  // Fallback for pre-migration runs that have a schema_hash but no stored schema_json:
  // match the hash against built-in presets and saved schemas.
  useEffect(() => {
    const hash = runRecord?.schema_hash;
    if (!hash || runSchema) {
      setHashMatchedSchema(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const candidates = [...PRESETS.map((p) => p.schema), ...savedSchemas];
      for (const candidate of candidates) {
        if (cancelled) return;
        if ((await schemaHash(candidate)) === hash) {
          if (!cancelled) setHashMatchedSchema(candidate);
          return;
        }
      }
      if (!cancelled) setHashMatchedSchema(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [runRecord, runSchema, savedSchemas]);

  // Load the source PDF as a blob URL the first time the panel is opened for a run.
  // Re-fetched whenever the run changes; the object URL is revoked on cleanup.
  useEffect(() => {
    if (!showPdf || !cacheKey) return;
    let cancelled = false;
    let createdUrl: string | null = null;
    setPdfStatus("loading");
    getRunPdfBase64(cacheKey)
      .then((b64) => {
        if (cancelled) return;
        const blob = base64ToBlob(b64, "application/pdf");
        createdUrl = URL.createObjectURL(blob);
        setPdfUrl(createdUrl);
        setPdfStatus("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("loading source pdf", err);
        setPdfStatus("error");
      });
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
      setPdfUrl(null);
      setPdfStatus("idle");
    };
  }, [showPdf, cacheKey]);

  // Drive the iframe to the requested page. Setting .src (rather than just the
  // attribute) forces the embedded viewer to navigate even on a fragment-only change.
  useEffect(() => {
    if (pdfStatus !== "ready" || !pdfUrl || !pdfFrameRef.current) return;
    pdfFrameRef.current.src = `${pdfUrl}#page=${pdfPage}`;
  }, [pdfUrl, pdfPage, pdfStatus]);

  const openPdfAtPage = useCallback((page: number) => {
    setPdfPage(page);
    setShowPdf(true);
  }, []);

  const filteredRows = useMemo(() => {
    if (filter === "all") return rows;
    return rows.filter((r) => {
      if (filter === "needs_review") return r.needs_review;
      if (filter === "ai_needs_review") return r.ai_needs_review;
      if (filter === "ok") return !r.needs_review && !r.ai_needs_review;
      return true;
    });
  }, [rows, filter]);

  // Content type of this run, to scope which presets are offered as alternatives.
  const runContentType = runSchema?.content_type ?? hashMatchedSchema?.content_type ?? runRecord?.content_type ?? null;

  // Schemas the user can switch the view/export to. The run's own schema comes first so it
  // wins any name collision; then matching built-in presets, then saved schemas. De-duped by name.
  const availableSchemas = useMemo<Schema[]>(() => {
    const out: Schema[] = [];
    const seen = new Set<string>();
    const add = (s: Schema | null | undefined) => {
      if (!s || seen.has(s.name)) return;
      seen.add(s.name);
      out.push(s);
    };
    add(runSchema);
    add(hashMatchedSchema);
    for (const p of PRESETS) if (!runContentType || p.schema.content_type === runContentType) add(p.schema);
    for (const s of savedSchemas) add(s);
    return out;
  }, [runSchema, hashMatchedSchema, savedSchemas, runContentType]);

  // The schema actually used to render the table and drive export. Explicit user choice wins;
  // otherwise default to the run's persisted schema, then a hash match. Null → legacy raw view.
  const activeSchema = useMemo<Schema | null>(() => {
    const explicit = selectedSchemaName
      ? availableSchemas.find((s) => s.name === selectedSchemaName) ?? null
      : null;
    return explicit ?? runSchema ?? hashMatchedSchema ?? null;
  }, [selectedSchemaName, availableSchemas, runSchema, hashMatchedSchema]);

  // Column headers: the preset's field names when a schema resolved, else inferred raw keys.
  const schemaColumns = useMemo(() => (activeSchema ? activeSchema.fields.map((f) => f.name) : null), [activeSchema]);
  const legacyColumns = useMemo(() => deriveColumns(rows), [rows]);
  const columns = schemaColumns ?? legacyColumns;

  const handleExportCsv = useCallback(async () => {
    const schema = activeSchema;
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
  }, [rows, activeSchema, cacheKey]);

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
      schema_name: activeSchema?.name ?? "(unknown)",
      content_type: activeSchema?.content_type ?? runRecord?.content_type ?? "(unknown)",
      schema_hash: runRecord?.schema_hash ?? "(see run record)",
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
  }, [rows, activeSchema, runRecord, cacheKey]);

  // Copy every figure crop out to a folder the user picks, then fill the schema's
  // image-URL column with `base + filename` so the exported CSV already points at
  // where the images will live once uploaded.
  const handleExportImages = useCallback(async () => {
    setImgExportMsg(null);

    // Gather every valid figure path, and the per-row first-figure filename.
    const figurePaths: string[] = [];
    const rowFirstName = new Map<SqliteRowRecord, string>();
    for (const r of rows) {
      const row = r.canonical_json as Record<string, unknown>;
      const figs = ((row.figures as any[]) ?? []).filter((f) => f?.path && !f.crop_error);
      if (figs.length === 0) continue;
      for (const f of figs) figurePaths.push(f.path as string);
      rowFirstName.set(r, basename(figs[0].path as string));
    }

    if (figurePaths.length === 0) {
      setImgExportMsg("No figure images to export in this run.");
      return;
    }

    const destDir = await openDialog({
      directory: true,
      title: "Choose a folder to export images into",
    });
    if (!destDir || typeof destDir !== "string") return;

    setImgExporting(true);
    try {
      const copied = await exportFigures(figurePaths, destDir);

      // Fill the image-URL column (if the active schema has one) and persist.
      const urlField = findImageUrlField(activeSchema);
      let filled = 0;
      if (urlField) {
        const base = imageBaseUrl?.trim() ?? "";
        const updated: SqliteRowRecord[] = [];
        for (const [record, name] of rowFirstName) {
          const url = base ? joinUrl(base, name) : name;
          const newCanonical = {
            ...(record.canonical_json as Record<string, unknown>),
            [urlField]: url,
          };
          updated.push({ ...record, canonical_json: newCanonical });
        }
        await saveRows(updated);
        setRows((prev) =>
          prev.map((r) => {
            const u = updated.find(
              (x) =>
                x.page_number === r.page_number &&
                x.row_index_within_page === r.row_index_within_page,
            );
            return u ?? r;
          }),
        );
        filled = updated.length;
      }

      const parts = [`Exported ${copied.length} image${copied.length === 1 ? "" : "s"} to ${destDir}.`];
      if (urlField) {
        parts.push(`Filled "${urlField}" on ${filled} row${filled === 1 ? "" : "s"}.`);
      } else {
        parts.push(`No image-URL column in the active schema, so URLs were not written.`);
      }
      setImgExportMsg(parts.join(" "));
    } catch (err) {
      setImgExportMsg(`Export failed: ${String(err)}`);
    } finally {
      setImgExporting(false);
    }
  }, [rows, activeSchema, imageBaseUrl]);

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
    <div className={`review-table${resizing ? " col-resizing" : ""}`}>
      <header className="review-header">
        <div>
          <h1>Review</h1>
          <p className="hint">
            Cache key: <code>{cacheKey.slice(0, 16)}…</code> · {rows.length} row
            {rows.length === 1 ? "" : "s"}
            {activeSchema ? (
              <> · preset: <strong>{activeSchema.name}</strong>{runSchema && activeSchema.name === runSchema.name ? " (run's preset)" : " (preview)"}</>
            ) : null}
          </p>
        </div>
        <div className="review-actions">
          <select
            title="Preset used to project rows into columns — this is exactly what the CSV will contain."
            value={activeSchema?.name ?? ""}
            onChange={(e) => setSelectedSchemaName(e.target.value || null)}
          >
            {availableSchemas.length === 0 ? <option value="">— no preset available —</option> : null}
            {availableSchemas.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name} ({s.content_type})
                {runSchema && s.name === runSchema.name ? " — run's preset" : ""}
              </option>
            ))}
          </select>
          <button
            className={`btn-secondary ${showPdf ? "active" : ""}`}
            onClick={() => setShowPdf((v) => !v)}
            title="Show the original source PDF beside the columns"
          >
            {showPdf ? "Hide PDF" : "Show PDF"}
          </button>
          <button
            className="btn-secondary"
            onClick={handleExportCsv}
            disabled={rows.length === 0 || !activeSchema}
          >
            Export CSV
          </button>
          {hasFigures ? (
            <button
              className="btn-secondary"
              onClick={handleExportImages}
              disabled={rows.length === 0 || imgExporting}
              title="Copy all figure images to a folder and fill the image-URL column"
            >
              {imgExporting ? "Exporting…" : "Export images"}
            </button>
          ) : null}
          <button
            className="btn-secondary"
            onClick={handleExportAudit}
            disabled={rows.length === 0}
          >
            Export audit JSON
          </button>
        </div>
      </header>
      {imgExportMsg ? <p className="status saved">{imgExportMsg}</p> : null}

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

      <div className={`review-split ${showPdf ? "with-pdf" : ""}`}>
        <div className="review-main-col">
      {filteredRows.length > 0 ? (
        <div className="review-table-wrap">
          <table style={{ tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: colWidths["__page"] ?? 52 }} />
              <col style={{ width: colWidths["__idx"] ?? 42 }} />
              {hasFigures ? <col style={{ width: colWidths["__figures"] ?? 100 }} /> : null}
              {columns.map((c) => (
                <col key={c} style={{ width: colWidths[c] ?? 150 }} />
              ))}
              <col style={{ width: colWidths["__flags"] ?? 120 }} />
            </colgroup>
            <thead>
              <tr>
                <th style={{ position: "relative" }}>
                  <span className="th-label">page</span>
                  <div className="col-resize-handle" onMouseDown={(e) => startResize("__page", e)} />
                </th>
                <th title="Row index within this page (0-based internal ordering)" style={{ position: "relative" }}>
                  <span className="th-label">#</span>
                  <div className="col-resize-handle" onMouseDown={(e) => startResize("__idx", e)} />
                </th>
                {hasFigures ? (
                  <th style={{ position: "relative" }}>
                    <span className="th-label">figures</span>
                    <div className="col-resize-handle" onMouseDown={(e) => startResize("__figures", e)} />
                  </th>
                ) : null}
                {columns.map((c) => (
                  <th key={c} style={{ position: "relative" }}>
                    <span className="th-label">{c}</span>
                    <div className="col-resize-handle" onMouseDown={(e) => startResize(c, e)} />
                  </th>
                ))}
                <th style={{ position: "relative" }}>
                  <span className="th-label">flags</span>
                  <div className="col-resize-handle" onMouseDown={(e) => startResize("__flags", e)} />
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r, i) => {
                const row = r.canonical_json as Record<string, unknown>;
                // When a schema is active, project the row exactly as the CSV export does so
                // the table mirrors the picked preset's output. Otherwise show raw canonical keys.
                const cellValues = activeSchema
                  ? projectRow(activeSchema, row as ExtractedRow).map((c) => c.value)
                  : columns.map((c) => row[c]);
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
                    <td
                      className="review-page-cell"
                      title="Open this page in the PDF panel"
                      onClick={() => openPdfAtPage(r.page_number)}
                    >
                      {r.page_number}
                    </td>
                    <td>{r.row_index_within_page}</td>
                    {hasFigures ? (
                      <td>
                        <div className="figure-cell">
                          {((row.figures as any[]) ?? []).map((fig: any, fIdx: number) => {
                            if (fig.crop_error) {
                              return (
                                <div
                                  key={fIdx}
                                  className="figure-warning-icon"
                                  title={`Crop error: ${fig.crop_error}`}
                                >
                                  ⚠️
                                </div>
                              );
                            }
                            if (fig.path) {
                              return (
                                <div
                                  key={fIdx}
                                  className="figure-thumbnail-container"
                                  onClick={() => setActiveLightbox(fig)}
                                  title={`${fig.kind}: ${fig.explanation}`}
                                >
                                  <img
                                    src={convertFileSrc(fig.path)}
                                    alt={fig.explanation}
                                  />
                                </div>
                              );
                            }
                            return null;
                          })}
                        </div>
                      </td>
                    ) : null}
                    {columns.map((c, ci) => (
                      <td key={c}>{formatCell(cellValues[ci])}</td>
                    ))}
                    <td>
                      {r.needs_review ? <span className="chip warn">needs review</span> : null}
                      {r.ai_needs_review ? (
                        <span className="chip warn">ai uncertain</span>
                      ) : null}
                      {r.user_edited ? <span className="chip">edited</span> : null}
                      {(row as Record<string, unknown>).converted_from ? (
                        <span className="chip" title={`Converted from a ${String((row as Record<string, unknown>).converted_from)} question`}>
                          converted
                        </span>
                      ) : null}
                      {(row as Record<string, unknown>).duplicate_suspected ? (
                        <span className="chip warn" title="This question shares its text with another question number — likely an extraction mix-up. Verify against the source.">
                          duplicate?
                        </span>
                      ) : null}
                      {(row as Record<string, unknown>).ai_generated ? (
                        <span className="chip" title="Answer supplied by the AI (no answer was marked in the document). Verify it.">
                          ai answer
                        </span>
                      ) : null}
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

        {showPdf ? (
          <aside className="review-pdf-panel">
            <div className="review-pdf-bar">
              <span>Source PDF{pdfStatus === "ready" ? ` · page ${pdfPage}` : ""}</span>
              <button className="review-pdf-close" onClick={() => setShowPdf(false)} title="Hide PDF">×</button>
            </div>
            {pdfStatus === "loading" ? <p className="hint review-pdf-msg">Loading PDF…</p> : null}
            {pdfStatus === "error" ? (
              <p className="status error review-pdf-msg">
                Source PDF unavailable — it may have been moved or deleted since this run.
              </p>
            ) : null}
            <iframe ref={pdfFrameRef} title="Source PDF" className="review-pdf-frame" />
          </aside>
        ) : null}
      </div>

      {activeLightbox ? (
        <div className="lightbox-overlay" onClick={() => setActiveLightbox(null)}>
          <div className="lightbox-content" onClick={(e) => e.stopPropagation()}>
            <button className="lightbox-close" onClick={() => setActiveLightbox(null)}>×</button>
            {activeLightbox.path ? (
              <img src={convertFileSrc(activeLightbox.path)} alt={activeLightbox.explanation} />
            ) : null}
            <div className="lightbox-meta">
              <span className="badge kind">{activeLightbox.kind}</span>
              <p className="lightbox-desc">{activeLightbox.explanation}</p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Last path segment, handling both / and \ separators (figures use OS-native paths). */
function basename(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

/** Join a base URL and a filename with exactly one slash between them. */
function joinUrl(base: string, name: string): string {
  return base.endsWith("/") ? base + name : `${base}/${name}`;
}

/**
 * Pick the schema field that should receive the image URL. Prefers an exact
 * `image_url`, then any field whose name pairs "url" with an image-ish word,
 * then any field containing "url". Returns null if the schema has no URL column.
 */
function findImageUrlField(schema: Schema | null): string | null {
  if (!schema) return null;
  const names = schema.fields.map((f) => f.name);
  if (names.includes("image_url")) return "image_url";
  const imageUrlish = names.find((n) => /url/i.test(n) && /(image|img|pic|photo)/i.test(n));
  if (imageUrlish) return imageUrlish;
  return names.find((n) => /url/i.test(n)) ?? null;
}

function base64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
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
    if (k === "options" || k === "source_snippet" || k === "notes" || k === "figures") continue;
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

