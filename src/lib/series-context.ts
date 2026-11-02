/**
 * Pure series-context model (LMT-026).
 *
 * No storage imports on purpose: every rule that decides what a context looks
 * like (shape, legacy migration, UTF-8 byte caps) is testable without a
 * browser extension host. `series-context-store.ts` owns the read/write keys.
 *
 * Caps exist because the settings part lives in a `sync:` item, which browsers
 * hard-cap at 8 KB per item. A model-written summary plus a long glossary can
 * silently fail to persist otherwise, and a failed write only logs today.
 */

export interface SeriesContextSyncPart {
  seriesName: string;
  summary: string;
  dictionary: string;
  lastChapterId: string | null;
  lastPageIndex: number | null;
  translatedCount: number;
}

export const SERIES_CONTEXT_LIMITS = {
  summaryBytes: 2000,
  dictionaryBytes: 2000,
  historyEntryBytes: 1200,
  /** Sum of history entry text bytes. Defensive: the per-entry cap already
   *  bounds 5 entries at 6000, so this only bites if those caps drift. */
  historyTotalBytes: 6000,
  historyMaxEntries: 5,
  lastChapterIdBytes: 512,
} as const;

/** UTF-8 byte length of one code point (surrogates count as 3, matching `TextEncoder`). */
function utf8Length(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/** UTF-8 byte length of a string, without allocating an encoder buffer. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const char of text) {
    bytes += utf8Length(char.codePointAt(0)!);
  }
  return bytes;
}

/**
 * Truncate to at most `maxBytes` UTF-8 bytes.
 * Iterates code points, so a surrogate pair (emoji, rare CJK) is kept or
 * dropped whole — never split into a lone half.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (!text || maxBytes <= 0) return "";
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = utf8Length(char.codePointAt(0)!);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return end >= text.length ? text : text.slice(0, end);
}

export function createEmptySeriesContext(seriesName = ""): SeriesContext {
  return {
    seriesName,
    summary: "",
    dictionary: "",
    lastChapterId: null,
    lastPageIndex: null,
    recentHistory: [],
    translatedCount: 0,
  };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeHistoryEntry(entry: unknown): SeriesContext["recentHistory"][number] | null {
  if (!entry || typeof entry !== "object") return null;
  const raw = entry as Record<string, unknown>;
  const text = asString(raw.text);
  if (!text.trim()) return null;
  return {
    chapterId: asString(raw.chapterId),
    pageIndex: asNumberOrNull(raw.pageIndex) ?? 0,
    text,
  };
}

/**
 * Apply every byte cap. Idempotent, so callers may cap on read *and* on write.
 * Newest history entries are always kept: an over-cap buffer sheds its oldest
 * entries one by one and never collapses to an empty history.
 */
export function capSeriesContext(context: SeriesContext): SeriesContext {
  const history: SeriesContext["recentHistory"] = [];
  for (const entry of (context.recentHistory ?? []).slice(
    -SERIES_CONTEXT_LIMITS.historyMaxEntries,
  )) {
    const normalized = normalizeHistoryEntry(entry);
    if (!normalized) continue;
    history.push({
      ...normalized,
      text: truncateUtf8(normalized.text, SERIES_CONTEXT_LIMITS.historyEntryBytes),
    });
  }

  let totalBytes = history.reduce(
    (sum, entry) => sum + utf8ByteLength(entry.text),
    0,
  );
  while (
    history.length > 1 &&
    totalBytes > SERIES_CONTEXT_LIMITS.historyTotalBytes
  ) {
    const dropped = history.shift()!;
    totalBytes -= utf8ByteLength(dropped.text);
  }

  const lastChapterId =
    typeof context.lastChapterId === "string"
      ? truncateUtf8(context.lastChapterId, SERIES_CONTEXT_LIMITS.lastChapterIdBytes)
      : null;

  return {
    seriesName: asString(context.seriesName),
    summary: truncateUtf8(
      asString(context.summary),
      SERIES_CONTEXT_LIMITS.summaryBytes,
    ),
    dictionary: truncateUtf8(
      asString(context.dictionary),
      SERIES_CONTEXT_LIMITS.dictionaryBytes,
    ),
    lastChapterId,
    lastPageIndex: asNumberOrNull(context.lastPageIndex),
    recentHistory: history,
    translatedCount:
      typeof context.translatedCount === "number" &&
      Number.isFinite(context.translatedCount) &&
      context.translatedCount > 0
        ? Math.floor(context.translatedCount)
        : 0,
  };
}

/**
 * Compose a context from the two storage halves.
 *
 * `seriesName` is the site-rule-derived fallback only: a non-empty stored name
 * wins so the user's "Series title override" field survives a reload.
 * Legacy stores embedded `recentHistory` inside the sync part — read it as a
 * fallback when the local history key is missing, then let the store migrate.
 */
export function seriesContextFromStored(
  sync: unknown,
  history: unknown,
  seriesName: string,
): SeriesContext {
  const stored = (sync && typeof sync === "object" ? sync : {}) as Record<
    string,
    unknown
  >;

  const storedName = asString(stored.seriesName).trim();
  const storedHistory = Array.isArray(stored.recentHistory)
    ? stored.recentHistory
    : [];

  return capSeriesContext({
    seriesName: storedName || asString(seriesName),
    summary: asString(stored.summary),
    dictionary: asString(stored.dictionary),
    lastChapterId:
      typeof stored.lastChapterId === "string" ? stored.lastChapterId : null,
    lastPageIndex: asNumberOrNull(stored.lastPageIndex),
    recentHistory: (Array.isArray(history) && history.length
      ? history
      : storedHistory) as SeriesContext["recentHistory"],
    translatedCount:
      typeof stored.translatedCount === "number" ? stored.translatedCount : 0,
  });
}

/** The `sync:` half. History must never appear here (8 KB item cap). */
export function toSyncPart(context: SeriesContext): SeriesContextSyncPart {
  const capped = capSeriesContext(context);
  return {
    seriesName: capped.seriesName,
    summary: capped.summary,
    dictionary: capped.dictionary,
    lastChapterId: capped.lastChapterId,
    lastPageIndex: capped.lastPageIndex,
    translatedCount: capped.translatedCount,
  };
}

/**
 * Persistence predicate (LMT-026): only a page whose boxes all translated is
 * allowed to write cache/history. A missing diagnostics object means the
 * response never went through the validator (empty OCR), which is not a
 * failure — treat it as clean.
 */
export function isCleanResult(
  diagnostics?: { clean?: boolean; untranslated?: number[] } | null,
): boolean {
  if (!diagnostics) return true;
  if (diagnostics.clean === true) return true;
  if (diagnostics.clean === false) return false;
  return !diagnostics.untranslated?.length;
}
