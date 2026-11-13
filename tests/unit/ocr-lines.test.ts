import { describe, expect, it } from "bun:test";
import {
  MIN_KEPT_LINE_SHARE,
  summarizeLineCounts,
} from "../../src/lib/ocr/accounting";

describe("summarizeLineCounts", () => {
  it("marks a box with no surviving line as failed", () => {
    expect(summarizeLineCounts(0, 3)).toEqual({
      failed: true,
      partial: false,
      keptLines: 0,
      droppedLines: 3,
    });
    // No lines and nothing dropped is still an empty box.
    expect(summarizeLineCounts(0, 0).failed).toBe(true);
  });

  it("does not mark a fully read box as partial", () => {
    const s = summarizeLineCounts(5, 0);
    expect(s.failed).toBe(false);
    expect(s.partial).toBe(false);
  });

  it("keeps a small loss below the threshold as a non-partial read", () => {
    // 4 of 5 kept = 0.8, comfortably above MIN_KEPT_LINE_SHARE.
    expect(summarizeLineCounts(4, 1).partial).toBe(false);
  });

  it("marks a box that lost at least half its lines as partial", () => {
    expect(summarizeLineCounts(1, 1).partial).toBe(true);
    expect(summarizeLineCounts(1, 2).partial).toBe(true);
    expect(summarizeLineCounts(3, 4).partial).toBe(true);
  });

  it("carries both counts so the UI can explain the loss", () => {
    expect(summarizeLineCounts(2, 3)).toEqual({
      failed: false,
      partial: true,
      keptLines: 2,
      droppedLines: 3,
    });
  });

  it("uses a half-loss threshold", () => {
    expect(MIN_KEPT_LINE_SHARE).toBe(0.5);
  });
});
