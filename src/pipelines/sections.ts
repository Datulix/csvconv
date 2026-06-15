/**
 * Section / numbering-run helpers.
 *
 * Multi-section exams restart question numbering at 1 in each section (see the
 * `question-number-not-unique` constraint). Splitting a document-ordered list of items
 * wherever the question number resets recovers those section boundaries without needing a
 * printed section label — used both to match an unlabeled answer key positionally and to
 * validate per-section AI agreement afterwards.
 */

/** Parse the leading integer out of a printed question identifier ("23a" → 23, "Q5" → 5). */
export function parseQuestionNumber(qn: unknown): number | null {
  const m = /\d+/.exec(String(qn ?? ""));
  return m ? parseInt(m[0], 10) : null;
}

/**
 * Split `items` (in document order) into runs, starting a new run wherever the numbering
 * resets (the current number is ≤ the previous one). Items whose number can't be parsed
 * stay in the current run and don't trigger a split.
 */
export function segmentNumberingRuns<T>(items: T[], getNumber: (t: T) => number | null): T[][] {
  const runs: T[][] = [];
  let current: T[] = [];
  let prev: number | null = null;
  for (const item of items) {
    const n = getNumber(item);
    if (prev !== null && n !== null && n <= prev && current.length > 0) {
      runs.push(current);
      current = [];
    }
    current.push(item);
    if (n !== null) prev = n;
  }
  if (current.length > 0) runs.push(current);
  return runs;
}
