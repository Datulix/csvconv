/**
 * Schema types — mirror SPEC §5.1. Bump `SchemaVersion` when the structure changes
 * and add a migration in `schema/hash.ts` / `schema/migrate.ts` (latter is v2 territory).
 */

export type SchemaVersion = 1;

export type ContentType = "mcq" | "flashcard" | "qa_pair";

export type FieldType = "string" | "multiline_string" | "enum" | "number" | "boolean";

/**
 * Semantic role tags drive app-controlled extraction. Roles must be valid for the
 * schema's `content_type` (enforced by the editor; see `contentTypes.ts`).
 */
export type SemanticRole =
  // shared
  | "page_number"
  | "is_partial"
  // mcq
  | "question_text"
  | "question_number"
  | "option_A"
  | "option_B"
  | "option_C"
  | "option_D"
  | "option_E"
  | "options_concatenated"
  | "correct_answer"
  | "marking_style"
  | "mcq_type"
  // solver (mcq only, when ai_solve mode)
  | "ai_answer"
  | "ai_explanation"
  | "ai_confidence"
  | "agreement"
  | "disagreement_reason"
  // flashcard
  | "term"
  | "definition"
  | "example"
  // qa_pair
  | "question"
  | "answer"
  // custom — extracted from the user's description alone
  | null;

export interface FieldDefinition {
  name: string;
  type: FieldType;
  enum_values?: string[];
  semantic_role: SemanticRole;
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
