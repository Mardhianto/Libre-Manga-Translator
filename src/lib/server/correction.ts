/**
 * The validator's `untranslated` list is not a format failure: the page parsed
 * and every box has an entry, but some entries are empty, echoed, or in the
 * wrong language. The first live report showed the model will happily return
 * those and move on, so one focused round-trip is spent naming them.
 */

/**
 * List at most this many boxes. The names only have to jog the model's own
 * output; a 200-box page does not need a 200-entry prompt.
 */
const MAX_LISTED_BOXES = 12;

/**
 * Correction message for the boxes the validator flagged. Empty list means
 * there is nothing to correct and the caller must not spend a request.
 */
export function untranslatedCorrectionPrompt(untranslated: number[]): string {
  if (untranslated.length === 0) return "";
  const labels = untranslated.map((i) => `Box ${i + 1}`);
  const listed =
    labels.length <= MAX_LISTED_BOXES
      ? labels.join(", ")
      : `${labels.slice(0, MAX_LISTED_BOXES).join(", ")} and ${labels.length - MAX_LISTED_BOXES} more`;
  return (
    `${listed} did not come back as a translation of the source text ` +
    `(empty, copied from the source, or written in the wrong language). ` +
    `Translate ${untranslated.length === 1 ? "that box" : "those boxes"} ` +
    `properly into the target language. Keep every other box exactly as it ` +
    `is, keep all boxes in the original order, and return the complete JSON ` +
    `again.`
  );
}

/** Boxes the validator refused, or 0 when this result has no diagnostics. */
export function countUntranslated(result: {
  diagnostics?: { untranslated?: number[] | null } | null;
}): number {
  return result.diagnostics?.untranslated?.length ?? 0;
}

/**
 * Pick the answer to keep after the correction round. A correction that
 * flags MORE boxes is a regression, not an improvement, and must never
 * replace the first page; ties keep the first answer too, so an identical
 * retry costs nothing.
 */
export function keepBetterTranslation<
  T extends { diagnostics?: { untranslated?: number[] | null } | null },
>(first: T, second: T): T {
  return countUntranslated(second) < countUntranslated(first) ? second : first;
}
