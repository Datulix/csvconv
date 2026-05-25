# csvconv — Specification

A desktop app that converts PDFs (primarily MCQ exams, with extensibility to other content types) into structured CSV using the user's own Google AI Studio API key.

## 1. Goals & non-goals

**Goals**
- Convert structured PDFs into clean, upload-ready CSVs whose schema is defined by the user.
- Support multiple **content types** (MCQ, flashcards, Q&A pairs), each with its own extractor pipeline.
- For MCQs: support multiple answer-marking conventions (inline circled, marked, written, separate answer key) via a format detector + specialized extractors.
- **AI Review mode** (MCQ only): extract marked answers AND have the AI independently answer each question, surfacing disagreements for inspection.
- **AI Answer mode** (MCQ only): have the AI answer each question from scratch (ignore any marked answers), producing an AI-generated answer key with explanations.
- Surface uncertainty: low-confidence rows are flagged for human review (extraction uncertainty and AI-answer uncertainty are tracked separately), never silently dropped.
- Preserve traceability: per-row audit data in a sidecar JSON.
- **Streaming pipeline**: rows appear in the Review UI as soon as they're ready, not after a full pass completes.
- **Local triage** before LLM calls: detect digital vs scanned PDFs, skip blank pages, apply deskew/contrast to skewed scans. Saves API spend on garbage pages and improves OCR quality on bad scans.
- **Privacy-aware**: warn user about training-data implications of the free Gemini API tier before they paste their key.

**Non-goals (v1)**
- Bubble-sheet / OMR processing.
- Batch processing of folders.
- Cloud-hosted version; this is local desktop only.
- Custom fine-tunes.

## 2. Tech stack

| Layer       | Choice                             | Why                                                |
| ----------- | ---------------------------------- | -------------------------------------------------- |
| Shell       | Tauri                              | ~10MB installer, native menus, Rust backend        |
| Frontend    | React + TypeScript + Vite          | Mature ecosystem, fast dev loop                    |
| AI client   | `@google/genai` (TS, renderer)     | Used for both Gemini and Gemma via Google AI Studio. Lives near UI for fast prompt iteration. |
| PDF render  | `pdfium-render` (Rust)             | Mature, fast, bundles Pdfium binary. Supports password-protected PDFs. |
| Image       | `image` + `imageproc` (Rust)       | Re-encode raster output to JPEG with quality/size control; deskew and contrast for scan triage |
| Keychain    | `keyring` (Rust)                   | Cross-platform OS keychain for API key             |
| Cache       | `rusqlite` (Rust)                  | Resume on crash, dedupe re-runs                    |
| CSV         | `csv` crate (Rust)                 | Write final export                                 |
| Validation  | `zod` (TS)                         | Validate model responses before accepting          |
| Streaming   | Async iterators + ReadableStream (TS) | Per-stage queues for streaming pipeline         |

## 3. Directory layout

```
csvconv/
├── src-tauri/                 Rust backend
│   ├── src/
│   │   ├── main.rs
│   │   ├── pdf.rs             rasterize via pdfium-render
│   │   ├── triage.rs          digital vs scanned detection, blank-page filter, deskew
│   │   ├── cache.rs           SQLite resume state
│   │   ├── keychain.rs        API key storage
│   │   ├── csv_export.rs
│   │   └── commands.rs        Tauri command surface (see §3.1)
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/                       React frontend
│   ├── components/
│   │   ├── FilePicker.tsx
│   │   ├── Settings.tsx
│   │   ├── SchemaEditor.tsx
│   │   ├── ModeAndModelPicker.tsx
│   │   ├── Processing.tsx     streaming progress per stage
│   │   └── ReviewTable.tsx    populates incrementally
│   ├── pipelines/
│   │   ├── orchestrator.ts    wires stages into a streaming graph
│   │   ├── detector.ts        MCQ format detector (2-3 sample pages → format classification)
│   │   ├── documentAnalyzer.ts  full-document intelligence (all pages → structural map)
│   │   ├── extractors/
│   │   │   ├── mcq_inlineMarked.ts
│   │   │   ├── mcq_writtenAnswer.ts
│   │   │   ├── mcq_answerKeyAtEnd.ts
│   │   │   ├── flashcard.ts
│   │   │   └── qaPair.ts
│   │   ├── validator.ts       cross-model disagreement check
│   │   ├── solver.ts          AI independent answering (vision, MCQ only)
│   │   ├── compare.ts         marked vs AI agreement (MCQ Review mode)
│   │   └── merge.ts           page-span question stitching
│   ├── schema/
│   │   ├── types.ts
│   │   ├── presets.ts
│   │   ├── contentTypes.ts    registry of content types
│   │   ├── promptBuilder.ts   assemble prompt + response schema from user fields + content_type
│   │   └── hash.ts            stable schema hash for cache key
│   ├── lib/
│   │   ├── modelClient.ts     @google/genai wrapper: retries, rate-limit, per-model RPM, request-size pre-check
│   │   ├── batching.ts        page batching, question grouping, auto-split-on-truncation
│   │   ├── queues.ts          streaming queues with backpressure
│   │   ├── resume.ts          resume protocol: which batches re-emit on cache hit
│   │   └── cost.ts            token estimation, $ preview per stage (with ranges)
│   └── App.tsx
├── package.json
└── vite.config.ts
```

### 3.1 Tauri command surface

| Command                       | Direction | Purpose                                          |
| ----------------------------- | --------- | ------------------------------------------------ |
| `triage_pdf(path, run_id, password?)` | TS → Rust | Per-page analysis BEFORE rasterization: returns `Vec<{page_number, is_blank, page_type: "digital"|"scanned"|"mixed", text_density: float, skew_angle_deg: float}>`. Uses Pdfium text-extraction APIs to measure text density per page; flags pages with no rendered content as blank; estimates skew via Hough transform on a thumbnail. |
| `rasterize_pdf(path, dpi, run_id, password?, deskew_pages?, skip_pages?)` | TS → Rust | Render pages to JPEGs in staging dir `%APPDATA%/csvconv/staging/<run_id>/page-N.jpg`; return file paths. JPEGs re-encoded at quality=82, max long-edge 2048 px. `deskew_pages` is the list of page numbers to apply deskew/contrast to (from triage). `skip_pages` (blank pages) are not rasterized. `password` supplied for encrypted PDFs. |
| `cleanup_staging(run_id)`     | TS → Rust | Delete the staging directory for a finished run  |
| `crop_figures_batch(jobs)`    | TS → Rust | Crop multiple bounding box regions from page JPEGs in parallel and save to persistent storage |
| `figures_dir(cache_key)`      | TS → Rust | Get or create the persistent figures directory path for the given cache key |
| `cleanup_figures(cache_key)`  | TS → Rust | Delete the figures directory for a purged run |
| `hash_pdf(path)`              | TS → Rust | sha256 of PDF bytes for cache key                |
| `keychain_set(api_key)`       | TS → Rust | Store API key in OS keychain                     |
| `keychain_get()`              | TS → Rust | Retrieve API key                                 |
| `cache_get_run(key)`          | TS → Rust | Look up previous run state                       |
| `cache_save_batch(key, batch)`| TS → Rust | Persist completed batch result                   |
| `cache_clear()`               | TS → Rust | User-initiated cache wipe                        |
| `save_schema(name, json)`     | TS → Rust | Persist user schema                              |
| `load_schemas()`              | TS → Rust | List + read saved schemas                        |
| `write_csv(path, rows)`       | TS → Rust | Final export                                     |
| `write_audit_json(path, data)`| TS → Rust | Sidecar audit export                             |
| `open_file_dialog(filters)`   | TS → Rust | File picker (or use plugin-dialog)               |
| `progress_event(stage, msg)`  | Rust → TS | Streaming progress updates from long ops         |

## 4. Pipeline (streaming)

### 4.1 Overview

The pipeline is a **streaming directed graph** of async stages connected by bounded queues. Downstream stages start consuming as soon as upstream stages produce. The Review UI subscribes to the final stage's output and populates incrementally.

```
PDF in
   │
   ▼
┌──────────────────────────────────────────────────────────────┐
│ Local triage (Rust, no LLM) — digital/scanned detection,     │
│ blank-page filter, skew detection per page                   │
└──────────────────────────────────────────────────────────────┘
   │ per-page metadata: {is_blank, page_type, skew_angle_deg}
   ▼
┌──────────────────────────────────────────────────────────────┐
│ Rasterizer (Rust) — JPEGs to staging dir; skips blank pages, │
│ applies deskew/contrast to scanned-skewed pages              │
└──────────────────────────────────────────────────────────────┘
   │ page images (all non-blank pages, base64-encoded)
   ▼
┌──────────────────────────────────────────────────────────────┐
│ Document Intelligence (ALL pages → structural map)           │
│  • per-page: content_type, section_label, question range     │
│  • answer_key_locations (exact pages, per section)           │
│  • cross_page_questions, content_patterns, exam_metadata     │
└──────────────────────────────────────────────────────────────┘
   │ DocumentAnalysisResult (falls back to heuristics on error)
   ▼
┌──────────────────────────────────────────────────────────────┐
│ Detector (MCQ only, mode ≠ Answer-from-scratch; 2-3 pages)   │
└──────────────────────────────────────────────────────────────┘
   │ format + [User confirms / overrides if confidence < 0.6]
   ▼
┌──────────────────────────────────────────────────────────────┐
│ Extractor (content-type + format specific, batches of 10)    │
└──────────────────────────────────────────────────────────────┘
   │ rows (with confidence per row)
   ▼
┌──────────────────────────────────────────────────────────────┐
│ Validator — INLINE FILTER                                    │
│  • High-confidence rows pass through unchanged               │
│  • confidence < 0.75 rows are re-extracted (cross-model      │
│    if 2 models configured, else stricter-prompt re-pass)     │
│  • Disagreements flagged needs_review, both candidates       │
│    kept in audit                                             │
└──────────────────────────────────────────────────────────────┘
   │ finalized rows
   ▼
┌──────────────────────────────────────────────────────────────┐
│ Merge — page-span stitching (windowed pass)                  │
└──────────────────────────────────────────────────────────────┘
   │
   ├──► (Extract mode) ──────────────────────────────┐
   │                                                  │
   ▼                                                  │
┌──────────────────────────────────────────────────┐ │
│ Solver — MCQ Review / Answer modes only          │ │
│ Groups questions by source page; vision input    │ │
└──────────────────────────────────────────────────┘ │
   │                                                  │
   ▼                                                  │
┌──────────────────────────────────────────────────┐ │
│ Compare — MCQ Review mode only                   │ │
│ join on question_number, set agreement           │ │
└──────────────────────────────────────────────────┘ │
   │                                                  │
   ▼                                                  ▼
┌──────────────────────────────────────────────────────────────┐
│ Crop Figures — crop visual regions per question (Rust)       │
└──────────────────────────────────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────────────────────────────────┐
│ Cache (per stage) + Review UI (rows appear incrementally)    │
└──────────────────────────────────────────────────────────────┘
   │
   ▼
CSV + .audit.json
```

The data flow is **strictly linear** for a given row: every row passes through Validator before reaching Solver. The orchestrator does not fan out Extractor output to Validator and Solver in parallel.

`answer_key_at_end` extractor is a special case — see §6.3.

### 4.1.1 Local triage stage

Runs before rasterization. Implemented in Rust (`src-tauri/src/triage.rs`), produces per-page metadata used by the rasterizer and recorded in audit:

- **Digital vs scanned**: uses Pdfium's text-extraction API to measure characters-per-page. Pages with > 50 chars are `digital`; < 5 chars are `scanned`; in-between is `mixed`. Document-level `pdf_type` derived from the majority.
- **Blank-page detection**: zero rendered content (no text from Pdfium, near-uniform pixel histogram on a low-res preview). Blank pages are skipped from rasterization and recorded in `audit.skipped_pages` with `reason: "blank"`.
- **Skew detection** (scanned pages only): downsamples to 200px wide thumbnail, runs a coarse Hough transform via `imageproc` to find the dominant text-line angle. Pages with |skew| > 1° are flagged for deskew during rasterization.
- **Output**: `Vec<TriagePageInfo>` returned to the orchestrator; informs `rasterize_pdf` parameters.

Triage runs synchronously before the streaming pipeline begins (it's a fast local pass, no LLM, typically <1s for 100 pages). Its results are persisted to a `triage` cache entry so resume doesn't redo it.

Note: this stage **does not** classify the document's MCQ format — that's still the Detector's job (LLM-based, §4.1). Triage is purely about per-page quality and rasterization hints.

### 4.1.2 Document Intelligence stage

Runs **after** rasterization and base64 encoding, **before** batch planning and extraction. Sends every rasterized page to the AI in a single call and returns a `DocumentAnalysisResult` that the rest of the pipeline uses in place of heuristics.

**Why all pages?** The 2-3 sample approach used by the Detector is sufficient to classify the marking format but insufficient to locate the answer key exactly (especially when there are multiple sections with independent answer keys on different pages), identify question ranges per page, or detect cross-page question splits.

**Output fields** (`DocumentAnalysisResult`):

| Field | Type | Description |
|-------|------|-------------|
| `total_questions` | `number \| null` | Total question count across the document |
| `sections` | `DocumentSection[]` | Named sections (label, question range) — empty if no sections |
| `page_map` | `PageMapEntry[]` | Per-page: `content_type`, `section_label`, `question_range_start/end` |
| `answer_key_locations` | `AnswerKeyLocation[]` | Every page containing an answer key, with its section and question range |
| `cross_page_questions` | `CrossPageQuestion[]` | Questions whose stem starts on one page and ends on the next |
| `content_patterns` | `ContentPattern[]` | Groups of questions sharing the same type (mcq, true_false, written, …) |
| `exam_metadata` | object | `title`, `date`, `subject` (all nullable) |
| `layout` | object | `columns` (1–3), `has_math`, `primary_language` |
| `notes` | string | Unusual observations |

**Pipeline integration:**

- `answer_key_locations` replaces the `pickAnswerKeyPages` heuristic (last 5 pages min) for `answer_key_at_end` PDFs — the extractor now receives only the exact pages identified by the analysis. If `answer_key_locations` is empty (analysis returned no results or failed), the heuristic runs as a fallback.
- `page_map[].section_label` is passed to `patchWithAnswerKey` so it can match answer-key entries to body rows using compound keys (`"<section>::<question_number>"`), correctly handling multi-section exams where both sections start at Q1.
- `cross_page_questions` is recorded in audit as a merge hint (full use deferred to v2).
- If the AI call fails for any reason, a warning is recorded in the pipeline trace and all downstream stages fall back to heuristics as if the step had not run. The pipeline never hard-fails on an analysis error.

**Model:** Uses the `analyzer_model` setting (falls back to `primary_model`). Recommended: `gemini-3.5-flash`.

**Implementation:** `src/pipelines/documentAnalyzer.ts` — `runDocumentAnalyzer(args)`.

### 4.2 Streaming mechanics

- Each stage is an async iterator producing into a bounded queue.
- Concurrency per stage is independent: e.g., up to 3 extractor batches and up to 3 solver batches in flight simultaneously.
- A failed batch is isolated — other batches proceed. Failed batches are marked in the UI with a retry button.
- Backpressure: if a downstream queue is full, the upstream stage pauses. v1 default queue size is 50 items per stage (effectively unbounded for typical PDFs).
- Time-to-first-row in Review mode is one extractor batch + one solver batch (not the full PDF).
- The rasterizer writes JPEGs to disk and emits paths (not bytes), so it can produce pages incrementally and downstream stages can begin before rasterization completes for the whole PDF.

### 4.3 Mode toggles

| Mode (MCQ only)        | `extract_marked` | `ai_solve` | Compare? | Detector runs? |
| ---------------------- | ---------------- | ---------- | -------- | -------------- |
| Extract                | true             | false      | —        | yes            |
| Review                 | true             | true       | yes      | yes            |
| Answer from scratch    | false            | true       | —        | no (skipped)   |

For non-MCQ content types (flashcard, qa_pair), only Extract mode exists; the mode picker is hidden.

### 4.4 Page-span question merge rules

When the extractor returns `is_partial=true` for a question on page N:
- Look at page N+1's first extracted question.
- If its `question_number` matches the partial stem's number, concatenate the two `question_text` fields and merge options (continuation usually contains options, stem contains question). Mark merged row `is_partial=false`, add `notes="merged from pages N, N+1"`.
- If numbers don't match, the partial row stays as-is; downstream UI flags it for manual editing.

Implemented in `pipelines/merge.ts` as a windowed pass over the question stream (window size = 1 batch).

### 4.5 Question→page-image association (for Solver)

The Solver works on questions, not pages, but always needs vision. For each question batch (5–10 questions):
- Group questions sent in one solver call by source page where possible.
- Send each question with the page image its **stem** is on.
- If `is_partial=true` (merged or unmerged), send both the stem page and the continuation page.
- Solver call format:
  ```
  [text]: "Solve the following questions. Each question is followed by the image of its source page."
  [text]: "QUESTION 1 (from PAGE 23):"
  [text]: "{question_text} A) {A} B) {B} ..."
  [image]: <page-23.jpg>
  [text]: "QUESTION 2 (from PAGES 24-25, partial):"
  [text]: "..."
  [image]: <page-24.jpg>
  [image]: <page-25.jpg>
  ...
  ```

### 4.6 Detector confidence handling

- Detector returns format + confidence.
- If confidence ≥ 0.6 and not `mixed_or_unclear`: auto-proceed; UI shows the detected format with a "change" link.
- If confidence < 0.6 or `mixed_or_unclear`: pause pipeline, prompt user to pick the format manually.
- "Answer from scratch" mode skips the detector entirely; uses a content-only extractor.

### 4.7 Resume protocol

On run start, the orchestrator constructs the run's `cache_key` (§10) and queries cache for completed batches per stage.

For each stage, in pipeline order:
1. Read cache entries matching `(run_id, stage)` with `status=complete`.
2. Reconstruct the stage's output stream from cached results.
3. Feed downstream stages from the cached output as if it had just been produced — this lets downstream stages also use their own cache or start fresh as appropriate.
4. Resume new work only for batches not present in cache.

A batch is considered consumed downstream only when the dependent downstream batch has its own `status=complete` cache entry. If a downstream stage was interrupted mid-batch, that batch's upstream input is re-emitted from cache so the downstream can re-attempt.

UI feedback on resume: progress bars show cached-vs-fresh counts ("Extractor: 35 batches (28 cached, 7 to run)"). Cached rows render in the Review UI immediately at run start, before any new processing.

Implementation in `lib/resume.ts`; orchestrator calls it once per stage on startup.

### 4.8 Pause and cancel

The Processing UI has two affordances beyond automatic crash recovery:

- **Pause** — stop accepting new batches into any stage; let in-flight batches finish naturally; persist all completed batches to cache. Run state is set to `paused`. The user can resume from the same point. Useful when the user wants to inspect partial results or adjust a setting (mode/model change requires a fresh run because cache_key changes, but the user can pause, export partial, then start fresh).
- **Cancel** — same as pause but mark run state `cancelled`. On next launch with the same `cache_key`, the UI offers "Resume cancelled run?" with two buttons: "Resume" (uses existing cache) or "Start fresh" (purges cache for this key, restarts from rasterization). Cancel never deletes cache — that's the user's explicit "Clear cache" action.

State transitions: `running → paused → running` (resume), `running → cancelled` (terminal until user chooses), `running → completed`, `running → crashed` (implicit, on app close mid-run; treated like `paused` on next launch).

### 4.9 Batch resilience

**Output truncation auto-split.** Models have output token limits. A dense batch of 10 pages may produce a response that truncates mid-JSON; zod validation fails. Behavior:
1. On parse failure that matches the truncation pattern (unclosed object/array, no closing brace), split the batch in half and retry both halves as independent batches.
2. After two halving retries on the same input (i.e., down to ~2-3 pages per batch), drop to 1 page per batch.
3. If 1-page-per-batch also truncates, mark the page failed and surface "page too dense for current model — try a different model or simpler schema" in the UI.
4. Auto-split decisions are recorded in audit for cost transparency.

**Request payload pre-check.** Before sending, `modelClient.ts` measures the serialized payload size (text + base64-encoded images). If approaching the model's request size cap (configurable per model, default ~20 MB), `batching.ts` sends fewer images per batch for that call and emits a warning. JPEGs are already re-encoded at q=82 / max 2048px long edge by the rasterizer; further reduction is an explicit downgrade and is logged.

### 4.10 Figure & table cropping

To handle visual elements (diagrams, charts, graphs, illustrations, and complex tables) that cannot be faithfully represented as flat text:

- **Detection**: The extractor schema includes an optional `figures` array on every row containing bounding box coordinates (`ymin`, `xmin`, `ymax`, `xmax` on a 0–1000 scale), a concise explanation, and a kind label (`figure`, `diagram`, `chart`, `table`, `illustration`). The model detects these visual regions relative to the page coordinates.
- **Cropping**: A dedicated `crop_figures` phase is executed after validator + merge, before the rows are persisted. Coordinates are translated into actual pixels with a `1.5%` boundary padding margin and clamped to image dimensions. Degenerate regions (under `0.5%` or over `95%` page area) are automatically filtered out.
- **Persistence**: Cropped JPEG files are written to `%APPDATA%/csvconv/figures/<cache_key>/<job_id>.jpg` and their absolute paths are mapped onto the row's `figures` field.
- **Review UI**: Previews render figure thumbnails at `44x44px` min using Tauri's `convertFileSrc` (enabled via whitelisting scopes in `tauri.conf.json`). Clicking a thumbnail opens a centered lightbox showing the full cropped image and visual metadata. Failed crops degrade gracefully showing a warning indicator.

## 5. Schema system

### 5.1 Schema definition

```ts
type SchemaVersion = 1;  // bumped when field structure changes; older saves auto-migrate

type ContentType = "mcq" | "flashcard" | "qa_pair";

type FieldType = "string" | "multiline_string" | "enum" | "number" | "boolean";

type SemanticRole =
  // shared roles
  | "page_number" | "is_partial"
  // mcq roles
  | "question_text" | "question_number"
  | "option_A" | "option_B" | "option_C" | "option_D" | "option_E"
  | "options_concatenated" | "correct_answer" | "marking_style"
  // marking_style enum: "circled" | "ticked" | "underlined" | "crossed"
  //   | "highlighted" | "boxed" | "arrow" | "x_through_wrong" | "other" | "none"
  | "mcq_type"
  // mcq_type enum: "best_answer" | "except_negative" | "all_of_above"
  //   | "matching" | "standard" — inferred from the question wording
  //   ("Which of the following is NOT..." → except_negative;
  //    "All of the above" present as an option → all_of_above;
  //    matching columns layout → matching; otherwise → standard or best_answer)
  // solver roles (mcq only, ai_solve mode)
  | "ai_answer" | "ai_explanation" | "ai_confidence"
  | "agreement" | "disagreement_reason"
  // flashcard roles
  | "term" | "definition" | "example"
  // qa_pair roles
  | "question" | "answer"
  | null;  // custom field — extracted via description only

interface FieldDefinition {
  name: string;
  type: FieldType;
  enum_values?: string[];
  semantic_role: SemanticRole;
  description: string;
  required: boolean;
  template?: string;
}

interface Schema {
  schema_version: SchemaVersion;
  name: string;
  content_type: ContentType;
  fields: FieldDefinition[];
}
```

`content_type` is the **top-level routing decision** — it selects which extractor pipeline runs, which semantic roles are valid, and whether the format detector and solver are applicable.

### 5.2 Content type registry

| `content_type` | Extractors                                              | Detector? | Solver? | Modes              |
| -------------- | ------------------------------------------------------- | --------- | ------- | ------------------ |
| `mcq`          | mcq_inlineMarked, mcq_writtenAnswer, mcq_answerKeyAtEnd | yes       | yes     | Extract/Review/Answer |
| `flashcard`    | flashcard                                               | no        | no      | Extract only       |
| `qa_pair`      | qaPair                                                  | no        | no      | Extract only       |

UI: schema editor's `content_type` selector at the top changes which semantic roles appear in the field-role dropdown and which presets show in the preset menu.

### 5.3 Semantic roles

Fields with a `semantic_role` valid for the schema's `content_type` get app-controlled extraction instructions. Fields with `semantic_role: null` are extracted purely from the user's `description`. Selecting a role from a different content_type produces a validation error in the editor.

Audit fields (`confidence`, `page_number`, `marking_style`, `is_partial`, `notes`, and solver audit fields when applicable) are **always added by the app** to canonical extraction output and live in the sidecar `.audit.json`.

### 5.4 Shipped presets

| Preset                          | content_type | Mode default | Notes                                       |
| ------------------------------- | ------------ | ------------ | ------------------------------------------- |
| MCQ Standard                    | mcq          | Extract      | question_number, question_text, options, correct_answer |
| MCQ for Anki                    | mcq          | Extract      | Front (concat), Back (answer)               |
| MCQ with Topic & Difficulty     | mcq          | Extract      | Adds custom inference fields                |
| MCQ Review                      | mcq          | Review       | correct_answer, ai_answer, agreement        |
| MCQ AI Answer Key               | mcq          | Answer       | ai_answer + explanation                     |
| Flashcard (Term/Definition)     | flashcard    | Extract      | term, definition, optional example          |
| Q&A Pair                        | qa_pair      | Extract      | question, answer                            |

Selecting a preset overwrites all fields and sets the recommended mode (user can change after).

### 5.5 Schema hash (canonical form)

Cache invalidation correctness depends on `schema_hash` changing if and only if the schema would change the prompt or response. Canonical form:

1. Build a canonical object:
   - `schema_version`: included.
   - `content_type`: included.
   - `fields`: array preserved in user-defined order (order changes the prompt block order and column order).
   - For each field: `name`, `type`, `enum_values` (sorted within the array because order of enum values doesn't affect meaning), `semantic_role`, `description`, `required`, `template` — all included.
   - `name` (schema name): excluded — purely cosmetic.
   - UI-only state (drag handles, focus, save status): excluded.
2. Serialize via JSON.stringify with sorted top-level keys (but inner field array order preserved).
3. `schema_hash = sha256(canonical_string)`.

Implementation lives in `schema/hash.ts` with a goldens test fixture so future changes to hashing logic are caught (cache misses on existing PDFs after a refactor would be silently wasteful).

### 5.6 Schema editing during a run

While a run is active (any stage has in-flight batches), the schema selector and editor are locked in the UI. The user can still review/edit completed rows. To change schema, the user must finish or cancel the current run. This avoids the impossible state of partial results split across two schemas.

The mode picker also resets to `Extract` when the user changes `content_type` away from `mcq` (since Review/Answer aren't applicable to non-MCQ types).

### 5.7 Visual editor

```
SchemaEditor
├── SchemaNameInput
├── ContentTypeSelect          ← top-level routing
├── PresetMenu (filtered by content_type)
├── FieldList
│   └── FieldRow × N
│       ├── DragHandle
│       ├── NameInput
│       ├── TypeSelect
│       ├── EnumValuesInput (conditional)
│       ├── SemanticRoleSelect (options filtered by content_type)
│       ├── DescriptionTextarea
│       ├── RequiredCheckbox
│       └── DeleteButton
├── AddFieldButton
└── ActionBar
    ├── PreviewPromptButton
    ├── PreviewJsonSchemaButton
    ├── TestOnOnePageButton
    └── SaveSchemaButton
```

### 5.8 Schema persistence

Schemas are saved as JSON files in `%APPDATA%/csvconv/schemas/<sanitized_name>.json` (one schema per file, filename derived from `schema.name` with non-alphanumerics replaced by `_`). The file content is the full `Schema` object including `schema_version`. `load_schemas()` lists and reads them; rename = save + delete old.

Schemas with a `schema_version` lower than the current version run through a migration step on load (handled in `schema/types.ts`) before being returned to the UI.

### 5.9 Test-on-1-page

When the user clicks "Test on 1 page" in the schema editor:

1. UI prompts for a PDF + page number (or uses the most-recently-opened PDF).
2. The page is rasterized (single page only).
3. UI prompts the user to pick a format for the test, since the detector isn't run:
   - For `mcq` schemas: dropdown with `inline_marked` (default), `written_answer`, `answer_key_at_end`, `no_answers`. Pick determines the extractor variant.
   - For `flashcard` / `qa_pair` schemas: no prompt — only one extractor variant.
4. Test runs the chosen extractor on the single page with the user's schema. Bypasses cache (always fresh). Bypasses validator and solver.
5. Result displayed alongside the page image so the user can verify field-by-field. Cost is shown (typically <$0.005).

## 6. Prompts

### 6.1 Document Intelligence (all pages)

Runs on every rasterized page. Returns the structural map described in §4.1.2. Implemented in `src/pipelines/prompts.ts` as `DOCUMENT_ANALYSIS_PROMPT`.

```
You are a document-structure analyst. You receive every page of an exam PDF as images.
Your job is to produce a complete structural map of the document.

For EVERY page, classify it and record:
- content_type: "questions" | "answer_key" | "instructions" | "blank" | "mixed"
- section_label: the section name if this page belongs to a named section (e.g. "Section A"),
  or null if there are no named sections or this page has none
- question_range_start / question_range_end: the first and last question number on this page
  (null if no questions)

Also report at the document level:
- total_questions: total number of questions in the entire document (null if uncertain)
- sections: named sections with their question ranges (empty array if no sections)
- answer_key_locations: EVERY page containing an answer key. For multi-section exams where
  each section has its own key, list each as a separate entry with its section_label and range.
- cross_page_questions: questions whose stem starts on one page and ends on the next
- content_patterns: contiguous groups of questions sharing the same format type
  (e.g., Q1-10 are mcq, Q11-12 are true_false)
- exam_metadata: title, date, subject — null for any you cannot read
- layout: columns (1/2/3), has_math, primary_language (ISO 639-1)
- notes: any unusual observations

IMPORTANT:
- If multiple answer keys exist for different sections, each gets its own entry in
  answer_key_locations with a non-null section_label.
- Preserve question_number strings exactly as printed (e.g., "1", "23a", "Q5").
- Be precise about question ranges — count carefully rather than estimating.
- Return strict JSON.
```

### 6.2 MCQ Detector

Runs only when `content_type=mcq` and `mode ≠ "Answer from scratch"`.

```
You are analyzing sample pages from an MCQ exam PDF to identify how correct
answers are marked.

Classify the format as exactly one of:
- inline_marked: options A/B/C/D shown on same page as question, one visually marked.
- written_answer: a letter or word printed/written near each question indicates the answer.
- answer_key_at_end: questions in body, separate answer key on later pages.
- bubble_sheet: separate OMR sheet with filled bubbles.
- no_answers: no answer marks visible.
- mixed_or_unclear: multiple formats, or you cannot confidently determine.

Also report: confidence (0-1), columns (1-3), has_math, primary_language (ISO 639-1),
questions_per_page_estimate, notes.

Be conservative: prefer mixed_or_unclear if ambiguous.
Return strict JSON.
```

### 6.3 MCQ inline-marked extractor

Fixed system prompt + dynamic per-field block from user's schema.

```
You are extracting multiple-choice questions from exam pages where the correct
answer is visually marked on the page (circled, ticked, underlined, highlighted,
crossed, or boxed).

For each page, identify EVERY distinct MCQ and extract the fields listed below.

CRITICAL RULES:
1. DO NOT guess the answer based on which option seems factually correct.
   ONLY report explicit visual marks on the page.
2. If no mark is visible, set the answer field to null and confidence to 0.
3. If multiple options are marked, pick the most deliberate-looking one,
   set multiple_marks_detected=true, and lower confidence.
   Recognized marking_style values: circled, ticked, underlined, crossed,
   highlighted, boxed, arrow (arrow pointing to an option),
   x_through_wrong (X through wrong answers — surviving option is correct),
   other (any other distinct mark; describe in notes), none.
4. Read multi-column pages top-to-bottom within each column, left column first.
5. Preserve math notation with LaTeX delimiters ($x^2 + 1$).
6. If a question spans a page break, extract it on the page where the stem
   starts, set is_partial=true.
7. Each image is labeled "PAGE N:" — use that as page_number.
8. confidence reflects how certain you are about the visual mark identification
   specifically — NOT how readable the question is or how confident you are in
   the question text. A clear question with an ambiguous mark gets LOW confidence.
9. If a page contains no MCQ questions (blank, cover, instructions, divider,
   table of contents), return rows=[] for that page and set
   layout_notes to a short reason (e.g., "blank page", "instructions only").
10. For each question, also infer mcq_type from the question wording / layout:
    "best_answer" (standard "pick the best option"),
    "except_negative" (e.g., "Which of the following is NOT..."),
    "all_of_above" (an "all of the above" option is present),
    "matching" (matching-columns layout),
    "standard" (default if none of the above clearly applies).
11. For each question, populate source_snippet with the verbatim text you
    transcribed from the question's region of the page (including question
    text and surrounding option text). Cap at 2000 characters; truncate with
    "..." if longer. This stays in audit only, never in the user CSV.
```

App-managed canonical fields always extracted alongside the user's declared fields:
`confidence, marking_style, mcq_type, multiple_marks_detected, is_partial, notes, source_snippet`.

`source_snippet` is verbatim text from the question's region of the page — invaluable for debugging "why did the AI structure this weirdly" without re-running. Stored in audit only.

`mcq_type` lets downstream consumers handle "except" questions differently from "best answer" questions (Anki cards for negation questions, for example, benefit from explicit "select WRONG answer" framing).

### 6.4 MCQ written-answer / answer-key-at-end extractors

Same skeleton as 6.3 with format-specific variations:
- **written_answer**: "the answer is indicated by a handwritten or printed letter near each question stem" instead of visual marks.
- **answer_key_at_end**: runs in two passes that interact specially with the streaming model.

#### answer_key_at_end streaming behavior

This format breaks the simple linear stream because `correct_answer` for body-page questions lives on a separate (typically end-of-PDF) page. v1 approach:

1. Body-page rows are extracted and emitted with `correct_answer=null` and a per-row flag `awaiting_answer_key=true`. They flow through Validator and into the Review UI immediately so the user sees structure.
2. The orchestrator determines which pages contain the answer key using `answer_key_locations` from the Document Intelligence step (§4.1.2). If that result is empty or unavailable, it falls back to the heuristic (last 5% or last 5 pages, whichever is more, capped at 20).
3. An answer-key extractor runs on those exact pages. The answer key prompt instructs the model to include a `section` field (e.g., `"A"`, `"Section B"`) on every entry when the key covers multiple sections, so answers from sections whose question numbering overlaps (both start at Q1) can be distinguished.
4. When the key map is ready, a patch pass updates each pending row: sets `correct_answer`, clears `awaiting_answer_key`, recomputes `needs_review`. The patch uses compound keys (`"<section>::<question_number>"`) when sections are present, derived from the `page_map[].section_label` values for each body page. Falls back to bare `question_number` matching when no sections exist.
5. Patched rows update in place in the Review UI (using the row identity tuple from §8).
6. If the key extractor returns an answer for a `question_number` that wasn't extracted from the body, record it in `audit.unmatched_key_entries` for user review.
7. If a body-page row has `question_number` not present in the key map after the key pass completes, leave `correct_answer=null` and set `needs_review=true` with notes "no entry in answer key".
8. Solver (Review/Answer modes) and Compare wait for the key patch to complete on a row before consuming it. This means Time-to-First-Solved-Row in Review mode for `answer_key_at_end` PDFs is roughly the same as for `inline_marked` (since solver doesn't need the marked answer to do its work — it can run on body rows immediately). Compare just waits for the patch.

The "answer key processing" stage is its own pipeline node with its own progress indicator in the Processing UI.

#### Multi-section answer key handling

Exams that split questions into independent sections (e.g., "Section A: Q1–25, Section B: Q1–20") each with their own answer key present a matching challenge: both sections use overlapping question numbers. The answer key parser is instructed to emit a `section` field per entry; `patchWithAnswerKey` then builds compound keys (`"Section A::1"`, `"Section B::1"`) and looks up body rows by their page's section label from the document analysis page map. If no section labels are found, the logic degrades gracefully to bare question_number matching (single-section behavior).

Implementation: `AnswerKeyEntrySchema.section` (optional string) in `mcq_answerKeyAtEnd.ts`; `patchWithAnswerKey(body, key, pageMap)` accepts the page map as a third argument.

### 6.5 Flashcard extractor

```
You are extracting flashcard-style content from study material pages.
Each card has a TERM (short, often bolded or in a header position) and a
DEFINITION (the explanatory text immediately following the term).

For each page, identify every term/definition pair and extract:
- term: the term being defined
- definition: the explanation
- example (optional): if an example sentence or illustration is provided

Plus the fields the user has defined (listed below). Plus audit fields:
confidence, is_partial (if definition continues on next page), notes.

Read multi-column pages top-to-bottom within each column.

If a page contains no term/definition pairs (blank, cover, glossary header,
section divider), return rows=[] and set layout_notes to a short reason.

confidence reflects certainty in the term/definition pairing — a clear term
matched to an ambiguous or wrong-feeling definition gets LOW confidence.

Return strict JSON.
```

### 6.6 Q&A pair extractor

```
You are extracting question-and-answer pairs from pages of study material
(e.g., FAQ documents, tutorial Q&A sections).

For each page, identify every Q&A pair and extract:
- question: the question text
- answer: the corresponding answer text

Plus the user's declared fields. Plus audit fields (confidence, is_partial, notes).

If a page contains no Q&A pairs (blank, cover, narrative-only text without
explicit Q/A structure), return rows=[] and set layout_notes to a short reason.

confidence reflects certainty in the Q→A pairing being correct.

Return strict JSON.
```

### 6.7 Solver (MCQ Review / Answer modes)

Sent per batch of 5–10 questions, grouped by source page where possible. Always includes the page image(s) per question (see §4.5).

```
You are independently answering multiple-choice exam questions. For each question
provided, read the question and options carefully (including any figures visible
in the accompanying page image), reason about each option, and choose one answer.

Rules:
- Think step by step about why each option could be correct or incorrect before
  committing to one letter.
- Return exactly one letter (A/B/C/D/E). Do NOT hedge by listing multiple.
- If the question is genuinely unanswerable from the information available,
  return ai_answer=null with an explanation of why.
- ai_confidence reflects YOUR certainty in YOUR answer, not how hard the question
  is. A question can be hard but you can still be highly confident in your reasoning.
- Your explanation should be 1-3 sentences focused on WHY your answer is correct
  and (briefly) why the strongest distractor is wrong.

Return per question: { question_number, ai_answer, ai_explanation, ai_confidence }.
```

The Compare stage (Review mode only) joins solver output with extractor output on `question_number` and sets:
- `agreement = (correct_answer === ai_answer)` when both are non-null.
- `agreement = null` when either side is null (cannot compute). Specifically:
  - `ai_answer = null` (AI declined to answer): row is rendered with an "AI declined" icon in the Review UI (distinct from agreement/disagreement). `disagreement_reason` records the solver's explanation of why it declined.
  - `correct_answer = null` (no mark detected on the page): row is rendered with a "no marked answer" icon. `agreement` stays null; the AI answer is shown but no comparison is made.
- `disagreement_reason = ai_explanation` when `agreement === false`.

Review UI filter chips: `All | Agreements | Disagreements | AI declined | No marked answer | Needs review`. Stats summary at top shows counts across all categories (e.g., "47 agree · 3 disagree · 2 AI declined · 1 no marked answer").

Convention: marked answer is treated as truth; AI disagreements are surfaced as **the AI's findings to inspect**, not as proof the marked answer is wrong.

### 6.8 Validator (cross-model + disagreement)

The v1 validator does **not** rely on self-reported confidence alone (Gemini confidence is poorly calibrated). Instead:

1. **Trigger**: any row with `confidence < 0.75`. (No bottom-decile sampling — it adds cost without clear benefit when batch confidences are tight. Sampling-style "always validate some rows" is an opt-in v2 setting if needed.)
2. **Cross-model when available**: if both supported models are configured across the run's stages, validator runs the extraction with the **second** model. If the two extractions disagree on any semantic_role field, flag `needs_review=true` and record both candidates in audit under `validator_candidates`.
3. **Single-model fallback**: if only one model is configured, validator re-extracts with a stricter prompt phrasing (the prompt from §6.2 plus an additional rule "double-check the marked answer letter") and flags disagreement between the two attempts.
4. **Per-field re-extraction**: the validator only re-extracts the low-confidence fields, not whole rows — saves output tokens.
5. **Inline filter behavior**: the validator runs synchronously in the stream — a row enters the validator and either passes through unchanged (high confidence) or is corrected and then emitted downstream. Solver always receives the post-validator row.

Validator prompt (cross-model, single field):

```
You previously extracted question {n} from this page. Another model independently
extracted: {other_model_result}. Look very carefully at this page and re-extract
ONLY question {n}. Pay attention to:
- What visual mark (if any) appears near that question?
- Multiple competing marks? Which looks most deliberate?
- Is the question complete or partial?

Return JSON for this single question's fields, same schema as before.
```

## 7. Response schemas

Built dynamically from the user's `Schema` + canonical audit fields + content-type-specific required roles. Pseudo-code in TS:

```ts
function buildResponseSchema(userSchema: Schema): JsonSchema {
  const userFields = buildUserFieldsSchema(userSchema.fields);
  const audit = canonicalAuditFields(userSchema.content_type);
  return {
    type: "object",
    properties: {
      pages: {
        type: "array",
        items: {
          type: "object",
          properties: {
            page_number: { type: "integer" },
            layout_notes: { type: "string" },
            rows: {  // generic name (was "questions"); content type-agnostic
              type: "array",
              items: {
                type: "object",
                properties: { ...userFields, ...audit },
                required: requiredFields(userSchema, audit),
              },
            },
          },
        },
      },
    },
  };
}
```

## 8. CSV output

- **Primary CSV** uses only the user's declared fields, in the order defined.
- **Sidecar `<pdf-name>.audit.json`** contains:
  - canonical extraction for every row
  - row identity: `{ run_id, page_number, row_index_within_page }` — stable primary key for UI updates and re-runs
  - per-row `needs_review` (extraction uncertainty) — **distinct** from `ai_needs_review` (solver uncertainty). Both are per-row flags in v1; per-field granularity is v2.
  - both candidate values when validator cross-check disagreed
  - solver output (ai_answer, ai_explanation, ai_confidence) when `ai_solve` is on
  - agreement / disagreement_reason when in Review mode
  - `user_edited: boolean` per row: true if the user edited any field in the Review UI. When true, the original extracted values are preserved in audit under `original_extracted: { fieldName: value, ... }`. Editing any field on a row clears **both** `needs_review` and `ai_needs_review` for the whole row (the user is now the source of truth for that row). Per-field clearing is a v2 enhancement.
  - per-row `auto_split_from`: if the batch was auto-split due to truncation (§4.9), records the original batch index for traceability
  - detector output (format, layout)
  - **triage output**: top-level `triage` object with `pdf_type` (digital/scanned/mixed), per-page array `[{page_number, is_blank, page_type, text_density, skew_angle_deg, deskewed}]`. Blank pages are also referenced from `skipped_pages`.
  - **skipped pages**: a top-level `skipped_pages` array with entries `{ page_number, reason, layout_notes }` for pages that returned 0 rows. `reason` ∈ {"blank" (from triage), "cover", "instructions", "table_of_contents", "no_rows_extracted", ...}.
  - per-row **`source_snippet`**: verbatim text the model transcribed from the question's region of the page (max 2000 chars). Useful for debugging structure failures without re-running.
  - run metadata: mode, content_type, models per stage, DPI, batch sizes, schema_hash, timestamps, token usage, cost, **paid_tier_acknowledged** (boolean — was the privacy warning shown and dismissed in paid-tier mode)
- Ambiguous rows are included with the relevant `needs_review` / `ai_needs_review` flags. The Review UI shows these as two distinct row states (different icons/colors), not collapsed into one.
- Review UI populates rows incrementally as they finish each stage; user can begin editing before the run completes.

### 8.1 Review UI row ordering

Rows are always displayed in `(page_number ASC, row_index_within_page ASC)` order, regardless of which batches finish in which order. While a run is in progress:
- Pages whose extraction hasn't completed show a placeholder skeleton row with a loading state, so the user can see the eventual position of pending rows.
- Solver-pending rows show a "solving…" badge in the AI columns until those values arrive.
- Skipped pages are rendered as a collapsible group between adjacent page sections so the user can sanity-check what was dropped.

### 8.2 Review UI performance & layout

- **Lazy image loading**: page thumbnails use `loading="lazy"` on `<img>` tags so only visible pages load their JPEGs. For runs with 500+ rows, the table is virtualized (e.g., react-virtual) so only visible rows are rendered.
- **Responsive layout**: at viewport widths ≥ 1000px, the Review screen is two-column (page image on the left, editable row table on the right). Below 1000px, the layout collapses to tabs ("Page" / "Rows") so neither side is squeezed unusably.

### 8.3 Re-export

After CSV export, the run remains in cache. A "Re-export" action in run history regenerates the CSV from cached `rows.canonical_json` using the current schema — this means changing the schema (or applying a different shipped preset) and re-exporting **doesn't** hit the API again, as long as all required canonical fields are still present. If the new schema requires fields that weren't extracted in the cached run, the user is offered a partial re-run that fetches only the missing fields.

## 9. Settings & defaults

| Setting                  | Default                       | Notes                                                  |
| ------------------------ | ----------------------------- | ------------------------------------------------------ |
| Google AI Studio API key | (none — required)             | Stored in OS keychain via `keyring`. Setup flow shows a privacy warning before key entry (§9.2). |
| Primary model            | (none — user must pick)       | One of the supported models (§9.1); applied to all stages by default |
| Per-stage model override | inherit from primary          | Override for detector / **analyzer** / extractor / validator / solver |
| Validator cross-model    | Auto                          | If both models configured, validator uses the non-primary model. Otherwise falls back to single-model re-prompt. |
| Rasterization DPI        | 300                           | User prioritized accuracy                              |
| Pages per batch          | 10                            | User-tunable                                           |
| Parallel extractor batches | 3 (model-aware cap)         | Honors per-model RPM; reduces if 429s are seen         |
| Parallel solver batches  | 3 (model-aware cap)           | Independent of extractor concurrency                   |
| Confidence threshold     | 0.75                          | Below this → `needs_review=true`                       |
| Validator re-pass        | Enabled                       |                                                        |
| Cache location           | OS app data dir               | `%APPDATA%/csvconv` on Windows                         |
| Mode (MCQ only)          | Extract                       | Extract / Review / Answer from scratch                 |
| Solver vision            | Always on                     | Locked in                                              |
| Solver batch size        | 8                             |                                                        |
| AI confidence threshold  | 0.75                          | Below this → `ai_needs_review=true` in audit           |

### 9.1 Supported models

Both available via Google AI Studio API and accessed through `@google/genai`. User's single API key works for both.

| Model ID                  | Vision | Recommended for                          |
| ------------------------- | ------ | ---------------------------------------- |
| `gemini-3.1-flash-lite`   | yes    | Detector / Extractor / Solver / Validator |
| `gemma-4-31B-it`          | yes    | Detector / Extractor / Solver / Validator |
| `gemini-3.5-flash`        | yes    | **Document Intelligence (Analyzer)** — capable model for full-document structural analysis |

No default model — user must pick a primary per run. "Advanced" panel allows per-stage overrides including the new `analyzer_model` slot. Cost preview updates live, broken down per stage. New models added by registering them in `lib/models.ts` (id, label, vision, pricing) and `lib/modelClient.ts` (concurrency entry).

If the user picks both models across stages (e.g., one for primary, the other as a stage override), the validator automatically uses the non-primary model for cross-check (§6.7). A UI hint surfaces this: "Configure both models in per-stage settings to enable cross-model validation."

### 9.2 Privacy warning at API key entry

Before the user pastes their API key, the Settings page surfaces a clear warning:

> ⚠️ **Privacy notice**
>
> On the **free tier** of the Google AI Studio API, Google may use your API
> inputs and outputs to improve their models. If you're processing copyrighted
> exam content, proprietary materials, or anything sensitive, use a **paid
> tier** key instead — paid-tier traffic is excluded from training.
>
> [Learn more about Google's data policy →]  [Use a paid-tier key]  [Continue with free tier]

The warning is dismissible per-key (acknowledgement stored alongside the key in the keychain entry as metadata). It re-appears if the user enters a new key.

### 9.3 Cost preview

Cost depends on factors not known until processing (questions per page, validator firing rate, auto-split frequency). The UI shows a **range**, not a single number:

```
Estimated cost: $0.04 – $0.12
  Extractor (low–high):      $0.02 – $0.06   based on 100 pages × 5-12 Qs/page
  Validator re-extractions:  $0.00 – $0.02   assumes 0-30% of rows flagged
  Solver (Review/Answer):    $0.02 – $0.04   based on est. question count
```

- **Low end** assumes few questions per page, no validator fires, no auto-splits.
- **High end** assumes max question density, validator fires on 30% of rows, conservative auto-split estimate.
- Updates live as the user changes model overrides, mode, schema, or PDF.
- After the run, audit JSON records actual token usage and cost; UI shows the variance from estimate (calibrates future estimates).

## 10. Caching & resume

Cache key is intentionally rich so re-runs with different settings don't replay stale results:

```
cache_key = sha256(
  pdf_sha256,
  schema_hash,            // stable hash of user schema (fields, types, content_type)
  page_range,
  mode,
  per_stage_models,       // detector, analyzer, extractor, validator, solver model IDs
  dpi,
  batch_size
)
```

Changing any of these invalidates affected entries automatically.

SQLite tables:
- `pdfs(sha256, path, page_count, created_at)`
- `runs(run_id, pdf_sha256, cache_key, schema_hash, mode, content_type, confirmed_format, settings_json, state, started_at, finished_at, token_usage, cost)` — `state` ∈ {`running`, `paused`, `cancelled`, `completed`, `crashed`}. `confirmed_format` records the format the user accepted from the detector or chose manually, so resume skips the detector confirmation step.
- `batches(run_id, stage, batch_index, status, raw_response, error, completed_at)` — `stage` ∈ {`detector`, `extractor`, `validator`, `solver`, `compare`, `merge`, `answer_key`, `answer_key_patch`}
- `rows(run_id, page_number, row_index_within_page, canonical_json, needs_review, ai_needs_review, user_edited, merged_from_pages, awaiting_answer_key, PRIMARY KEY(run_id, page_number, row_index_within_page))` — `merged_from_pages` is a JSON array of page numbers the row was merged across (e.g., `[23, 24]`; empty array for unmerged rows). `awaiting_answer_key` is true while an `answer_key_at_end` row's `correct_answer` hasn't been patched yet.

On reopen: hash the PDF, look up by `cache_key`, resume from last successful batch per stage. Stages can resume independently (e.g., extraction complete but solver was interrupted). If `runs.state` is `cancelled`, UI offers Resume / Start fresh (§4.8) before continuing.

"Clear cache" button in settings. Per-run "purge this run's cache" in run history.

## 11. Error handling

| Failure                            | Behavior                                                      |
| ---------------------------------- | ------------------------------------------------------------- |
| Invalid API key                    | Block; surface clear error on settings page                   |
| Rate limit (429)                   | Exponential backoff in client; per-model concurrency reduces; UI shows "throttled"; resumes automatically |
| Non-conforming JSON response       | Validate with zod; retry once with stricter prompt; on second failure mark batch failed, surface in UI with full raw response for debugging |
| Output truncation (mid-JSON)       | Auto-split batch in half and retry both halves; cap at 3 split levels (10 → 5 → 2-3 → 1 page per batch); if 1-page batch still truncates, mark page failed with "page too dense" message (§4.9) |
| Request payload too large          | `modelClient.ts` pre-checks serialized size before sending; if approaching the model's cap, the batch is sent with fewer images. Logged in audit. (§4.9) |
| Vision input rejected by model     | Mark batch failed with specific error; suggest switching model in UI |
| Pdfium can't render a page         | Skip page, log to audit, surface in UI                        |
| Encrypted PDF                      | Rasterizer detects the password requirement and returns a `PasswordRequired` error; UI prompts for password and retries via `rasterize_pdf(..., password)` |
| SQLite write failure               | Continue in memory; warn user; offer cache directory change   |
| User closes app mid-run            | All completed batches survive in cache; resume on next launch via the resume protocol (§4.7) |
| Streaming queue overflow           | Pause upstream (backpressure); log warning                    |
| Failed batch with retry available  | UI shows "retry" button per batch in Processing view          |
| Validator cross-model disagreement | Both candidates kept in audit, row flagged `needs_review`     |
| Zero rows on a page                | Recorded in `audit.skipped_pages` with reason; rendered as a collapsible group in Review UI; not treated as an error |
| User attempts schema edit mid-run  | Schema selector and editor are disabled until the run finishes or is cancelled (§5.6) |
| User pauses a run                  | Stop emitting new batches; in-flight batches finish; state set to `paused`; can be resumed (§4.8) |
| User cancels a run                 | Same as pause but state is `cancelled`; on next launch with same cache_key, UI offers Resume / Start fresh (§4.8) |

## 12. Build order

(Step 0 — verifying Gemma via `@google/genai` — removed: confirmed working by user.)

1. Tauri scaffold + Vite + React + TS, smoke test it runs
2. PDF triage + rasterization (`triage_pdf` + `rasterize_pdf`; digital/scanned detection, blank-page filter, deskew on scanned-skewed pages; JPEGs in staging dir; q=82, max 2048 px; password support)
3. Settings page: API key in keychain (with privacy warning at first entry §9.2), model picker, DPI/batch/concurrency inputs
4. Model client wrapper (`@google/genai` + per-model RPM tracking + request-size pre-check + zod validation + retries + auto-split-on-truncation in `batching.ts`)
5. Streaming queue primitives (`lib/queues.ts`) + orchestrator skeleton + resume protocol (`lib/resume.ts`)
6. Schema editor UI with `content_type` selector, role filtering, preset library, `schema_hash` (with goldens test)
7. **Document Intelligence pipeline** (`documentAnalyzer.ts` + `analyzer_model` setting) — full-page vision analysis producing structural map (page types, question ranges, answer-key locations, sections, cross-page questions, exam metadata)
8. MCQ detector pipeline + UI confirmation step (low-confidence prompts user)
9. Mode picker UI (conditional on content_type=mcq) with per-stage cost preview (ranges)
10. MCQ inline-marked extractor with dynamic prompt builder
11. Merge stage (page-span stitching)
12. MCQ written-answer extractor
13. MCQ answer-key-at-end extractor (two-phase + join, now using document analysis for exact answer-key page locations and section labels for compound-key matching in multi-section exams)
14. Validator with cross-model disagreement check (fallback to single-model re-prompt)
15. Solver pipeline (vision-enabled, batched by source page, MCQ only)
16. Compare logic (Review mode)
17. SQLite cache (rich key, includes `analyzer_model`) with stage-independent resume
18. Streaming Review UI (incremental population in `(page_number, row_index)` order with skeleton rows; distinct needs_review vs ai_needs_review states; per-row re-solve; per-batch retry; user-edit tracking; skipped-pages collapsible group)
19. CSV + audit JSON export
20. Flashcard and Q&A pair extractors (proves content-type extensibility)
21. Staging cleanup on run finalize / app start
22. Tauri Windows packaging (`.exe` build) — including code signing setup (acquire cert OR document workaround for unsigned builds)

## 13. Deferred (v2+)

- Bubble-sheet OMR pipeline
- Batch folder processing
- Additional content types (matching questions, fill-in-the-blank, free-response with rubric)
- Mac/Linux builds (after Windows is solid)
- Telemetry, auto-updates
- Schema sharing / community preset library
- Self-tuning concurrency from RPM observation
- Auto-detect figure presence per question → downgrade solver to text-only when no figure
- Audit JSONL format for very large runs (one row per line, streamable/diffable) — current JSON is loaded whole
- Per-content-type model preferences (e.g., remember that Gemma works better for flashcards) saved as named presets
- **`media_resolution` parameter** — Gemini 3+ lets per-page resolution be set to low/med/high. v2 would use triage output to pick per page (text-only → low, figure-heavy → high). Real cost savings, especially with the cost-preview-as-ranges UI in §9.3.
- **Native PDF text extraction for digital PDFs** — Gemini 3+ extracts text from digital PDFs without charging tokens. v2 would have a "Digital fast path" mode that sends the native PDF instead of rasterized images when triage classifies the document as digital. ~6x cost cut for digital PDFs. v1 keeps always-rasterize as the simpler, more consistent path.
- **QTI XML export** — industry-standard exam content format. Add as an export option alongside CSV for LMS compatibility (Moodle, Canvas, Blackboard, etc.).

## 14. Open items

- Confirm latest published price tables and per-model request-size caps for `gemini-3.1-flash-lite` and `gemma-4-31B-it`.
- Whether to allow per-field overrides of `confidence_threshold`.
- Whether to expose "test on N pages" instead of just 1 page in the schema editor.
- Streaming queue size tuning (default 50 may be too aggressive or too small in practice).
- Large-PDF virtualization in the Review UI (table virtualization once row count exceeds, say, 500).
- Keyboard-driven Review UI for power users (arrow keys to navigate flagged rows).
- Whether per-stage model overrides should be saved as part of a named "preset" (e.g., "fast extract + slow solve").
- Windows code signing certificate procurement (cost / who acquires).
- Whether to add a "Test on N pages" button in addition to "Test on 1 page" in the schema editor for higher-confidence preview.
