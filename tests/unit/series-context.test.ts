import { describe, expect, it } from "bun:test";
import {
  SERIES_CONTEXT_LIMITS,
  capSeriesContext,
  createEmptySeriesContext,
  isCleanResult,
  seriesContextFromStored,
  toSyncPart,
  truncateUtf8,
  utf8ByteLength,
} from "../../src/lib/series-context";

const bytes = (text: string) => new TextEncoder().encode(text).length;

describe("truncateUtf8", () => {
  it("never splits a surrogate pair", () => {
    // Each emoji is 4 UTF-8 bytes / 2 UTF-16 code units.
    const text = "😀😀😀😀😀";
    for (let max = 0; max <= 24; max++) {
      const cut = truncateUtf8(text, max);
      expect(bytes(cut)).toBeLessThanOrEqual(max);
      // No lone surrogate anywhere: every code unit pair is intact.
      expect(cut).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      );
      expect(cut).toBe("😀".repeat(Math.min(5, Math.floor(max / 4))));
    }
  });

  it("keeps 3-byte CJK whole", () => {
    const text = "あいうえお";
    expect(truncateUtf8(text, 7)).toBe("あい");
    expect(bytes(truncateUtf8(text, 7))).toBeLessThanOrEqual(7);
  });

  it("returns the input unchanged when it fits", () => {
    expect(truncateUtf8("hello", 100)).toBe("hello");
    expect(truncateUtf8("", 100)).toBe("");
    expect(truncateUtf8("hello", 0)).toBe("");
  });

  it("measures multi-byte text the way TextEncoder does", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("あ")).toBe(3);
    expect(utf8ByteLength("😀")).toBe(4);
    expect(utf8ByteLength("aあ😀")).toBe(bytes("aあ😀"));
  });
});

describe("capSeriesContext", () => {
  it("caps summary and dictionary at 2000 UTF-8 bytes", () => {
    const capped = capSeriesContext({
      ...createEmptySeriesContext("S"),
      summary: "日".repeat(2000),
      dictionary: "a".repeat(5000),
    });
    expect(bytes(capped.summary)).toBeLessThanOrEqual(
      SERIES_CONTEXT_LIMITS.summaryBytes,
    );
    expect(bytes(capped.dictionary)).toBeLessThanOrEqual(
      SERIES_CONTEXT_LIMITS.dictionaryBytes,
    );
    expect(capped.dictionary).toHaveLength(
      SERIES_CONTEXT_LIMITS.dictionaryBytes,
    );
  });

  it("keeps 5 newest entries, trims each to 1200 bytes, total ≤ 6000", () => {
    const entries = Array.from({ length: 7 }, (_, i) => ({
      chapterId: `c${i}`,
      pageIndex: i,
      text: `page-${i}`,
    }));
    const capped = capSeriesContext({
      ...createEmptySeriesContext("S"),
      recentHistory: entries,
    });

    expect(capped.recentHistory).toHaveLength(
      SERIES_CONTEXT_LIMITS.historyMaxEntries,
    );
    expect(capped.recentHistory.at(-1)?.text).toBe("page-6");
    expect(capped.recentHistory[0].text).toBe("page-2");
    for (const entry of capped.recentHistory) {
      expect(bytes(entry.text)).toBeLessThanOrEqual(
        SERIES_CONTEXT_LIMITS.historyEntryBytes,
      );
    }
    const total = capped.recentHistory.reduce(
      (sum, entry) => sum + bytes(entry.text),
      0,
    );
    expect(total).toBeLessThanOrEqual(SERIES_CONTEXT_LIMITS.historyTotalBytes);
  });

  it("trims over-cap history instead of dropping it wholesale", () => {
    const big = "あ".repeat(500); // 1500 bytes each
    const capped = capSeriesContext({
      ...createEmptySeriesContext("S"),
      recentHistory: Array.from({ length: 5 }, (_, i) => ({
        chapterId: "c",
        pageIndex: i,
        text: big,
      })),
    });
    expect(capped.recentHistory.length).toBeGreaterThan(0);
    const total = capped.recentHistory.reduce(
      (sum, entry) => sum + bytes(entry.text),
      0,
    );
    expect(total).toBeLessThanOrEqual(SERIES_CONTEXT_LIMITS.historyTotalBytes);
    // The newest entry always survives a trim.
    expect(capped.recentHistory.at(-1)?.pageIndex).toBe(4);
  });

  it("caps lastChapterId at 512 bytes", () => {
    const capped = capSeriesContext({
      ...createEmptySeriesContext("S"),
      lastChapterId: "x".repeat(1000),
    });
    expect(bytes(capped.lastChapterId!)).toBeLessThanOrEqual(
      SERIES_CONTEXT_LIMITS.lastChapterIdBytes,
    );
  });

  it("is idempotent", () => {
    const once = capSeriesContext({
      ...createEmptySeriesContext("S"),
      summary: "あ".repeat(1000),
      recentHistory: [{ chapterId: "c", pageIndex: 1, text: "あ".repeat(900) }],
    });
    expect(capSeriesContext(once)).toEqual(once);
  });

  it("drops history entries with blank text", () => {
    const capped = capSeriesContext({
      ...createEmptySeriesContext("S"),
      recentHistory: [{ chapterId: "c", pageIndex: 0, text: "   " }],
    });
    expect(capped.recentHistory).toEqual([]);
  });
});

describe("seriesContextFromStored", () => {
  it("reads recentHistory from the local half", () => {
    const ctx = seriesContextFromStored(
      { summary: "sum", dictionary: "dict", translatedCount: 3 },
      [{ chapterId: "c1", pageIndex: 2, text: "hello" }],
      "Series",
    );
    expect(ctx.summary).toBe("sum");
    expect(ctx.dictionary).toBe("dict");
    expect(ctx.translatedCount).toBe(3);
    expect(ctx.recentHistory).toEqual([
      { chapterId: "c1", pageIndex: 2, text: "hello" },
    ]);
  });

  it("falls back to legacy sync.recentHistory", () => {
    const ctx = seriesContextFromStored(
      {
        summary: "legacy",
        recentHistory: [{ chapterId: "old", pageIndex: 0, text: "legacy line" }],
      },
      undefined,
      "Series",
    );
    expect(ctx.recentHistory).toEqual([
      { chapterId: "old", pageIndex: 0, text: "legacy line" },
    ]);
  });

  it("prefers the stored series name override over the derived key", () => {
    expect(
      seriesContextFromStored({ seriesName: "My Override" }, [], "From Url")
        .seriesName,
    ).toBe("My Override");
    expect(seriesContextFromStored({}, [], "From Url").seriesName).toBe(
      "From Url",
    );
    expect(
      seriesContextFromStored({ seriesName: "   " }, [], "From Url").seriesName,
    ).toBe("From Url");
  });

  it("survives junk stored values", () => {
    const ctx = seriesContextFromStored(null, "not-an-array", "S");
    expect(ctx).toEqual(createEmptySeriesContext("S"));
    expect(capSeriesContext(seriesContextFromStored(42, {}, "S"))).toEqual(
      createEmptySeriesContext("S"),
    );
  });
});

describe("toSyncPart", () => {
  it("never contains recentHistory", () => {
    const sync = toSyncPart({
      ...createEmptySeriesContext("S"),
      recentHistory: [{ chapterId: "c", pageIndex: 0, text: "secret" }],
    });
    expect("recentHistory" in sync).toBe(false);
    expect(JSON.stringify(sync)).not.toContain("secret");
  });

  it("fits the sync byte budget with maximal content", () => {
    const sync = toSyncPart({
      ...createEmptySeriesContext("S"),
      summary: "あ".repeat(5000),
      dictionary: "あ".repeat(5000),
      lastChapterId: "あ".repeat(500),
    });
    expect(bytes(JSON.stringify(sync))).toBeLessThan(8000);
  });
});

describe("isCleanResult", () => {
  it("rejects results with untranslated boxes", () => {
    expect(isCleanResult({ clean: false, untranslated: [0] })).toBe(false);
    expect(isCleanResult({ untranslated: [2, 4] })).toBe(false);
  });

  it("accepts clean and absent diagnostics", () => {
    expect(isCleanResult({ clean: true, untranslated: [] })).toBe(true);
    expect(isCleanResult({ untranslated: [] })).toBe(true);
    expect(isCleanResult(undefined)).toBe(true);
    expect(isCleanResult(null)).toBe(true);
  });
});
