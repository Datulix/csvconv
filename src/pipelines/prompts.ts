/**
 * Extractor prompts library. Each prompt block matches the corresponding §6.x section
 * in SPEC.md. Per-content-type and per-format text is kept as exported constants so the
 * `promptBuilder` can compose them with the user's schema's per-field block.
 */

export const MCQ_INLINE_MARKED_PROMPT = `You are extracting multiple-choice questions from exam pages where the correct
answer is visually marked on the page (circled, ticked, underlined, highlighted,
crossed, or boxed).

For each page, identify EVERY distinct MCQ and extract the fields listed below.

CRITICAL RULES:
1. DO NOT guess the answer based on which option seems factually correct.
   ONLY report explicit visual marks on the page.
2. If no mark is visible, set correct_answer to **null** (the JSON null literal,
   NOT an empty string ""), and set confidence to 0.
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
    "..." if longer. This stays in audit only, never in the user CSV.`;

/** Common closing line reminding the model to return strict JSON. */
export const STRICT_JSON_REMINDER = `\nReturn strict JSON matching the response schema.`;

/** All marking_style enum values per SPEC §6.2 rule 3. */
export const MARKING_STYLE_VALUES = [
  "circled",
  "ticked",
  "underlined",
  "crossed",
  "highlighted",
  "boxed",
  "arrow",
  "x_through_wrong",
  "other",
  "none",
] as const;

/** All mcq_type enum values per SPEC §6.2 rule 10. */
export const MCQ_TYPE_VALUES = [
  "best_answer",
  "except_negative",
  "all_of_above",
  "matching",
  "standard",
] as const;

/** Options letters supported across MCQs. */
export const OPTION_LETTERS = ["A", "B", "C", "D", "E"] as const;

/**
 * Written-answer variant (SPEC §6.3). The answer is indicated by a handwritten or printed
 * letter near each question stem rather than a visual mark on the option itself.
 */
export const MCQ_WRITTEN_ANSWER_PROMPT = `You are extracting multiple-choice questions from exam pages where the correct
answer is indicated by a handwritten or printed letter (or word) near each
question stem — typically in a margin, in parentheses, or in the answer space
following the question. The options themselves are NOT marked.

For each page, identify EVERY distinct MCQ and extract the fields listed below.

CRITICAL RULES:
1. DO NOT guess the answer based on which option seems factually correct.
   ONLY report the letter or word explicitly written/printed near the question.
2. If no answer notation is visible, set correct_answer to **null** (the JSON
   null literal, NOT an empty string ""), and set confidence to 0.
3. The notation may be a single letter (A/B/C/D/E), a word (e.g., "Ans: B"), or a
   handwritten character. Normalize to a single uppercase letter A-E.
4. marking_style should always be "none" for this variant (the options themselves
   aren't marked). Set marking_style="none" for every question.
5. Read multi-column pages top-to-bottom within each column, left column first.
6. Preserve math notation with LaTeX delimiters ($x^2 + 1$).
7. If a question spans a page break, extract it on the page where the stem
   starts, set is_partial=true.
8. Each image is labeled "PAGE N:" — use that as page_number.
9. confidence reflects how certain you are about the answer notation specifically
   — handwritten letters get LOW confidence when ambiguous.
10. If a page contains no MCQ questions, return rows=[] and set layout_notes
    to a short reason.
11. For each question, also infer mcq_type from the question wording / layout.
12. Populate source_snippet with the verbatim transcribed text around the
    question, capped at 2000 characters.`;

/**
 * Answer-key-at-end body extractor variant (SPEC §6.3). Body pages produce questions
 * WITHOUT correct_answer (it lives in a separate end-of-document key). The answer
 * patch pass runs separately.
 */
export const MCQ_ANSWER_KEY_BODY_PROMPT = `You are extracting multiple-choice questions from exam pages where the answer
key lives on separate pages near the end of the document. THESE BODY PAGES DO
NOT HAVE ANSWERS MARKED — your job is to extract the questions and options only.

For each page, identify EVERY distinct MCQ and extract the fields listed below.

CRITICAL RULES:
1. correct_answer MUST be **null** (the JSON null literal, NOT an empty string)
   on every row produced here. The answer key will be joined in by a separate
   pass on the answer-key pages.
2. marking_style MUST be "none" on every row. There are no marks to report.
3. Read multi-column pages top-to-bottom within each column, left column first.
4. Preserve math notation with LaTeX delimiters ($x^2 + 1$).
5. If a question spans a page break, extract it on the page where the stem
   starts, set is_partial=true.
6. Each image is labeled "PAGE N:" — use that as page_number.
7. confidence reflects how certain you are about the question_number and option
   text — not about the (absent) answer.
8. If a page contains no MCQ questions, return rows=[] and set layout_notes
   to a short reason.
9. Infer mcq_type from question wording / layout.
10. Populate source_snippet with the verbatim transcribed text around the
    question, capped at 2000 characters.`;

/**
 * Answer-key parser prompt. Run separately on the trailing pages of an
 * answer_key_at_end document to extract the `{question_number → letter}` map.
 */
export const ANSWER_KEY_PARSER_PROMPT = `You are parsing answer-key pages of an MCQ exam. The key typically lists each
question number followed by the answer letter (e.g., "1. A", "1) B", "Q1: C",
"1 — D", "1 A 2 B 3 C 4 D" in a grid, etc.).

For each entry on the visible pages, return:
  - question_number: the printed identifier (string, e.g., "1", "23a", "Q5")
  - answer: a single uppercase letter A-E
  - confidence: 0-1 based on legibility / handwriting clarity
  - notes: optional, any ambiguity (e.g., "could be B or D — picked B based on
    stroke direction")

Return strict JSON: { entries: [{ question_number, answer, confidence, notes }] }.

Critical:
- If a question lists multiple letters (e.g., "1. A or C"), pick the one written
  first and set confidence < 0.5.
- If you can't make out the letter at all, omit that entry rather than guessing.
- Preserve question_number as a string. "1" and "01" are different identifiers
  unless the document is clearly zero-padded — in which case strip leading zeros.`;
