/**
 * Series-context storage (LMT-026).
 *
 * Split across two keys on purpose:
 *   sync:context-<series>            → settings + position (small, syncs)
 *   local:context-history-<series>   → recent dialogue buffer (large, local)
 *
 * The split fixes a real clobber: Sidebar/popup load the whole context at
 * mount and rewrite it ~150 ms after any keystroke, so a page translated in
 * between had its freshly appended history replaced by the mount-time copy.
 * `saveSeriesContextSettings` writes only the settings fields, so a stale UI
 * can no longer erase page history.
 *
 * `storage` is the WXT auto-imported global (same convention as `adapters.ts`).
 */

import {
  capSeriesContext,
  createEmptySeriesContext,
  isCleanResult,
  seriesContextFromStored,
  toSyncPart,
  type SeriesContextSyncPart,
} from "./series-context";

export const SYNC_CONTEXT_PREFIX = "sync:context-";
export const LOCAL_HISTORY_PREFIX = "local:context-history-";

export const syncContextKey = (seriesName: string) =>
  `${SYNC_CONTEXT_PREFIX}${seriesName}` as const;

export const localHistoryKey = (seriesName: string) =>
  `${LOCAL_HISTORY_PREFIX}${seriesName}` as const;

/**
 * Load both halves and compose them.
 *
 * Legacy stores kept `recentHistory` inside the sync item; when that is found
 * and the local key is empty, the history is copied to the local key and the
 * sync item is rewritten without it, once. Failures are non-fatal — a broken
 * migration must not break translation.
 */
export async function loadSeriesContext(
  seriesName: string,
): Promise<SeriesContext> {
  let syncPart: unknown;
  let history: unknown;
  try {
    const items = await storage.getItems([
      syncContextKey(seriesName),
      localHistoryKey(seriesName),
    ]);
    syncPart = items[0]?.value;
    history = items[1]?.value;
  } catch (err) {
    console.warn("LMT: series-context read failed:", err);
    return createEmptySeriesContext(seriesName);
  }

  const context = seriesContextFromStored(syncPart, history, seriesName);

  const legacyHistory = (syncPart as { recentHistory?: unknown } | undefined)
    ?.recentHistory;
  if (
    Array.isArray(legacyHistory) &&
    legacyHistory.length > 0 &&
    !(Array.isArray(history) && history.length > 0)
  ) {
    try {
      await storage.setItem(localHistoryKey(seriesName), context.recentHistory);
      await storage.setItem(syncContextKey(seriesName), toSyncPart(context));
    } catch (err) {
      console.warn("LMT: series-context legacy migration failed:", err);
    }
  }

  return context;
}

/**
 * UI save. Read-modify-write over the sync part so `lastChapterId`,
 * `lastPageIndex`, and `translatedCount` survive, and so history is never
 * touched at all.
 */
export async function saveSeriesContextSettings(
  seriesName: string,
  settings: { summary?: string; dictionary?: string; seriesName?: string },
): Promise<void> {
  return enqueue(seriesName, () => writeSettings(seriesName, settings));
}

async function writeSettings(
  seriesName: string,
  settings: { summary?: string; dictionary?: string; seriesName?: string },
): Promise<void> {
  let existing: SeriesContextSyncPart | null | undefined;
  try {
    existing = await storage.getItem<SeriesContextSyncPart>(
      syncContextKey(seriesName),
    );
  } catch (err) {
    console.warn("LMT: series-context settings read failed:", err);
  }

  const merged = capSeriesContext({
    ...createEmptySeriesContext(seriesName),
    ...(existing ?? {}),
    summary: settings.summary ?? existing?.summary ?? "",
    dictionary: settings.dictionary ?? existing?.dictionary ?? "",
    seriesName: settings.seriesName?.trim() || existing?.seriesName || seriesName,
  });

  await storage.setItem(syncContextKey(seriesName), toSyncPart(merged));
}

/** Drop both halves. Does not clear cached pages. */
export async function resetSeriesContext(seriesName: string): Promise<void> {
  await storage.removeItems([
    syncContextKey(seriesName),
    localHistoryKey(seriesName),
  ]);
}

export interface UpdateSeriesContextOptions {
  /** Caller detected a chapter jump or page gap. */
  resetHistory?: boolean;
  diagnostics?: { clean?: boolean; untranslated?: number[] } | null;
}

/**
 * Per-series write queue. Auto-translate can run several pages at once, and
 * each update is a read-modify-write over the same two keys — without this,
 * two concurrent pages both load the same history and the later write drops
 * the other page's entry.
 */
const seriesQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(seriesName: string, task: () => Promise<T>): Promise<T> {
  const tail = seriesQueues.get(seriesName) ?? Promise.resolve();
  const run = tail.then(task, task);
  seriesQueues.set(
    seriesName,
    run.catch(() => {}),
  );
  return run;
}

/**
 * Record a translated page.
 *
 * A dirty page (any echoed/untranslated box) still advances the position so
 * the next clean page stays "continuous" — otherwise one echoed box would
 * silently wipe the whole history buffer via the reset path. It just refuses
 * to append history, bump the counter, or accept model-written settings.
 */
export async function updateSeriesContext(
  seriesName: string,
  chapterId: string,
  pageIndex: number,
  translations: Translations,
  context?: { summary?: string; dictionary?: string },
  options: UpdateSeriesContextOptions = {},
): Promise<SeriesContext> {
  return enqueue(seriesName, () =>
    writeSeriesContext(seriesName, chapterId, pageIndex, translations, context, options),
  );
}

async function writeSeriesContext(
  seriesName: string,
  chapterId: string,
  pageIndex: number,
  translations: Translations,
  context: { summary?: string; dictionary?: string } | undefined,
  options: UpdateSeriesContextOptions,
): Promise<SeriesContext> {
  const { resetHistory = false, diagnostics } = options;
  const clean = isCleanResult(diagnostics);

  const current = await loadSeriesContext(seriesName);

  const next = capSeriesContext({
    ...current,
    lastChapterId: chapterId,
    lastPageIndex: Number.isFinite(pageIndex) ? pageIndex : current.lastPageIndex,
    summary: clean
      ? (context?.summary ?? current.summary)
      : current.summary,
    dictionary: clean
      ? (context?.dictionary ?? current.dictionary)
      : current.dictionary,
    translatedCount: clean ? current.translatedCount + 1 : current.translatedCount,
    recentHistory: resetHistory ? [] : current.recentHistory,
  });

  if (clean) {
    const text = translations
      .filter((t) => typeof t === "string" && t.trim().length > 0)
      .join(" | ");
    if (text) {
      next.recentHistory = capSeriesContext({
        ...next,
        recentHistory: [
          ...next.recentHistory,
          { chapterId, pageIndex, text },
        ],
      }).recentHistory;
    }
  }

  try {
    await storage.setItem(syncContextKey(seriesName), toSyncPart(next));
    await storage.setItem(localHistoryKey(seriesName), next.recentHistory);
  } catch (err) {
    console.warn("LMT: series-context update failed:", err);
  }

  return next;
}
