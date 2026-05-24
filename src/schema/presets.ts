import type { Schema } from "./types";
import type { RunMode } from "./contentTypes";

export interface SchemaPreset {
  id: string;
  label: string;
  description: string;
  recommendedMode: RunMode;
  schema: Schema;
}

const mcqStandardFields = [
  {
    name: "question_number",
    type: "string" as const,
    semantic_role: "question_number" as const,
    description: "Original question number as printed on the page (e.g., '1', '23a', 'Q5').",
    required: true,
  },
  {
    name: "question_text",
    type: "multiline_string" as const,
    semantic_role: "question_text" as const,
    description: "Full question stem, verbatim, preserving line breaks and math notation.",
    required: true,
  },
  {
    name: "option_a",
    type: "string" as const,
    semantic_role: "option_A" as const,
    description: "Option A text.",
    required: true,
  },
  {
    name: "option_b",
    type: "string" as const,
    semantic_role: "option_B" as const,
    description: "Option B text.",
    required: true,
  },
  {
    name: "option_c",
    type: "string" as const,
    semantic_role: "option_C" as const,
    description: "Option C text.",
    required: true,
  },
  {
    name: "option_d",
    type: "string" as const,
    semantic_role: "option_D" as const,
    description: "Option D text.",
    required: true,
  },
  {
    name: "correct_answer",
    type: "enum" as const,
    enum_values: ["A", "B", "C", "D", "E"],
    semantic_role: "correct_answer" as const,
    description: "Letter of the marked correct answer. Null if no mark is visible.",
    required: true,
  },
];

export const PRESETS: SchemaPreset[] = [
  {
    id: "mcq_standard",
    label: "MCQ Standard",
    description:
      "Question number, question text, options A–D, and the marked correct answer. Classic four-option MCQ output.",
    recommendedMode: "extract",
    schema: {
      schema_version: 1,
      name: "MCQ Standard",
      content_type: "mcq",
      fields: mcqStandardFields,
    },
  },
  {
    id: "mcq_for_anki",
    label: "MCQ for Anki",
    description:
      "Front (question + concatenated options) and Back (correct answer). Drop straight into an Anki deck import.",
    recommendedMode: "extract",
    schema: {
      schema_version: 1,
      name: "MCQ for Anki",
      content_type: "mcq",
      fields: [
        {
          name: "Front",
          type: "multiline_string",
          semantic_role: "options_concatenated",
          description: "Question text followed by all options on separate lines.",
          required: true,
          template:
            "{{question_text}}\n\nA) {{options.A}}\nB) {{options.B}}\nC) {{options.C}}\nD) {{options.D}}",
        },
        {
          name: "Back",
          type: "enum",
          enum_values: ["A", "B", "C", "D", "E"],
          semantic_role: "correct_answer",
          description: "Letter of the marked correct answer.",
          required: true,
        },
        {
          name: "Tags",
          type: "string",
          semantic_role: null,
          description: "Anki tags for this card. Leave empty if not categorizing.",
          required: false,
        },
      ],
    },
  },
  {
    id: "mcq_topic_difficulty",
    label: "MCQ with Topic & Difficulty",
    description:
      "Standard MCQ fields plus AI-inferred topic and difficulty for richer downstream filtering.",
    recommendedMode: "extract",
    schema: {
      schema_version: 1,
      name: "MCQ with Topic & Difficulty",
      content_type: "mcq",
      fields: [
        ...mcqStandardFields,
        {
          name: "topic",
          type: "string",
          semantic_role: null,
          description:
            "Subject area inferred from question content (e.g., 'Cell Biology', 'Linear Algebra'). Use null if ambiguous.",
          required: false,
        },
        {
          name: "difficulty",
          type: "enum",
          enum_values: ["easy", "medium", "hard"],
          semantic_role: null,
          description:
            "Estimated difficulty based on question complexity and depth of reasoning required.",
          required: false,
        },
      ],
    },
  },
  {
    id: "mcq_review",
    label: "MCQ Review",
    description:
      "Compares the marked answer against an independent AI solve. Use with Review mode to surface disagreements between the printed answer key and what the AI thinks.",
    recommendedMode: "review",
    schema: {
      schema_version: 1,
      name: "MCQ Review",
      content_type: "mcq",
      fields: [
        {
          name: "question_number",
          type: "string",
          semantic_role: "question_number",
          description: "Original question number.",
          required: true,
        },
        {
          name: "question_text",
          type: "multiline_string",
          semantic_role: "question_text",
          description: "Full question text.",
          required: true,
        },
        {
          name: "correct_answer",
          type: "enum",
          enum_values: ["A", "B", "C", "D", "E"],
          semantic_role: "correct_answer",
          description: "Marked correct answer letter from the PDF.",
          required: true,
        },
        {
          name: "ai_answer",
          type: "enum",
          enum_values: ["A", "B", "C", "D", "E"],
          semantic_role: "ai_answer",
          description: "AI's independent answer (null if AI declined).",
          required: false,
        },
        {
          name: "agreement",
          type: "boolean",
          semantic_role: "agreement",
          description: "True if the AI's answer matches the marked answer.",
          required: false,
        },
        {
          name: "ai_explanation",
          type: "multiline_string",
          semantic_role: "ai_explanation",
          description: "AI's reasoning for its chosen answer.",
          required: false,
        },
      ],
    },
  },
  {
    id: "mcq_ai_answer_key",
    label: "MCQ AI Answer Key",
    description:
      "AI solves every question from scratch (ignores any marked answers). Use with Answer-from-scratch mode to generate a fresh answer key.",
    recommendedMode: "answer",
    schema: {
      schema_version: 1,
      name: "MCQ AI Answer Key",
      content_type: "mcq",
      fields: [
        {
          name: "question_number",
          type: "string",
          semantic_role: "question_number",
          description: "Original question number.",
          required: true,
        },
        {
          name: "question_text",
          type: "multiline_string",
          semantic_role: "question_text",
          description: "Full question text.",
          required: true,
        },
        {
          name: "ai_answer",
          type: "enum",
          enum_values: ["A", "B", "C", "D", "E"],
          semantic_role: "ai_answer",
          description: "AI's chosen answer (null if unanswerable).",
          required: true,
        },
        {
          name: "ai_explanation",
          type: "multiline_string",
          semantic_role: "ai_explanation",
          description: "AI's reasoning, 1–3 sentences.",
          required: true,
        },
        {
          name: "ai_confidence",
          type: "number",
          semantic_role: "ai_confidence",
          description: "AI's self-reported confidence, 0 to 1.",
          required: true,
        },
      ],
    },
  },
  {
    id: "flashcard",
    label: "Flashcard (Term / Definition)",
    description:
      "Glossary-style content. Extracts the term and its definition from each card, with an optional example.",
    recommendedMode: "extract",
    schema: {
      schema_version: 1,
      name: "Flashcard (Term / Definition)",
      content_type: "flashcard",
      fields: [
        {
          name: "term",
          type: "string",
          semantic_role: "term",
          description: "The term being defined (usually bolded or in a header).",
          required: true,
        },
        {
          name: "definition",
          type: "multiline_string",
          semantic_role: "definition",
          description: "The explanatory text immediately following the term.",
          required: true,
        },
        {
          name: "example",
          type: "multiline_string",
          semantic_role: "example",
          description: "Optional example sentence or illustration. Null if absent.",
          required: false,
        },
      ],
    },
  },
  {
    id: "qa_pair",
    label: "Q&A Pair",
    description:
      "FAQ-style content where each page section has an explicit question and answer.",
    recommendedMode: "extract",
    schema: {
      schema_version: 1,
      name: "Q&A Pair",
      content_type: "qa_pair",
      fields: [
        {
          name: "question",
          type: "string",
          semantic_role: "question",
          description: "The question being asked.",
          required: true,
        },
        {
          name: "answer",
          type: "multiline_string",
          semantic_role: "answer",
          description: "The corresponding answer text.",
          required: true,
        },
      ],
    },
  },
];

export function presetsByContentType(contentType: string): SchemaPreset[] {
  return PRESETS.filter((p) => p.schema.content_type === contentType);
}

export function presetById(id: string): SchemaPreset | undefined {
  return PRESETS.find((p) => p.id === id);
}
