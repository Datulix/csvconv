import { useCallback, useEffect, useMemo, useState, type MouseEvent as RMouseEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { loadRows, listRuns, renderRunPdfPage, saveRows, type SqliteRowRecord, type SqliteRunRecord } from "../lib/sqliteCache";
import { buildAuditJson, buildCsv, projectRow, writeTextFile, type AuditExport } from "../lib/export";
import { exportFiguresToDownloads, zipFigures } from "../lib/pdfApi";
import { platformKind } from "../lib/updates";
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
  const [editMode, setEditMode] = useState(false);
  const [savedSchemas, setSavedSchemas] = useState<Schema[]>([]);
  const [selectedSchemaName, setSelectedSchemaName] = useState<string | null>(null);
  const [runRecord, setRunRecord] = useState<SqliteRunRecord | null>(null);
  const [hashMatchedSchema, setHashMatchedSchema] = useState<Schema | null>(null);
  const [activeLightbox, setActiveLightbox] = useState<{ path?: string; explanation: string; kind: string } | null>(null);

  // Source-PDF preview panel beside the columns. Pages are rendered to images (an iframe
  // can't display a PDF in the WebView, especially on Android).
  const [showPdf, setShowPdf] = useState(false);
  const [pdfImg, setPdfImg] = useState<string | null>(null);
  const [pdfStatus, setPdfStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pdfPage, setPdfPage] = useState(1);

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

  // Render the requested page of the source PDF to an image. The WebView can't show a PDF
  // in an iframe (Android System WebView has no PDF viewer), so we render server-side via
  // pdfium and display a JPEG. Re-renders whenever the page or run changes.
  useEffect(() => {
    if (!showPdf || !cacheKey) return;
    let cancelled = false;
    setPdfStatus("loading");
    setPdfError(null);
    renderRunPdfPage(cacheKey, pdfPage)
      .then((b64) => {
        if (cancelled) return;
        setPdfImg(`data:image/jpeg;base64,${b64}`);
        setPdfStatus("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("rendering pdf page", err);
        setPdfError(String(err));
        setPdfStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [showPdf, cacheKey, pdfPage]);

  // Drop any stale rendered page when the run changes so we never show run A's page for run B.
  useEffect(() => {
    setPdfImg(null);
    setPdfPage(1);
  }, [cacheKey]);

  const openPdfAtPage = useCallback((page: number) => {
    setPdfPage(page);
    setShowPdf(true);
  }, []);

  // Highest page number present, to bound the PDF panel's prev/next navigation.
  const maxPage = useMemo(() => rows.reduce((m, r) => Math.max(m, r.page_number), 1), [rows]);

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

  // Per-column editing metadata, aligned with `columns`. A column is editable when it maps
  // directly to a canonical field (so we know where to write the value back). Template /
  // computed schema fields are derived from other fields and stay read-only.
  const columnMeta = useMemo<Array<{ name: string; key: string; editable: boolean }>>(() => {
    if (activeSchema) {
      return activeSchema.fields.map((f) => ({ name: f.name, key: f.name, editable: !f.template }));
    }
    return columns.map((c) => ({ name: c, key: c, editable: true }));
  }, [activeSchema, columns]);

  const handleExportCsv = useCallback(async () => {
    const schema = activeSchema;
    if (!schema) {
      alert("Pick a schema for export (the run's original schema or any saved one).");
      return;
    }
    const path = await saveDialog({
      // Include a timestamp so the name is always unique: on Android the Downloads
      // provider de-dupes a repeated name by appending "_1" to the *whole* string
      // (→ "….csv_1"), which breaks the extension. A unique name avoids that.
      defaultPath: `csvconv-${cacheKey?.slice(0, 8) ?? "export"}-${fileStamp()}.csv`,
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
      defaultPath: `csvconv-${cacheKey.slice(0, 8)}-${fileStamp()}.audit.json`,
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

  // Export figure crops, then fill the schema's image-URL column with `base + filename`
  // so the exported CSV already points at where the images will live once uploaded.
  //
  // Desktop copies the crops into ~/Downloads/<subfolder>/. Android bundles them into a
  // single ZIP saved through the dialog (the fs-plugin content:// path that CSV export
  // uses) — reliable, unlike per-file MediaStore writes or the invisible app-private
  // `BaseDirectory.Download`.
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
      const keyShort = cacheKey?.slice(0, 8) ?? "export";
      let savedMsg: string;
      if (platformKind() === "android") {
        // Android: bundle the crops into one zip and save it through the dialog. This rides
        // the same fs-plugin content:// path that makes CSV export reliable, instead of the
        // fragile per-file MediaStore route.
        const zipName = `csvconv-images-${keyShort}-${fileStamp()}.zip`;
        const zipPath = await zipFigures(figurePaths, zipName);
        const dest = await saveDialog({
          defaultPath: zipName,
          filters: [{ name: "ZIP", extensions: ["zip"] }],
        });
        if (!dest) {
          setImgExporting(false);
          return;
        }
        const bytes = await readFile(zipPath);
        await writeFile(dest, bytes);
        const n = figurePaths.length;
        savedMsg = `Saved ${n} image${n === 1 ? "" : "s"} as a ZIP — extract it, then upload the images.`;
      } else {
        // Desktop: copy the crops into a Downloads subfolder.
        const destSub = `csvconv-${keyShort}`;
        const copied = await exportFiguresToDownloads(figurePaths, destSub);
        savedMsg = `Saved ${copied} image${copied === 1 ? "" : "s"} to Downloads/${destSub}/.`;
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

      const parts = [savedMsg];
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

  // Write a single edited field back to a row's canonical JSON, flag it user-edited, and
  // persist. Optimistically updates local state so the cell reflects the change immediately;
  // the same value then flows through to CSV / audit export (which read canonical_json).
  const updateRowField = useCallback(
    async (record: SqliteRowRecord, key: string, value: unknown) => {
      const next = { ...(record.canonical_json as Record<string, unknown>), [key]: value };
      const updated: SqliteRowRecord = { ...record, canonical_json: next, user_edited: true };
      setRows((prev) =>
        prev.map((r) =>
          r.page_number === record.page_number &&
          r.row_index_within_page === record.row_index_within_page
            ? updated
            : r,
        ),
      );
      try {
        await saveRows([updated]);
      } catch (err) {
        setError(`Failed to save edit: ${String(err)}`);
      }
    },
    [],
  );

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
            className={`btn-secondary ${editMode ? "active" : ""}`}
            onClick={() => setEditMode((v) => !v)}
            disabled={rows.length === 0}
            title="Edit any field value inline. Changes are saved and used for CSV / audit export."
          >
            {editMode ? "Done editing" : "Edit rows"}
          </button>
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
                    {columnMeta.map((meta, ci) => (
                      <td key={meta.name} className={editMode && meta.editable ? "review-edit-cell" : ""}>
                        {editMode && meta.editable ? (
                          <EditableCell
                            value={row[meta.key]}
                            onCommit={(v) => void updateRowField(r, meta.key, v)}
                          />
                        ) : (
                          formatCell(cellValues[ci])
                        )}
                      </td>
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
            const editableByName = new Map(columnMeta.map((m) => [m.name, m]));
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
                  {fields.map((f) => {
                    const meta = editableByName.get(f.name);
                    return (
                      <div key={f.name} className="review-card-field">
                        <dt>{f.name}</dt>
                        <dd>
                          {editMode && meta?.editable ? (
                            <EditableCell
                              value={row[meta.key]}
                              onCommit={(v) => void updateRowField(r, meta.key, v)}
                            />
                          ) : (
                            formatCell(f.value)
                          )}
                        </dd>
                      </div>
                    );
                  })}
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
              <div className="review-pdf-nav">
                <button
                  className="review-pdf-navbtn"
                  onClick={() => setPdfPage((p) => Math.max(1, p - 1))}
                  disabled={pdfPage <= 1}
                  title="Previous page"
                >
                  ‹
                </button>
                <span>Page {pdfPage}{maxPage > 1 ? ` / ${maxPage}` : ""}</span>
                <button
                  className="review-pdf-navbtn"
                  onClick={() => setPdfPage((p) => Math.min(maxPage, p + 1))}
                  disabled={pdfPage >= maxPage}
                  title="Next page"
                >
                  ›
                </button>
              </div>
              <button className="review-pdf-close" onClick={() => setShowPdf(false)} title="Hide PDF">×</button>
            </div>
            <div className="review-pdf-scroll">
              {pdfStatus === "loading" && !pdfImg ? (
                <p className="hint review-pdf-msg">Rendering page…</p>
              ) : null}
              {pdfStatus === "error" ? (
                <p className="status error review-pdf-msg">
                  Couldn't render this page{pdfError ? `: ${pdfError}` : "."}. The source PDF may have
                  been moved or deleted since this run.
                </p>
              ) : null}
              {pdfImg ? (
                <img className="review-pdf-image" src={pdfImg} alt={`PDF page ${pdfPage}`} />
              ) : null}
            </div>
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

/**
 * Inline editor for one canonical field value. Keeps a local text draft and commits on
 * blur / Enter (Escape reverts), coercing the text back toward the original value's type so
 * numbers stay numbers and JSON-ish fields (options, etc.) round-trip. Escape closes without
 * saving; Shift+Enter inserts a newline for multi-line fields.
 */
function EditableCell({ value, onCommit }: { value: unknown; onCommit: (v: unknown) => void }) {
  const [text, setText] = useState(() => valueToText(value));
  // Re-sync if the underlying value changes externally (e.g. adopt-AI, image export).
  useEffect(() => setText(valueToText(value)), [value]);

  const commit = () => {
    const coerced = coerceValue(value, text);
    if (JSON.stringify(coerced) !== JSON.stringify(value)) onCommit(coerced);
  };

  return (
    <textarea
      className="review-edit-input"
      value={text}
      rows={1}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        } else if (e.key === "Escape") {
          setText(valueToText(value));
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
    />
  );
}

/** Render a canonical value as editable text. Objects/arrays become JSON. */
function valueToText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/** Coerce edited text back toward the original value's type. */
function coerceValue(original: unknown, text: string): unknown {
  if (typeof original === "number") {
    if (text.trim() === "") return null;
    const n = Number(text);
    return Number.isNaN(n) ? text : n;
  }
  if (typeof original === "boolean") {
    const t = text.trim().toLowerCase();
    if (t === "true") return true;
    if (t === "false") return false;
    return text;
  }
  if (original && typeof original === "object") {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  // Original was a string, null, or undefined.
  if (text === "") return original === null || original === undefined ? null : "";
  return text;
}

/** Last path segment, handling both / and \ separators (figures use OS-native paths). */
function basename(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

/** Compact local timestamp (`YYYYMMDD-HHMMSS`) for unique export filenames. */
function fileStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
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

