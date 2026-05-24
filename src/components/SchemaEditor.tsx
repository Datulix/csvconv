import { useEffect, useMemo, useState } from "react";
import type {
  ContentType,
  FieldDefinition,
  FieldType,
  Schema,
  SemanticRole,
} from "../schema/types";
import { CURRENT_SCHEMA_VERSION } from "../schema/types";
import { CONTENT_TYPES, isRoleValid, rolesFor } from "../schema/contentTypes";
import { PRESETS, presetsByContentType, type SchemaPreset } from "../schema/presets";
import { schemaHash } from "../schema/hash";
import {
  loadSchemas,
  saveSchema as saveSchemaToDisk,
  deleteSchema as deleteSchemaFromDisk,
  type SavedSchemaEntry,
} from "../lib/schemaStorage";

const FIELD_TYPES: FieldType[] = ["string", "multiline_string", "enum", "number", "boolean"];

type PreviewKind = "json_schema" | "raw_schema" | null;

function emptySchema(contentType: ContentType = "mcq"): Schema {
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    name: "Untitled schema",
    content_type: contentType,
    fields: [],
  };
}

function emptyField(): FieldDefinition {
  return {
    name: "new_field",
    type: "string",
    semantic_role: null,
    description: "",
    required: false,
  };
}

export function SchemaEditor() {
  const [savedSchemas, setSavedSchemas] = useState<SavedSchemaEntry[]>([]);
  const [current, setCurrent] = useState<Schema>(() => emptySchema());
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewKind>(null);
  const [hash, setHash] = useState<string>("");
  const [loadedNameOnDisk, setLoadedNameOnDisk] = useState<string | null>(null);

  useEffect(() => {
    refreshList();
  }, []);

  useEffect(() => {
    let cancelled = false;
    schemaHash(current).then((h) => {
      if (!cancelled) setHash(h);
    });
    return () => {
      cancelled = true;
    };
  }, [current]);

  async function refreshList() {
    try {
      const list = await loadSchemas();
      setSavedSchemas(list);
    } catch (err) {
      console.error("failed to load schemas", err);
    }
  }

  function updateSchema(patch: Partial<Schema>) {
    setCurrent((s) => ({ ...s, ...patch }));
    setDirty(true);
  }

  function updateField(idx: number, patch: Partial<FieldDefinition>) {
    setCurrent((s) => ({
      ...s,
      fields: s.fields.map((f, i) => (i === idx ? { ...f, ...patch } : f)),
    }));
    setDirty(true);
  }

  function moveField(idx: number, delta: number) {
    setCurrent((s) => {
      const next = [...s.fields];
      const target = idx + delta;
      if (target < 0 || target >= next.length) return s;
      [next[idx], next[target]] = [next[target], next[idx]];
      return { ...s, fields: next };
    });
    setDirty(true);
  }

  function removeField(idx: number) {
    setCurrent((s) => ({ ...s, fields: s.fields.filter((_, i) => i !== idx) }));
    setDirty(true);
  }

  function addField() {
    setCurrent((s) => ({ ...s, fields: [...s.fields, emptyField()] }));
    setDirty(true);
  }

  function changeContentType(ct: ContentType) {
    setCurrent((s) => {
      const cleaned = s.fields.map((f) => ({
        ...f,
        semantic_role: isRoleValid(ct, f.semantic_role) ? f.semantic_role : null,
      }));
      return { ...s, content_type: ct, fields: cleaned };
    });
    setDirty(true);
  }

  function applyPreset(preset: SchemaPreset) {
    const name = preset.schema.name + " (copy)";
    setCurrent({ ...preset.schema, name });
    setLoadedNameOnDisk(null);
    setDirty(true);
  }

  function newSchema() {
    setCurrent(emptySchema());
    setLoadedNameOnDisk(null);
    setDirty(false);
    setSavedAt(null);
    setSaveError(null);
  }

  function openSaved(entry: SavedSchemaEntry) {
    setCurrent(entry.content);
    setLoadedNameOnDisk(entry.name);
    setDirty(false);
    setSavedAt(null);
    setSaveError(null);
  }

  async function handleSave() {
    setSaveError(null);
    if (!current.name.trim()) {
      setSaveError("Schema name is required.");
      return;
    }
    try {
      const savedFilename = await saveSchemaToDisk(current);
      setLoadedNameOnDisk(savedFilename);
      setDirty(false);
      setSavedAt(new Date().toLocaleTimeString());
      await refreshList();
    } catch (err) {
      setSaveError(String(err));
    }
  }

  async function handleDelete(name: string) {
    try {
      await deleteSchemaFromDisk(name);
      if (loadedNameOnDisk === name) newSchema();
      await refreshList();
    } catch (err) {
      console.error("failed to delete schema", err);
    }
  }

  const validation = useMemo(() => validateSchema(current), [current]);

  return (
    <div className="schema-editor-layout">
      <aside className="schema-list">
        <div className="schema-list-header">
          <span className="schema-list-title">Saved schemas</span>
          <button className="btn-secondary small" onClick={newSchema}>
            + new
          </button>
        </div>
        {savedSchemas.length === 0 ? (
          <div className="schema-list-empty">
            <p>No schemas saved yet. Start from a preset or build one from scratch.</p>
          </div>
        ) : (
          <ul className="schema-list-items">
            {savedSchemas.map((s) => {
              const ct = s.content.content_type;
              return (
                <li
                  key={s.name}
                  className={`schema-list-item ${
                    loadedNameOnDisk === s.name ? "active" : ""
                  }`}
                >
                  <button
                    className="schema-list-button"
                    type="button"
                    onClick={() => openSaved(s)}
                  >
                    <span className="schema-list-name">{s.content.name}</span>
                    <span className="schema-list-meta">
                      {ct} · {s.content.fields.length} field
                      {s.content.fields.length === 1 ? "" : "s"}
                    </span>
                  </button>
                  <button
                    className="schema-list-delete"
                    title={`Delete ${s.content.name}`}
                    onClick={() => handleDelete(s.name)}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      <main className="schema-editor-main">
        <header className="schema-editor-header">
          <input
            type="text"
            className="schema-name-input"
            value={current.name}
            onChange={(e) => updateSchema({ name: e.target.value })}
            placeholder="Schema name"
          />
          <div className="schema-meta">
            <span className="badge">{current.content_type}</span>
            <span className="hash" title="schema_hash for cache key">
              {hash ? `#${hash.slice(0, 10)}` : "computing…"}
            </span>
            {dirty ? <span className="status warning">unsaved</span> : null}
            {savedAt && !dirty ? <span className="status saved">saved at {savedAt}</span> : null}
          </div>
        </header>

        <section className="card">
          <label className="block-label">Content type</label>
          <div className="content-type-grid">
            {Object.values(CONTENT_TYPES).map((ct) => (
              <label
                key={ct.id}
                className={`content-type-card ${
                  current.content_type === ct.id ? "selected" : ""
                }`}
              >
                <input
                  type="radio"
                  name="content-type"
                  checked={current.content_type === ct.id}
                  onChange={() => changeContentType(ct.id)}
                />
                <div className="content-type-title">{ct.label}</div>
                <div className="content-type-desc">{ct.description}</div>
                <div className="content-type-flags">
                  {ct.supportsDetector ? <span className="chip">detector</span> : null}
                  {ct.supportsSolver ? <span className="chip">solver</span> : null}
                  <span className="chip">
                    modes: {ct.supportedModes.join(" / ")}
                  </span>
                </div>
              </label>
            ))}
          </div>
        </section>

        <section className="card">
          <label className="block-label">Apply a preset</label>
          <p className="hint">
            Shipped presets for the selected content type. Picking one overwrites the current
            field list.
          </p>
          <div className="preset-grid">
            {presetsByContentType(current.content_type).map((p) => (
              <button
                key={p.id}
                type="button"
                className="preset-card"
                onClick={() => applyPreset(p)}
              >
                <div className="preset-title">{p.label}</div>
                <div className="preset-desc">{p.description}</div>
                <div className="preset-meta">
                  <span className="chip">{p.recommendedMode}</span>
                  <span className="chip">{p.schema.fields.length} fields</span>
                </div>
              </button>
            ))}
          </div>
          <div className="preset-other">
            {PRESETS.filter((p) => p.schema.content_type !== current.content_type).length > 0 ? (
              <details>
                <summary>Show presets for other content types</summary>
                <div className="preset-grid">
                  {PRESETS.filter((p) => p.schema.content_type !== current.content_type).map(
                    (p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="preset-card faded"
                        onClick={() => applyPreset(p)}
                      >
                        <div className="preset-title">{p.label}</div>
                        <div className="preset-desc">{p.description}</div>
                        <div className="preset-meta">
                          <span className="chip">{p.schema.content_type}</span>
                          <span className="chip">{p.recommendedMode}</span>
                        </div>
                      </button>
                    ),
                  )}
                </div>
              </details>
            ) : null}
          </div>
        </section>

        <section className="card">
          <div className="fields-header">
            <label className="block-label">Fields ({current.fields.length})</label>
            <button type="button" className="btn-secondary small" onClick={addField}>
              + add field
            </button>
          </div>
          {current.fields.length === 0 ? (
            <p className="hint">
              No fields yet. Apply a preset above, or click "add field" to start from scratch.
            </p>
          ) : (
            <ol className="field-list">
              {current.fields.map((field, idx) => (
                <FieldRow
                  key={idx}
                  field={field}
                  index={idx}
                  total={current.fields.length}
                  contentType={current.content_type}
                  onChange={(patch) => updateField(idx, patch)}
                  onMove={(delta) => moveField(idx, delta)}
                  onRemove={() => removeField(idx)}
                />
              ))}
            </ol>
          )}
        </section>

        {validation.errors.length > 0 ? (
          <section className="card validation-errors">
            <strong>Validation issues</strong>
            <ul>
              {validation.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="action-bar">
          <button type="button" className="btn-secondary" onClick={() => setPreview("raw_schema")}>
            Preview JSON
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled
            title="Will run the extractor on one page once that pipeline is wired up (build step 9)."
          >
            Test on 1 page
          </button>
          <div className="action-spacer" />
          <button
            type="button"
            className="btn-primary big"
            onClick={handleSave}
            disabled={validation.errors.length > 0 || !current.name.trim()}
          >
            Save schema
          </button>
        </div>
        {saveError ? <p className="status error">{saveError}</p> : null}

        {preview === "raw_schema" ? (
          <PreviewModal title="Schema JSON" onClose={() => setPreview(null)}>
            <pre>{JSON.stringify(current, null, 2)}</pre>
          </PreviewModal>
        ) : null}
      </main>
    </div>
  );
}

interface FieldRowProps {
  field: FieldDefinition;
  index: number;
  total: number;
  contentType: ContentType;
  onChange: (patch: Partial<FieldDefinition>) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}

function FieldRow({
  field,
  index,
  total,
  contentType,
  onChange,
  onMove,
  onRemove,
}: FieldRowProps) {
  const validRoles: Array<Exclude<SemanticRole, null>> = useMemo(
    () => rolesFor(contentType),
    [contentType],
  );

  function setRole(value: string) {
    onChange({ semantic_role: value === "" ? null : (value as SemanticRole) });
  }

  function setType(value: FieldType) {
    if (value === "enum" && (!field.enum_values || field.enum_values.length === 0)) {
      onChange({ type: value, enum_values: ["A", "B"] });
    } else {
      onChange({ type: value });
    }
  }

  return (
    <li className="field-row">
      <div className="field-row-handle">
        <button
          className="btn-icon"
          onClick={() => onMove(-1)}
          disabled={index === 0}
          title="Move up"
        >
          ↑
        </button>
        <button
          className="btn-icon"
          onClick={() => onMove(1)}
          disabled={index === total - 1}
          title="Move down"
        >
          ↓
        </button>
        <span className="field-index">#{index + 1}</span>
      </div>
      <div className="field-row-body">
        <div className="field-row-line">
          <div className="field-col flex-2">
            <label>Name</label>
            <input
              type="text"
              value={field.name}
              onChange={(e) => onChange({ name: e.target.value })}
              spellCheck={false}
            />
          </div>
          <div className="field-col flex-1">
            <label>Type</label>
            <select
              value={field.type}
              onChange={(e) => setType(e.target.value as FieldType)}
            >
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="field-col flex-2">
            <label>Semantic role</label>
            <select
              value={field.semantic_role ?? ""}
              onChange={(e) => setRole(e.target.value)}
            >
              <option value="">(custom — extracted from description)</option>
              {validRoles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div className="field-col field-col-required">
            <label>Required</label>
            <input
              type="checkbox"
              checked={field.required}
              onChange={(e) => onChange({ required: e.target.checked })}
            />
          </div>
        </div>
        {field.type === "enum" ? (
          <div className="field-row-line">
            <div className="field-col flex-1">
              <label>Enum values (comma-separated)</label>
              <input
                type="text"
                value={(field.enum_values ?? []).join(", ")}
                onChange={(e) =>
                  onChange({
                    enum_values: e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter((s) => s.length > 0),
                  })
                }
                placeholder="A, B, C, D"
              />
            </div>
          </div>
        ) : null}
        <div className="field-row-line">
          <div className="field-col flex-1">
            <label>Description (shown to the model)</label>
            <textarea
              value={field.description}
              onChange={(e) => onChange({ description: e.target.value })}
              rows={2}
              placeholder="Describe what should be extracted for this field. Be specific."
            />
          </div>
        </div>
      </div>
      <div className="field-row-delete">
        <button
          className="btn-danger small"
          onClick={onRemove}
          title="Remove field"
        >
          ×
        </button>
      </div>
    </li>
  );
}

interface PreviewModalProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

function PreviewModal({ title, onClose, children }: PreviewModalProps) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>{title}</h2>
          <button onClick={onClose} className="btn-icon" title="Close">
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

interface ValidationResult {
  errors: string[];
}

function validateSchema(schema: Schema): ValidationResult {
  const errors: string[] = [];
  if (!schema.name.trim()) errors.push("Schema name is required.");
  const namesSeen = new Set<string>();
  schema.fields.forEach((f, i) => {
    const fieldLabel = `Field #${i + 1} (${f.name || "unnamed"})`;
    if (!f.name.trim()) errors.push(`${fieldLabel}: name is required.`);
    else if (namesSeen.has(f.name)) {
      errors.push(`${fieldLabel}: duplicate field name "${f.name}".`);
    } else {
      namesSeen.add(f.name);
    }
    if (f.semantic_role !== null && !isRoleValid(schema.content_type, f.semantic_role)) {
      errors.push(
        `${fieldLabel}: semantic_role "${f.semantic_role}" is not valid for content_type "${schema.content_type}".`,
      );
    }
    if (f.type === "enum" && (!f.enum_values || f.enum_values.length === 0)) {
      errors.push(`${fieldLabel}: enum type requires at least one enum value.`);
    }
  });
  return { errors };
}
