import { describe, expect, it } from "bun:test";
import {
  countUntranslated,
  keepBetterTranslation,
  untranslatedCorrectionPrompt,
} from "../../src/lib/server/correction";

describe("untranslatedCorrectionPrompt", () => {
  it("returns an empty string when nothing is flagged", () => {
    expect(untranslatedCorrectionPrompt([])).toBe("");
  });

  it("formats a single box correction", () => {
    const prompt = untranslatedCorrectionPrompt([0]);
    expect(prompt).toContain("Box 1 did not come back");
    expect(prompt).toContain("Translate that box properly");
  });

  it("formats multiple boxes correction", () => {
    const prompt = untranslatedCorrectionPrompt([0, 2, 4]);
    expect(prompt).toContain("Box 1, Box 3, Box 5 did not come back");
    expect(prompt).toContain("Translate those boxes properly");
  });

  it("caps long lists to 12 boxes with 'and X more'", () => {
    const indices = Array.from({ length: 15 }, (_, i) => i);
    const prompt = untranslatedCorrectionPrompt(indices);
    expect(prompt).toContain("Box 1, Box 2, Box 3");
    expect(prompt).toContain("and 3 more");
  });
});

describe("countUntranslated", () => {
  it("returns 0 when diagnostics or untranslated is missing or empty", () => {
    expect(countUntranslated({})).toBe(0);
    expect(countUntranslated({ diagnostics: null })).toBe(0);
    expect(countUntranslated({ diagnostics: { untranslated: [] } })).toBe(0);
  });

  it("returns the number of untranslated items", () => {
    expect(countUntranslated({ diagnostics: { untranslated: [1, 2] } })).toBe(2);
  });
});

describe("keepBetterTranslation", () => {
  it("keeps the second result if it has fewer untranslated items", () => {
    const first = { translations: ["A", ""], diagnostics: { untranslated: [1] } };
    const second = { translations: ["A", "B"], diagnostics: { untranslated: [] } };
    expect(keepBetterTranslation(first, second)).toBe(second);
  });

  it("keeps the first result if the second regressed (more untranslated)", () => {
    const first = { translations: ["A", ""], diagnostics: { untranslated: [1] } };
    const second = { translations: ["", ""], diagnostics: { untranslated: [0, 1] } };
    expect(keepBetterTranslation(first, second)).toBe(first);
  });

  it("keeps the first result on tie (no improvement)", () => {
    const first = { translations: ["A", ""], diagnostics: { untranslated: [1] } };
    const second = { translations: ["A", ""], diagnostics: { untranslated: [1] } };
    expect(keepBetterTranslation(first, second)).toBe(first);
  });
});
