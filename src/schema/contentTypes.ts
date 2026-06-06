import type { ContentType } from "./types";

export type RunMode = "extract" | "review" | "answer";

export interface ContentTypeInfo {
  id: ContentType;
  label: string;
  description: string;
}

/** The two output focuses a schema can declare. Drives the editor's focus selector and
 *  whether the post-extraction "Normalize to MCQ" step is offered. */
export const CONTENT_TYPES: Record<ContentType, ContentTypeInfo> = {
  mcq: {
    id: "mcq",
    label: "Multiple choice (MCQ)",
    description:
      "Normalize toward multiple-choice. After extraction, offer to convert matching / written / true-false questions into MCQs.",
  },
  none: {
    id: "none",
    label: "Mixed (keep all types)",
    description:
      "Keep every question in its native type — the CSV can mix MCQ, matching, written, and true/false. No conversion is offered.",
  },
};
