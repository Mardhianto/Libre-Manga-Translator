import { beforeEach, describe, expect, it } from "bun:test";
import {
  LOCAL_HISTORY_PREFIX,
  SYNC_CONTEXT_PREFIX,
  loadSeriesContext,
  resetSeriesContext,
  updateSeriesContext,
} from "../../src/lib/series-context-store";
import { SERIES_CONTEXT_LIMITS } from "../../src/lib/series-context";

/**
 * The store is a thin read-modify-write over `storage`, which WXT injects as a
 * global. Stubbing it with a Map exercises the real read/write path — the
 * merge, the caps, the queue — instead of a mock of the store itself.
 */
function installFakeStorage() {
  const map = new Map<string, unknown>();
  const storage = {
    async getItem<T>(key: string): Promise<T | null> {
      return (map.has(key) ? map.get(key) : null) as T | null;
    },
    async getItems(keys: string[]) {
      return keys.map((key) => ({
        key,
        value: map.has(key) ? map.get(key) : null,
      }));
    },
    async setItem(key: string, value: unknown) {
      map.set(key, value);
    },
    async removeItems(keys: string[]) {
      for (const key of keys) map.delete(key);
    },
  };
  (globalThis as { storage?: unknown }).storage = storage;
  return map;
}

let backing: Map<string, unknown>;

beforeEach(() => {
  backing = installFakeStorage();
});

/** Read the raw local half, which is where history lives. */
function rawHistory(seriesName: string) {
  return backing.get(`${LOCAL_HISTORY_PREFIX}${seriesName}`) as
    | { chapterId: string; pageIndex: number; text: string }[]
    | undefined;
}

function rawSync(seriesName: string) {
  return backing.get(`${SYNC_CONTEXT_PREFIX}${seriesName}`) as
    | { translatedCount: number; lastPageIndex: number | null }
    | undefined;
}

const SERIES = "Test Series";

/**
 * Seed pages 1..n of one chapter, exactly as successive clean translates would.
 */
async function seedPages(count: number, chapterId = "chapter-1") {
  for (let page = 1; page <= count; page++) {
    await updateSeriesContext(
      SERIES,
      chapterId,
      page,
      [`page ${page} line one`, `page ${page} line two`],
      undefined,
      { resetHistory: false, diagnostics: { clean: true } },
    );
  }
}

describe("updateSeriesContext (LMT-031)", () => {
  it("keeps every other page's history when the same page is re-run", async () => {
    await seedPages(4);
    const before = rawHistory(SERIES)!;
    const beforeCount = rawSync(SERIES)!.translatedCount;

    // Refine Boxes -> Translate on page 4: the page that was just finished.
    // The caller derives `resetHistory` from "is this the next page?", which is
    // false here, so it asks for a reset — that request must be ignored.
    await updateSeriesContext(
      SERIES,
      "chapter-1",
      4,
      ["rerun line one", "rerun line two"],
      undefined,
      { resetHistory: true, diagnostics: { clean: true } },
    );

    const after = rawHistory(SERIES)!;

    // Every earlier page survives, in order.
    expect(after.map((e) => e.pageIndex)).toEqual([1, 2, 3, 4]);
    expect(after.slice(0, 3)).toEqual(before.slice(0, 3));

    // ...and the re-run did not count the page a second time.
    expect(rawSync(SERIES)!.translatedCount).toBe(beforeCount);
  });

  it("counts a page once however many times it is translated", async () => {
    // The row's acceptance: two updates for the same page, count +1 (not +2).
    await updateSeriesContext(SERIES, "chapter-1", 1, ["first pass"], undefined, {
      resetHistory: false,
      diagnostics: { clean: true },
    });
    await updateSeriesContext(SERIES, "chapter-1", 1, ["second pass"], undefined, {
      resetHistory: false,
      diagnostics: { clean: true },
    });

    expect(rawSync(SERIES)!.translatedCount).toBe(1);
    expect(rawHistory(SERIES)).toHaveLength(1);
    expect(rawHistory(SERIES)![0].text).toBe("second pass");
  });

  it("replaces the re-run page's text in place, without duplicating it", async () => {
    await seedPages(3);

    await updateSeriesContext(
      SERIES,
      "chapter-1",
      3,
      ["corrected line"],
      undefined,
      { resetHistory: true, diagnostics: { clean: true } },
    );

    const after = rawHistory(SERIES)!;
    expect(after).toHaveLength(3);
    expect(after.filter((e) => e.pageIndex === 3)).toHaveLength(1);
    expect(after[2].text).toBe("corrected line");
  });

  it("does not consume a history slot on a re-run", async () => {
    // Fill the buffer to its entry cap, then re-run the newest page.
    await seedPages(SERIES_CONTEXT_LIMITS.historyMaxEntries);
    const before = rawHistory(SERIES)!;

    await updateSeriesContext(
      SERIES,
      "chapter-1",
      SERIES_CONTEXT_LIMITS.historyMaxEntries,
      ["rerun"],
      undefined,
      { resetHistory: true, diagnostics: { clean: true } },
    );

    const after = rawHistory(SERIES)!;
    // A blind append would have evicted page 1 here.
    expect(after.map((e) => e.pageIndex)).toEqual(
      before.map((e) => e.pageIndex),
    );
    expect(after).toHaveLength(SERIES_CONTEXT_LIMITS.historyMaxEntries);
  });

  it("still resets history on a real chapter jump", async () => {
    await seedPages(3);

    await updateSeriesContext(
      SERIES,
      "chapter-2",
      1,
      ["new chapter"],
      undefined,
      { resetHistory: true, diagnostics: { clean: true } },
    );

    const after = rawHistory(SERIES)!;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ chapterId: "chapter-2", pageIndex: 1 });
  });

  it("still resets history on a page gap inside one chapter", async () => {
    await seedPages(3);

    // Page 4 translated, then the reader jumps back to page 9 of the same
    // chapter: the sequence is broken, so the buffer starts over.
    await updateSeriesContext(
      SERIES,
      "chapter-1",
      9,
      ["far ahead"],
      undefined,
      { resetHistory: true, diagnostics: { clean: true } },
    );

    const after = rawHistory(SERIES)!;
    expect(after).toHaveLength(1);
    expect(after[0].pageIndex).toBe(9);
  });

  it("appends normally on a continuation page", async () => {
    await seedPages(2);

    await updateSeriesContext(
      SERIES,
      "chapter-1",
      3,
      ["page 3"],
      undefined,
      { resetHistory: false, diagnostics: { clean: true } },
    );

    expect(rawHistory(SERIES)!.map((e) => e.pageIndex)).toEqual([1, 2, 3]);
  });

  it("neither counts nor records a dirty page", async () => {
    await seedPages(2);
    const before = rawHistory(SERIES)!;
    const beforeCount = rawSync(SERIES)!.translatedCount;

    await updateSeriesContext(
      SERIES,
      "chapter-1",
      3,
      ["echoed source"],
      undefined,
      { resetHistory: false, diagnostics: { clean: false, untranslated: [0] } },
    );

    expect(rawHistory(SERIES)).toEqual(before);
    expect(rawSync(SERIES)!.translatedCount).toBe(beforeCount);
    // ...but the position still advances, so the next page is continuous.
    expect(rawSync(SERIES)!.lastPageIndex).toBe(3);
  });

  it("refuses model-written settings from a dirty page", async () => {
    await updateSeriesContext(
      SERIES,
      "chapter-1",
      1,
      ["ok"],
      { summary: "good summary", dictionary: "A -> B" },
      { resetHistory: false, diagnostics: { clean: true } },
    );

    await updateSeriesContext(
      SERIES,
      "chapter-1",
      2,
      ["echo"],
      { summary: "poisoned", dictionary: "X -> Y" },
      { resetHistory: false, diagnostics: { clean: false, untranslated: [0] } },
    );

    const context = await loadSeriesContext(SERIES);
    expect(context.summary).toBe("good summary");
    expect(context.dictionary).toBe("A -> B");
  });

  it("survives a re-run after a reset dropped the entry", async () => {
    await seedPages(2);
    await resetSeriesContext(SERIES);

    // Nothing stored: this is a first run, not a re-run.
    await updateSeriesContext(
      SERIES,
      "chapter-1",
      1,
      ["fresh"],
      undefined,
      { resetHistory: true, diagnostics: { clean: true } },
    );

    expect(rawHistory(SERIES)!.map((e) => e.pageIndex)).toEqual([1]);
    expect(rawSync(SERIES)!.translatedCount).toBe(1);
  });
});

describe("updateSeriesContext queue", () => {
  it("serialises concurrent pages so neither loses the other's entry", async () => {
    // Both read the same empty context before either writes.
    await Promise.all([
      updateSeriesContext(SERIES, "chapter-1", 1, ["one"], undefined, {
        resetHistory: false,
        diagnostics: { clean: true },
      }),
      updateSeriesContext(SERIES, "chapter-1", 2, ["two"], undefined, {
        resetHistory: false,
        diagnostics: { clean: true },
      }),
    ]);

    expect(rawHistory(SERIES)!.map((e) => e.pageIndex)).toEqual([1, 2]);
    expect(rawSync(SERIES)!.translatedCount).toBe(2);
  });
});
