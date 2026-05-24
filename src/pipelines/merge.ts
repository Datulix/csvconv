import type {
  ExtractedBatch,
  ExtractedPage,
  ExtractedRow,
} from "./extractors/types";

/**
 * Page-span merge stage (SPEC §4.4).
 *
 * When the extractor returns `is_partial=true` for a question on page N, look at the
 * first row of page N+1. If its `question_number` matches the partial stem, merge:
 * concat `question_text`, prefer non-empty options from the continuation, clear
 * `is_partial`, append a merge note, and record the source pages.
 *
 * If the numbers don't match, the partial row is left in place for the user to fix
 * in the Review UI.
 */
export interface MergeOptions {
  /** When true, also concatenate source_snippet across merged pages. */
  mergeSourceSnippets?: boolean;
}

export interface MergedRow extends ExtractedRow {
  merged_from_pages?: number[];
}

export function mergeAcrossPages(
  batches: ExtractedBatch[],
  options: MergeOptions = {},
): ExtractedBatch {
  // Flatten all pages from all batches, in (page_number) order.
  const allPages: ExtractedPage[] = batches
    .flatMap((b) => b.pages)
    .slice()
    .sort((a, b) => a.page_number - b.page_number);

  for (let i = 0; i < allPages.length - 1; i++) {
    const cur = allPages[i];
    const next = allPages[i + 1];
    if (cur.rows.length === 0 || next.rows.length === 0) continue;

    const lastRow = cur.rows[cur.rows.length - 1];
    if (!lastRow.is_partial) continue;

    const firstNextRow = next.rows[0];
    if (firstNextRow.question_number !== lastRow.question_number) continue;

    mergeRows(lastRow, firstNextRow, [cur.page_number, next.page_number], options);

    next.rows.shift();
  }

  return { pages: allPages };
}

function mergeRows(
  stem: ExtractedRow,
  continuation: ExtractedRow,
  sourcePages: number[],
  options: MergeOptions,
): void {
  const merged = stem as MergedRow;

  if (continuation.question_text && continuation.question_text.trim().length > 0) {
    merged.question_text = `${merged.question_text}\n${continuation.question_text}`.trim();
  }

  // Prefer non-empty options from the continuation when the stem didn't capture them.
  for (const letter of ["A", "B", "C", "D", "E"] as const) {
    const stemVal = merged.options?.[letter] ?? null;
    const contVal = continuation.options?.[letter] ?? null;
    if ((!stemVal || stemVal.trim().length === 0) && contVal && contVal.trim().length > 0) {
      if (merged.options) merged.options[letter] = contVal;
    }
  }

  if (
    (!merged.correct_answer || merged.correct_answer === null) &&
    continuation.correct_answer
  ) {
    merged.correct_answer = continuation.correct_answer;
    if (continuation.marking_style && continuation.marking_style !== "none") {
      merged.marking_style = continuation.marking_style;
    }
  }

  if (options.mergeSourceSnippets && continuation.source_snippet) {
    const joined = `${merged.source_snippet ?? ""} ${continuation.source_snippet}`.trim();
    merged.source_snippet = joined.slice(0, 2000);
  }

  merged.is_partial = false;
  const note = `merged from pages ${sourcePages.join(", ")}`;
  merged.notes = merged.notes ? `${merged.notes} · ${note}` : note;
  merged.merged_from_pages = sourcePages;
}
