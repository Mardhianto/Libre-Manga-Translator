/**
 * Per-box line accounting for the recognizers.
 *
 * `failed` used to mean "every line dropped", so a box that lost half its
 * clauses was indistinguishable from a legitimately empty one. The pipeline
 * needs that distinction twice: the overlay to offer a retry, and the content
 * script to refuse caching a page with missing input.
 */

/** A box must keep at least this share of its lines to count as read. */
export const MIN_KEPT_LINE_SHARE = 0.5;

export interface LineAccounting {
  /** No line survived: the box has no text at all. */
  failed: boolean;
  /** Some lines survived, but fewer than `MIN_KEPT_LINE_SHARE` of them. */
  partial: boolean;
  keptLines: number;
  droppedLines: number;
}

export function summarizeLineCounts(
  keptLines: number,
  droppedLines: number,
): LineAccounting {
  const failed = keptLines === 0;
  const total = keptLines + droppedLines;
  // "At least half dropped" is the line: 1 kept of 2 is content loss, not a
  // rounding detail.
  const partial =
    !failed && droppedLines > 0 && keptLines / total <= MIN_KEPT_LINE_SHARE;
  return { failed, partial, keptLines, droppedLines };
}
