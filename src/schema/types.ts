/**
 * Schema types — mirror SPEC §5.1. Bump `SchemaVersion` when the structure changes
 * and add a migration in `schema/hash.ts` / `schema/migrate.ts` (latter is v2 territory).
 */

export type SchemaVersion = 1;

// The schema's output focus:
//   "mcq"  — normalize toward multiple-choice; offer to convert other question types → MCQ.
//   "none" — mixed output; keep every question in its native type, no conversion offered.
// Both use the same MCQ-based extraction pipeline; content_type only gates the conversion step.
export type ContentType = "mcq" | "none";

export type FieldType = "string" | "multiline_string" | "enum" | "number" | "boolean";

export interface FieldDefinition {
  name: string;
  type: FieldType;
  enum_values?: string[];
  description: string;
  required: boolean;
  template?: string;
}

export interface Schema {
  schema_version: SchemaVersion;
  name: string;
  content_type: ContentType;
  fields: FieldDefinition[];
}

export const CURRENT_SCHEMA_VERSION: SchemaVersion = 1;
