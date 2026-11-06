import { describe, expect, it } from "bun:test";
import { DefaultConfig } from "../../src/lib/configs";
import { resolveJobGuardTimeout, resolveJobTimeout } from "../../src/lib/timeouts";

describe("resolveJobTimeout", () => {
  it("gives local translation a flat, generous page budget", () => {
    expect(resolveJobTimeout({ type: "TRANSLATE_IMAGE", mode: "webgpu" })).toBe(
      DefaultConfig.timeoutLocalTranslateMs,
    );
    // No mode means the default (local) path, not the API one.
    expect(resolveJobTimeout({ type: "TRANSLATE_IMAGE" })).toBe(
      DefaultConfig.timeoutLocalTranslateMs,
    );
    // Box count must not shrink or inflate a local budget.
    expect(
      resolveJobTimeout({ type: "TRANSLATE_IMAGE", mode: "webgpu", boxes: 50 }),
    ).toBe(DefaultConfig.timeoutLocalTranslateMs);
  });

  it("scales the API translate budget with box count", () => {
    const base = DefaultConfig.timeoutApiTranslateMs;
    const perBox = DefaultConfig.timeoutApiTranslatePerBoxMs;

    // Sparse page: the floor wins.
    expect(
      resolveJobTimeout({ type: "TRANSLATE_IMAGE", mode: "api", boxes: 0 }),
    ).toBe(base);
    expect(
      resolveJobTimeout({ type: "TRANSLATE_IMAGE", mode: "api", boxes: 2 }),
    ).toBe(base);

    // Dense page: the per-box term wins (a 40-box page gets 600s).
    const dense = resolveJobTimeout({
      type: "TRANSLATE_IMAGE",
      mode: "api",
      boxes: 40,
    });
    expect(dense).toBe(40 * perBox);
    expect(dense).toBeGreaterThan(base);
  });

  it("is monotonic in box count", () => {
    let previous = 0;
    for (const boxes of [0, 1, 5, 12, 40, 120]) {
      const current = resolveJobTimeout({
        type: "TRANSLATE_IMAGE",
        mode: "api",
        boxes,
      });
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });

  it("keeps a Gemini translate budget distinct from API", () => {
    expect(
      resolveJobTimeout({ type: "TRANSLATE_IMAGE", mode: "gemini", boxes: 40 }),
    ).toBe(DefaultConfig.timeoutGeminiTranslateMs);
  });

  it("keeps the quality inpaint floor and per-region budget", () => {
    expect(
      resolveJobTimeout({ type: "INPAINT_IMAGE", method: "quality" }),
    ).toBe(DefaultConfig.timeoutQualityInpaintMs);
    // 20 regions x 60s = 20 min, well over the 5 min floor.
    expect(
      resolveJobTimeout({ type: "INPAINT_IMAGE", method: "quality", boxes: 20 }),
    ).toBe(20 * DefaultConfig.timeoutQualityInpaintPerBoxMs);
  });

  it("does not give Fast inpaint the quality budget", () => {
    expect(
      resolveJobTimeout({ type: "INPAINT_IMAGE", method: "fast", boxes: 40 }),
    ).toBe(DefaultConfig.timeoutInpaintMs);
  });

  it("falls back to the short budget for single calls", () => {
    expect(resolveJobTimeout({ type: "DETECT_BBOX" })).toBe(
      DefaultConfig.timeoutShortJobMs,
    );
    expect(resolveJobTimeout({ type: "MAKE_SITE_RULE_AI" })).toBe(
      DefaultConfig.timeoutShortJobMs,
    );
  });

  it("ignores nonsense box counts instead of producing NaN", () => {
    for (const boxes of [Number.NaN, -5, 3.7, Number.POSITIVE_INFINITY]) {
      const value = resolveJobTimeout({
        type: "TRANSLATE_IMAGE",
        mode: "api",
        boxes,
      });
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });
});

describe("resolveJobGuardTimeout", () => {
  it("always outlasts the deadline it guards", () => {
    const budget = resolveJobTimeout({
      type: "TRANSLATE_IMAGE",
      mode: "api",
      boxes: 40,
    });
    expect(resolveJobGuardTimeout(budget)).toBe(
      budget + DefaultConfig.timeoutGuardGraceMs,
    );
    expect(resolveJobGuardTimeout(budget)).toBeGreaterThan(budget);
  });
});
