import type { Schema } from "./types";
import type { RunMode } from "./contentTypes";

export interface SchemaPreset {
  id: string;
  label: string;
  description: string;
  recommendedMode: RunMode;
  schema: Schema;
}

export const PRESETS: SchemaPreset[] = [
  {
    id: "triviadox",
    label: "Triviadox",
    description:
      "Triviadox database format — options as a JSON array and a 0-based correct_index.",
    recommendedMode: "extract",
    schema: {
      schema_version: 1,
      name: "Triviadox",
      content_type: "mcq",
      fields: [
        {
          name: "question",
          type: "multiline_string",
          template: "{{question_text}}",
          description: "Full question stem verbatim.",
          required: true,
        },
        {
          name: "options",
          type: "string",
          description:
            'JSON array of all answer choices in order, exactly as printed. Example: ["The GE junction is below the diaphragm", "GE junction migrates to the chest", "GE junction and fundus herniates into the chest", "Reflux esophagitis is a common presentation."]',
          required: true,
        },
        {
          name: "correct_index",
          type: "number",
          description:
            "0-based index of the correct answer inside the options array. A=0, B=1, C=2, D=3, E=4. Null if no correct answer is marked.",
          required: true,
        },
        {
          name: "year",
          type: "string",
          description:
            "Year the question appeared on the exam, if readable from the document (e.g., '2023'). Null if not stated.",
          required: false,
        },
        {
          name: "image_url",
          type: "string",
          description:
            "URL of an associated image. Leave null — to be filled in after export if the question has a figure.",
          required: false,
        },
      ],
    },
  },
  {
    id: "exam",
    label: "Exam",
    description:
      "Universal exam schema — works for MCQ, written-answer, matching, and true/false questions in the same document.",
    recommendedMode: "extract",
    schema: {
      schema_version: 1,
      name: "Exam",
      content_type: "none",
      fields: [
        {
          name: "question_number",
          type: "string",
          description:
            "Question number exactly as printed on the page (e.g., '1', 'Q5', '23a').",
          required: true,
        },
        {
          name: "question_text",
          type: "multiline_string",
          description:
            "Full question stem verbatim, preserving line breaks and math notation. For matching questions, include both column lists.",
          required: true,
        },
        {
          name: "question_type",
          type: "enum",
          enum_values: ["mcq", "written", "matching", "true_false", "other"],
          description:
            "Format of this question: 'mcq' for multiple-choice with lettered options, 'written' for short or long answer, 'matching' for column-pairing, 'true_false' for T/F, 'other' for anything else.",
          required: true,
        },
        {
          name: "option_a",
          type: "string",
          description:
            "Text of answer choice A. Fill for MCQ questions only; null for all other types.",
          required: false,
        },
        {
          name: "option_b",
          type: "string",
          description:
            "Text of answer choice B. Fill for MCQ questions only; null for all other types.",
          required: false,
        },
        {
          name: "option_c",
          type: "string",
          description:
            "Text of answer choice C. Fill for MCQ questions only; null for all other types.",
          required: false,
        },
        {
          name: "option_d",
          type: "string",
          description:
            "Text of answer choice D. Fill for MCQ questions only; null for all other types.",
          required: false,
        },
        {
          name: "option_e",
          type: "string",
          description:
            "Text of answer choice E if present. Fill for MCQ questions only; null otherwise.",
          required: false,
        },
        {
          name: "correct_answer",
          type: "string",
          description:
            "Correct answer. For MCQ: the marked letter A–E, or null if no mark is visible. For written/matching/true_false leave null and use answer_text instead.",
          required: false,
        },
        {
          name: "answer_text",
          type: "multiline_string",
          description:
            "Expected answer for written, matching, and true/false questions. For written: the model answer text. For matching: describe the correct pairings (e.g., '1→C, 2→A, 3→B'). For true/false: 'True' or 'False'. Leave null for MCQ.",
          required: false,
        },
      ],
    },
  },
];

