import type { Schema, FieldDefinition } from "./types";

/**
 * Canonical-form schema hash. Per SPEC §5.5:
 *
 * - Include: schema_version, content_type, fields[]
 * - Per-field: name, type, enum_values (sorted), semantic_role, description, required, template
 * - Exclude: schema name (cosmetic), UI-only state
 * - Preserve field array order — order changes the prompt block order and column order
 *
 * The output is the lowercase-hex sha256 of the canonical-JSON form.
 */
export async function schemaHash(schema: Schema): Promise<string> {
  const canonical = canonicalize(schema);
  const json = stableStringify(canonical);
  const buffer = new TextEncoder().encode(json);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface CanonicalField {
  name: string;
  type: string;
  enum_values?: string[];
  semantic_role: string | null;
  description: string;
  required: boolean;
  template?: string;
}

interface CanonicalSchema {
  schema_version: number;
  content_type: string;
  fields: CanonicalField[];
}

function canonicalize(schema: Schema): CanonicalSchema {
  return {
    schema_version: schema.schema_version,
    content_type: schema.content_type,
    fields: schema.fields.map(canonicalizeField),
  };
}

function canonicalizeField(field: FieldDefinition): CanonicalField {
  const out: CanonicalField = {
    name: field.name,
    type: field.type,
    semantic_role: field.semantic_role,
    description: field.description,
    required: field.required,
  };
  if (field.enum_values && field.enum_values.length > 0) {
    out.enum_values = [...field.enum_values].sort();
  }
  if (field.template !== undefined) {
    out.template = field.template;
  }
  return out;
}

/**
 * Deterministic JSON.stringify: object keys are sorted alphabetically at every depth,
 * but array element order is preserved (because field order is load-bearing).
 */
function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const entries = keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k]));
    return "{" + entries.join(",") + "}";
  }
  return JSON.stringify(value);
}

// Exported for the hash goldens fixture (build step 6 followup).
export const _internal = { canonicalize, stableStringify };
