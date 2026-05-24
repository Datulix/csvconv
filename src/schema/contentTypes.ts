import type { ContentType, SemanticRole } from "./types";

export type RunMode = "extract" | "review" | "answer";

export interface ContentTypeInfo {
  id: ContentType;
  label: string;
  description: string;
  /** Roles the user can assign to fields. `null` (custom) is always also valid. */
  validRoles: Exclude<SemanticRole, null>[];
  /** Which extractor variants belong to this content type. */
  extractors: string[];
  supportsDetector: boolean;
  supportsSolver: boolean;
  supportedModes: RunMode[];
}

const SHARED_ROLES: Exclude<SemanticRole, null>[] = ["page_number", "is_partial"];

const MCQ_ROLES: Exclude<SemanticRole, null>[] = [
  "question_number",
  "question_text",
  "option_A",
  "option_B",
  "option_C",
  "option_D",
  "option_E",
  "options_concatenated",
  "correct_answer",
  "marking_style",
  "mcq_type",
  "ai_answer",
  "ai_explanation",
  "ai_confidence",
  "agreement",
  "disagreement_reason",
];

const FLASHCARD_ROLES: Exclude<SemanticRole, null>[] = ["term", "definition", "example"];

const QA_PAIR_ROLES: Exclude<SemanticRole, null>[] = ["question", "answer"];

export const CONTENT_TYPES: Record<ContentType, ContentTypeInfo> = {
  mcq: {
    id: "mcq",
    label: "Multiple choice (MCQ)",
    description:
      "Exam-style multiple-choice questions with options A/B/C/D/E. Supports auto-detect of marking format, AI Review mode, and AI Answer mode.",
    validRoles: [...SHARED_ROLES, ...MCQ_ROLES],
    extractors: ["mcq_inlineMarked", "mcq_writtenAnswer", "mcq_answerKeyAtEnd"],
    supportsDetector: true,
    supportsSolver: true,
    supportedModes: ["extract", "review", "answer"],
  },
  flashcard: {
    id: "flashcard",
    label: "Flashcards (term / definition)",
    description:
      "Glossary-style content where each card has a term and a definition. Only Extract mode.",
    validRoles: [...SHARED_ROLES, ...FLASHCARD_ROLES],
    extractors: ["flashcard"],
    supportsDetector: false,
    supportsSolver: false,
    supportedModes: ["extract"],
  },
  qa_pair: {
    id: "qa_pair",
    label: "Question & answer pairs",
    description:
      "FAQ-style content with explicit question→answer structure. Only Extract mode.",
    validRoles: [...SHARED_ROLES, ...QA_PAIR_ROLES],
    extractors: ["qaPair"],
    supportsDetector: false,
    supportsSolver: false,
    supportedModes: ["extract"],
  },
};

export function isRoleValid(contentType: ContentType, role: SemanticRole): boolean {
  if (role === null) return true;
  return CONTENT_TYPES[contentType].validRoles.includes(role);
}

export function rolesFor(contentType: ContentType): Exclude<SemanticRole, null>[] {
  return CONTENT_TYPES[contentType].validRoles;
}
