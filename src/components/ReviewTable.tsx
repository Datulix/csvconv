import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeFile, mkdir, BaseDirectory } from "@tauri-apps/plugin-fs";
import { loadRows, listRuns, getRunPdfBase64, saveRows, type SqliteRowRecord, type SqliteRunRecord } from "../lib/sqliteCache";
import { buildAuditJson, buildCsv, projectRow, writeTextFile, type AuditExport } from "../lib/export";
import { readImageAsBase64 } from "../lib/pdfApi";
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
    try {
      const extractedRows: ExtractedRow[] = rows.map((r) => r.canonical_json as ExtractedRow);
      const content = buildCsv(schema, extractedRows);
      await writeTextFile(path, content);
      setImgExportMsg(`Exported ${extractedRows.length} row${extractedRows.length === 1 ? "" : "s"} to CSV.`);
    } catch (err) {
      setImgExportMsg(`CSV export failed: ${String(err)}`);
    }
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
    try {
      await writeTextFile(path, buildAuditJson(data));
      setImgExportMsg("Exported audit JSON.");
    } catch (err) {
      setImgExportMsg(`Audit JSON export failed: ${String(err)}`);
    }
  }, [rows, activeSchema, runRecord, cacheKey]);

  // Write every figure crop into the phone's (or desktop's) Downloads folder, under a
  // per-run subfolder, then fill the schema's image-URL column with `base + filename` so
  // the exported CSV already points at where the images will live once uploaded.
  //
  // Goes through the fs plugin (not the std::fs `export_figures` command + a folder
  // picker), because on Android the picker returns a `content://` URI that std::fs can't
  // write to. `BaseDirectory.Download` is browser-accessible there for the later upload,
  // and resolves to ~/Downloads on desktop — one code path for both.
  const handleExportImages = useCallback(async () => {
    setImgExportMsg(null);

    // Gather every valid figure path, and the per-row list of figure filenames
    // (a question can have more than one figure).
    const figurePaths: string[] = [];
    const rowNames = new Map<SqliteRowRecord, string[]>();
    for (const r of rows) {
      const row = r.canonical_json as Record<string, unknown>;
      const figs = ((row.figures as any[]) ?? []).filter((f) => f?.path && !f.crop_error);
      if (figs.length === 0) continue;
      for (const f of figs) figurePaths.push(f.path as string);
      rowNames.set(r, figs.map((f) => basename(f.path as string)));
    }

    if (figurePaths.length === 0) {
      setImgExportMsg("No figure images to export in this run.");
      return;
    }

    setImgExporting(true);
    try {
      const destSub = `csvconv-${cacheKey?.slice(0, 8) ?? "export"}`;
      await mkdir(destSub, { baseDir: BaseDirectory.Download, recursive: true });

      // Copy each unique crop (hash filenames are already unique) into the subfolder.
      const seen = new Set<string>();
      let copied = 0;
      for (const p of figurePaths) {
        const name = basename(p);
        if (seen.has(name)) continue;
        seen.add(name);
        const b64 = await readImageAsBase64(p);
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        await writeFile(`${destSub}/${name}`, bytes, { baseDir: BaseDirectory.Download });
        copied += 1;
      }

      // Fill the image-URL column (if the active schema has one) and persist.
      const urlField = findImageUrlField(activeSchema);
      // Triviadox stores image_url as a JSON array so a question can carry
      // multiple images; other url-ish columns keep a single string value.
      const asJsonArray = urlField === "image_url";
      let filled = 0;
      if (urlField) {
        const base = imageBaseUrl?.trim() ?? "";
        const updated: SqliteRowRecord[] = [];
        for (const [record, names] of rowNames) {
          const urls = names.map((n) => (base ? joinUrl(base, n) : n));
          const value = asJsonArray ? JSON.stringify(urls) : urls[0];
          const newCanonical = {
            ...(record.canonical_json as Record<string, unknown>),
            [urlField]: value,
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

      const parts = [`Saved ${copied} image${copied === 1 ? "" : "s"} to Downloads/${destSub}/.`];
      if (urlField) {
        parts.push(`Filled "${urlField}" on ${filled} row${filled === 1 ? "" : "s"}.`);
      } else {
        parts.push(`No image-URL column in the active schema, so URLs were not written.`);
      }
      setImgExportMsg(parts.join(" "));
    } catch (err) {
      setImgExportMsg(`Image export failed: ${String(err)}`);
    } finally {
      setImgExporting(false);
    }
  }, [rows, activeSchema, imageBaseUrl, cacheKey]);

  // Rows whose AI answer differs from the extracted answer (and so can be adopted).
  const adoptableCount = useMemo(() => rows.filter(isAdoptable).length, [rows]);

  // Replace the extracted answer with the AI's answer (a letter) on the given rows
  // (skipping any that aren't adoptable), mark them user-edited, and persist. Triviadox
  // stores the answer twice — `correct_answer` (letter) and `correct_index` (0-based) —
  // as independently model-generated fields, so both must be kept in sync.
  const adoptAiAnswers = useCallback(async (targets: SqliteRowRecord[]) => {
    const updated: SqliteRowRecord[] = targets.filter(isAdoptable).map((r) => {
      const row = r.canonical_json as Record<string, unknown>;
      const aiLetter = String(row.ai_answer);
      const next: Record<string, unknown> = { ...row, correct_answer: aiLetter };
      // Mirror the letter into a 0-based index field if the schema uses one (Triviadox).
      const idx = "ABCDE".indexOf(aiLetter);
      if ("correct_index" in row && idx >= 0) next.correct_index = idx;
      // Keep the compare fields internally consistent for export/audit.
      if ("agreement" in row) next.agreement = true;
      if ("disagreement_reason" in row) next.disagreement_reason = null;
      return { ...r, canonical_json: next, user_edited: true };
    });
    if (updated.length === 0) return;
    try {
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
    } catch (err) {
      setError(`Failed to save answer change: ${String(err)}`);
    }
  }, []);

  const handleAdoptAll = useCallback(() => {
    if (adoptableCount === 0) return;
    if (
      !window.confirm(
        `Replace the extracted answer with the AI's answer on ${adoptableCount} row${
          adoptableCount === 1 ? "" : "s"
        } where they differ? This overwrites the printed/extracted answer.`,
      )
    )
      return;
    void adoptAiAnswers(rows);
  }, [adoptableCount, adoptAiAnswers, rows]);

  // Figure thumbnails for a row — shared by the desktop table cell and the mobile card.
  const renderFigures = (row: Record<string, unknown>) => (
    <div className="figure-cell">
      {((row.figures as any[]) ?? []).map((fig: any, fIdx: number) => {
        if (fig.crop_error) {
          return (
            <div key={fIdx} className="figure-warning-icon" title={`Crop error: ${fig.crop_error}`}>
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
              <img src={convertFileSrc(fig.path)} alt={fig.explanation} />
            </div>
          );
        }
        return null;
      })}
    </div>
  );

  // Flag chips + the per-row "use AI" action — shared by the table cell and the card.
  const renderFlags = (r: SqliteRowRecord, row: Record<string, unknown>) => (
    <>
      {r.needs_review ? <span className="chip warn">needs review</span> : null}
      {r.ai_needs_review ? <span className="chip warn">ai uncertain</span> : null}
      {r.user_edited ? <span className="chip">edited</span> : null}
      {row.converted_from ? (
        <span className="chip" title={`Converted from a ${String(row.converted_from)} question`}>
          converted
        </span>
      ) : null}
      {row.duplicate_suspected ? (
        <span className="chip warn" title="This question shares its text with another question number — likely an extraction mix-up. Verify against the source.">
          duplicate?
        </span>
      ) : null}
      {row.ai_generated ? (
        <span className="chip" title="Answer supplied by the AI (no answer was marked in the document). Verify it.">
          ai answer
        </span>
      ) : null}
      {isAdoptable(r) ? (
        <button
          className="chip-button adopt-ai"
          title={`Extracted answer is ${String(row.correct_answer ?? "—")}; set it to the AI's answer (${String(row.ai_answer)})`}
          onClick={() => void adoptAiAnswers([r])}
        >
          use AI ({String(row.ai_answer)})
        </button>
      ) : null}
    </>
  );

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
            className={`btn-secondary review-pdf-toggle ${showPdf ? "active" : ""}`}
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
              title="Save all figure images into your Downloads folder and fill the image-URL column"
            >
              {imgExporting ? "Exporting…" : "Export images"}
            </button>
          ) : null}
          {adoptableCount > 0 ? (
            <button
              className="btn-secondary"
              onClick={handleAdoptAll}
              title="Replace the extracted answer with the AI's answer on every row where they differ"
            >
              Keep AI answers ({adoptableCount})
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
                    {hasFigures ? <td>{renderFigures(row)}</td> : null}
                    {columns.map((c, ci) => (
                      <td key={c}>{formatCell(cellValues[ci])}</td>
                    ))}
                    <td>{renderFlags(r, row)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : rows.length > 0 ? (
        <p className="hint">No rows match the current filter.</p>
      ) : null}

      {/* Mobile-only stacked-card view of the same rows (the table is unreadable when
          9 columns are crushed into a phone width). Toggled via CSS, not JS. */}
      {filteredRows.length > 0 ? (
        <div className="review-cards">
          {filteredRows.map((r, i) => {
            const row = r.canonical_json as Record<string, unknown>;
            const fields = activeSchema
              ? projectRow(activeSchema, row as ExtractedRow)
              : columns.map((c) => ({ name: c, value: row[c] }));
            const figs = (row.figures as any[]) ?? [];
            return (
              <div
                key={`card-${r.page_number}-${r.row_index_within_page}-${i}`}
                className={`review-card ${
                  r.needs_review ? "row-needs-review" : r.ai_needs_review ? "row-ai-needs-review" : ""
                }`}
              >
                <div className="review-card-head">
                  <span
                    className="review-card-loc review-page-cell"
                    title="Open this page in the PDF panel"
                    onClick={() => openPdfAtPage(r.page_number)}
                  >
                    page {r.page_number} · #{r.row_index_within_page}
                  </span>
                  {figs.length > 0 ? renderFigures(row) : null}
                </div>
                <dl className="review-card-fields">
                  {fields.map((f) => (
                    <div key={f.name} className="review-card-field">
                      <dt>{f.name}</dt>
                      <dd>{formatCell(f.value)}</dd>
                    </div>
                  ))}
                </dl>
                <div className="review-card-flags">{renderFlags(r, row)}</div>
              </div>
            );
          })}
        </div>
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

/**
 * A row whose AI answer can be adopted: it has a non-empty `ai_answer` that differs
 * from the current `correct_answer`. Agreements and AI-declined rows are no-ops.
 */
function isAdoptable(r: SqliteRowRecord): boolean {
  const row = r.canonical_json as Record<string, unknown>;
  const ai = row.ai_answer;
  if (ai === null || ai === undefined || ai === "") return false;
  return row.correct_answer !== ai;
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

