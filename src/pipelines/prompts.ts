export const CONTEXT_DEPENDENCY_PROMPT_BLOCK = `

Context dependency detection:
Some documents present a clinical case, reading passage, scenario, or data set and then ask several questions about it. These follow-up questions cannot be understood or answered without that shared context.

For every extracted question, populate two fields:
- depends_on: if this question requires context established by a preceding NUMBERED question, set this to that question's question_number string. Otherwise null.
- context_group: if this question belongs to a group sharing a common case/scenario/passage, assign a short consistent label shared by every question in the group (e.g., "Case 1", "Scenario A", "Passage 2"). If the question is fully standalone, set to null.

Rules:
1. The FIRST question that introduces or appears alongside the shared context gets depends_on=null and context_group set to the group label.
2. All SUBSEQUENT questions that require that same context get depends_on set to the first question's question_number AND the same context_group label.
3. If the shared context appears as an unnumbered preamble (not attached to any question number), all questions in the group get depends_on=null and context_group set to the group label.
4. A fully standalone question gets depends_on=null and context_group=null.
5. All questions in the same group MUST use the exact same context_group string — consistency is critical.`;

export const FIGURES_PROMPT_BLOCK = `

Figures, diagrams & complex tables:
- For each question, identify every visual element that is part of the question or required to answer it: figures, diagrams, charts, graphs, illustrations, and tables that lose meaning when flattened to text.
- For each, emit one entry in the figures array with: normalized bounding box on a 0–1000 scale relative to the page image (ymin, xmin, ymax, xmax); a concise explanation of what it shows; and a kind label.
- Be generous with bounds — include axis labels, legends, captions, and a thin margin around the visual. Tight crops that clip labels are a defect.
- Do not emit a box for plain prose text, equations rendered as text, or single-line tables that fit in a string field. Do not emit a single box covering the entire page.
- If a question has no associated visual, omit the figures field entirely (do not return [] of fabricated boxes).
- A visual element shared by multiple questions MUST be emitted for each question that uses it. Do NOT restrict a figure to only one question — if two or more questions refer to the same diagram, include the same (or overlapping) bounding box in each question's figures array.`;

/**
 * Appended to every extractor prompt. Prevents the most common multi-question failure:
 * carrying one question's stem/options onto a different question number when several
 * questions (or "stations") are processed together in one call.
 */
export const QUESTION_ISOLATION_PROMPT_BLOCK = `

Question isolation (critical for accuracy):
- Transcribe each question STRICTLY from its own region of the page. Never copy, repeat, or carry over the stem or options from a different question, even when several questions or "stations" appear together.
- A shared page does not mean shared content — treat every numbered question/station as fully independent.
- question_number MUST match the number or "Station N" label printed on that question's own region. If you cannot clearly read a question's own content, LOWER its confidence rather than filling it with text from a neighbouring question.
- Never emit two questions with identical or near-identical stems. If two question numbers appear to share the same text, re-read the page — they are almost certainly different questions, and reusing text is an error.`;

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
    "..." if longer. This stays in audit only, never in the user CSV.` + FIGURES_PROMPT_BLOCK + QUESTION_ISOLATION_PROMPT_BLOCK;

/** Common closing line reminding the model to return strict JSON. */
export const STRICT_JSON_REMINDER = `\nReturn strict JSON matching the response schema.`;

/**
 * Conversion prompt: recast NON-MCQ questions (matching, written, true/false) into
 * multiple-choice questions, so a mixed exam can be normalized to one uniform format.
 * A single prompt handles every source type — the model already knows each question's
 * type from the page, and only the recast rules differ per type.
 */
export const CONVERT_TO_MCQ_PROMPT = `You are converting non-multiple-choice exam questions into multiple-choice questions
(MCQs), so a mixed exam can be normalized into one uniform format.

On the given pages, convert EVERY matching, written/short-answer, and true/false question
into one or more MCQs. SKIP questions that are ALREADY standard multiple-choice — those
are handled separately; do NOT re-emit them.

For each row, set converted_from to the original question's type: "matching", "written",
or "true_false". Also set source_question_number to the original printed number.

MATCHING questions (pair each left-column item with its right-column match):
- Generate ONE MCQ per left-column item.
- The stem asks for that item's correct match; the correct option is its REAL pair.
- Distractors are the OTHER right-column items from the SAME set — real, not invented.
  Set ai_generated_options=false.

WRITTEN / short-answer questions:
- Produce ONE MCQ. The correct option is the real/expected answer — extract it if the
  document gives one; otherwise supply the best correct answer.
- Generate plausible distractors. Set ai_generated_options=true (the wrong options were
  invented, so the row should be reviewed).

TRUE/FALSE questions:
- Produce ONE MCQ with exactly two options, "True" and "False". correct_answer marks the
  right one. Set ai_generated_options=false. Ignore any requested option count for these.

GENERAL RULES:
1. Number each generated MCQ as "<original number>.<n>" — matching fans out (7.1, 7.2, 7.3);
   written/true-false are 1:1 (e.g. "12.1"). Keep the original number as the prefix.
2. Preserve math notation with LaTeX delimiters ($x^2 + 1$).
3. Each image is labeled "PAGE N:" — use that as page_number.
4. marking_style MUST be "none". mcq_type is "matching" for matching sources, else "standard".
5. confidence reflects how cleanly the question converted.
6. source_snippet = the verbatim original question text you converted from.
7. If a page has no convertible (non-MCQ) questions, return rows=[] with a short layout_notes.`;

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
    question, capped at 2000 characters.` + FIGURES_PROMPT_BLOCK + QUESTION_ISOLATION_PROMPT_BLOCK;

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
    question, capped at 2000 characters.` + FIGURES_PROMPT_BLOCK + QUESTION_ISOLATION_PROMPT_BLOCK;

/**
 * Answer-key parser prompt. Run separately on the trailing pages of an
 * answer_key_at_end document to extract the `{question_number → letter}` map.
 */
export const ANSWER_KEY_PARSER_PROMPT = `You are parsing answer-key pages of an MCQ exam. The key typically lists each
question number followed by the answer letter (e.g., "1. A", "1) B", "Q1: C",
"1 — D", "1 A 2 B 3 C 4 D" in a grid, etc.).

For each entry on the visible pages, return:
  - question_number: the printed identifier (string, e.g., "1", "23a", "Q5")
  - section: the section label if the answer key covers multiple sections
    (e.g., "A", "Section A", "B"). Omit or set to null for single-section exams.
  - answer: a single uppercase letter A-E
  - confidence: 0-1 based on legibility / handwriting clarity
  - notes: optional, any ambiguity (e.g., "could be B or D — picked B based on
    stroke direction")

Return strict JSON: { entries: [{ question_number, section, answer, confidence, notes }] }.

Critical:
- If the answer key has MULTIPLE sections (e.g., "Section A" and "Section B") where both
  start from question 1, you MUST include the section field on every entry so that answers
  from different sections with the same question number can be distinguished.
- If a question lists multiple letters (e.g., "1. A or C"), pick the one written
  first and set confidence < 0.5.
- If you can't make out the letter at all, omit that entry rather than guessing.
- Preserve question_number as a string. "1" and "01" are different identifiers
  unless the document is clearly zero-padded — in which case strip leading zeros.`;

/**
 * Answer-fill prompt: for documents with no marked answers, have the model supply the
 * correct answer for every question from its own subject knowledge. Run as an opt-in
 * post-extraction step; the orchestrator merges these answers into rows whose answer
 * fields came out empty and flags them `ai_generated`.
 */
export const ANSWER_FILL_PROMPT = `You are answering exam questions that have NO answer marked in the document.

For each question on the given pages, determine the correct answer using your own subject
knowledge, and fill in the answer field(s) the schema asks for — the correct option letter,
the correct option index, and/or a written answer, whichever the schema defines.

RULES:
1. Provide your best correct answer for EVERY question, even though nothing is marked.
2. Extract question_number EXACTLY as printed so each answer matches the right question.
3. Fill the canonical correct_answer with the correct option letter (A-E) for multiple-choice
   questions, and fill any schema-specific answer field consistently with it.
4. confidence reflects how sure you are of the answer (subject difficulty, ambiguity).
5. Preserve math notation with LaTeX delimiters ($x^2 + 1$).
6. Each image is labeled "PAGE N:" — use that as page_number.
7. marking_style MUST be "none" on every row.`;

export const DOCUMENT_ANALYSIS_PROMPT = `You are the brain of an MCQ exam extraction pipeline. You receive EVERY page of an exam PDF as images. Produce a complete structural report — your output drives every downstream stage, so accuracy matters more than speed.

────────────────────────────────────────────
STEP 1 — WHOLE-DOCUMENT SUMMARY (document_summary)
────────────────────────────────────────────
Write 2–6 sentences of plain prose describing the document as a whole. Cover:
• What kind of document is this (exam, practice paper, answer booklet, …)?
• Approximate total number of MCQ questions.
• Are there named sections? If so, how many and what do they cover?
• Is a separate answer key present? On which pages roughly?
• Subject / topic if readable.
• Anything structurally unusual (mixed question types, handwritten answers, multi-column layout, figures, etc.).

────────────────────────────────────────────
STEP 2 — PER-PAGE BREAKDOWN (page_map)
────────────────────────────────────────────
For EVERY page, emit one entry in page_map with:

• page_number   — integer matching the "PAGE N:" label in the input
• content_type  — ONE of: "questions" | "answer_key" | "instructions" | "blank" | "mixed"
• page_summary  — ONE human-readable sentence describing what is on this page. Be specific. Examples:
    "Five MCQs (Q11–15) in two columns, no figures."
    "Answer key for Q1–40, single column."
    "Cover page — exam title and instructions, no questions."
    "Blank page."
    "Three MCQs (Q8–10) plus one true/false question."
• mcq_count        — count of standard multiple-choice questions on this page (integer ≥ 0)
• true_false_count — count of true/false questions on this page (integer ≥ 0)
• written_count    — count of short-answer / written-response questions on this page (integer ≥ 0)
• matching_count   — count of matching questions on this page (pair items in column A to column B) (integer ≥ 0)
• section_label    — section name if this page belongs to a named section, else null
• question_range_start — first question number on this page (null if no questions)
• question_range_end   — last question number on this page (null if no questions)
• has_images       — true if the page contains any embedded figures, diagrams, charts, graphs,
                     illustrations, photos, or image-based tables that cannot be fully represented
                     as plain text; false if the page is purely textual.
• image_count      — the EXACT number of distinct embedded images on this page (figures, diagrams,
                     charts, graphs, illustrations, photos, image-based tables). Count carefully — this
                     drives a downstream image-cropping step. 0 if the page is purely textual.
• images           — one entry per image counted above, each with:
                       · question_number — the question this image belongs to (match it to the question
                         that references or sits with it). Use null ONLY for page-level or decorative
                         images that belong to no specific question.
                       · kind — one of: "figure" | "diagram" | "chart" | "table" | "illustration" | "photo"
                       · description — a short description of what the image shows.
                     The length of this array MUST equal image_count.

────────────────────────────────────────────
STEP 3 — MARKING FORMAT CLASSIFICATION
────────────────────────────────────────────
Classify HOW correct answers are indicated in this document. Choose EXACTLY ONE:

• inline_marked    — options A/B/C/D shown on the same page as the question; one option is visually
                     marked (circled, ticked, underlined, highlighted, crossed, or boxed).
• written_answer   — a letter or word is printed or handwritten near each question stem
                     (e.g., in a margin) to indicate the correct answer.
• answer_key_at_end — questions appear in the body; a separate answer key
                     (e.g., "1. A  2. C  3. B") appears on later pages.
• bubble_sheet     — a separate OMR sheet with filled bubbles.
• no_answers       — no answer marks are visible anywhere in the document.
• mixed_or_unclear — multiple formats are present, or the document is too ambiguous to classify.

Also provide:
• marking_format_confidence — your confidence as a number 0.0–1.0
• marking_format_notes      — brief explanation of your reasoning, or any ambiguities

The document-level marking_format above is the DOMINANT method. Many documents mix methods
across sections (e.g. Q1–20 are inline-circled, Q21–40 have a separate answer key at the end).
Capture this precisely in:

• marking_regions — an array of contiguous question ranges, each sharing ONE marking method:
                     [{question_range_start, question_range_end, marking_format, confidence, notes}]
    - marking_format is one of the same six values listed above EXCEPT mixed_or_unclear
      (each region must resolve to a concrete method; split further if you are unsure).
    - If the WHOLE document uses a single method, emit exactly ONE region covering all questions.
    - The regions together should cover every question in the document without gaps.
    - Set the document-level marking_format to the dominant region's method.

Be conservative: prefer mixed_or_unclear at the DOCUMENT level if you are not sure, but still
populate marking_regions with your best per-range judgement.

────────────────────────────────────────────
STEP 4 — DOCUMENT-LEVEL ROLLUPS
────────────────────────────────────────────
Provide these top-level fields:

• total_questions        — total question count across the entire document (null if uncertain)
• total_mcq_count        — total MCQ questions (null if uncertain)
• total_true_false_count — total true/false questions (null if uncertain)
• total_written_count    — total written/short-answer questions (null if uncertain)
• has_answer_key         — true if any answer key pages are present, false otherwise
• sections               — named sections [{label, question_range_start, question_range_end}], empty array if none
• answer_key_locations   — EVERY page containing an answer key [{page_number, section_label, question_range_start, question_range_end}].
                           For multi-section exams where each section has its own key, list each as a separate entry.
• cross_page_questions   — questions whose stem starts on one page and ends on the next [{question_number, starts_on_page, ends_on_page}]
• content_patterns       — contiguous groups of questions sharing the same type [{question_range_start, question_range_end, question_type}]
                           question_type is one of: "mcq" | "true_false" | "written" | "fill_blank" | "matching" | "other"
                           ("matching" = pair items from column A to column B)
• exam_metadata          — {title, date, subject} — set each to null if you cannot read it
• layout                 — {columns: 1|2|3, has_math: boolean, primary_language: ISO 639-1 code}
• notes                  — any unusual observations not captured above

────────────────────────────────────────────
CRITICAL RULES
────────────────────────────────────────────
- Emit EXACTLY one page_map entry per page — do not skip any page.
- Preserve question numbers exactly as printed (e.g., "1", "23a", "Q5").
- Count mcq_count, true_false_count, written_count carefully — do not estimate.
- If multiple answer keys exist for different sections, each gets its own entry in answer_key_locations with a non-null section_label.
- Return strict JSON matching the response schema.`;

