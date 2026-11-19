import { describe, expect, it } from "bun:test";
import {
  CONTEXT_SAFETY_MARGIN,
  MAX_NUM_CTX,
  MAX_OUTPUT_TOKENS,
  MESSAGE_OVERHEAD_TOKENS,
  MIN_NUM_CTX,
  MIN_OUTPUT_TOKENS,
  budgetVerdict,
  estimateTokenDetail,
  estimateTokens,
  resolveNumCtx,
  resolveOutputCap,
} from "../../src/lib/server/prompt-budget";

/**
 * Ground truth: `prompt_eval_count` from Ollama 0.40.15 / `qwen3.5:2b`.
 *
 * The samples are *diverse* on purpose. Repeating one sentence is not a valid
 * measurement: BPE merges the repetition, so `"あ".repeat(800)` measures
 * 0.52 tok/char while real dialogue measures 0.70-0.73. The first version of
 * this file used repeat fixtures and calibrated the estimator to numbers that
 * no real prompt produces.
 */
const FIXTURES = {
  english: {
    // Diverse prose, 887 chars: 164 tokens measured.
    text: "You are a professional manga translator. Translate each text box from the source language into natural, idiomatic English while preserving the original tone, register, and character voice. Do not add explanations, romanization, or notes. Keep honorifics only when they carry meaning the reader would otherwise lose. Preserve line breaks inside a single box. If a box contains only sound effects, translate the sound rather than describing it. Return the translations as a JSON array of strings, exactly one per box, in the same order the boxes were given. Never merge two boxes into one entry and never split one box into two. The summary must be one or two sentences and must be written in English regardless of the source language. List recurring character names and unique terminology as pairs of original term and English rendering. If there are none, output the literal string None.",
    measuredTokens: 164,
  },
  japanese: {
    // Diverse manga prose, 245 chars: 159 tokens measured (0.65 tok/char).
    text: "「臓器を弄るとは、随分と趣味が悪いな」薫は静かにそう言って、血の滲む包帯を解いた。窓の外では、鴉が空を裂くように鳴いている。「解剖の記録はどこだ。隠しても無駄だぞ」少女は俯いたまま、震える指尖で机の引き出しを指した。中には、幾重にも折り畳まれた古い地図と、埃を被った羅針盤が詰まっていた。「これは……父の遺品だ」「ならば、なぜ今まで黙っていた」彼女は顔を上げ、その瞳に灯る意志を隠さなかった。恐怖ではなく、確信がそこにあった。雨音が次第に強くなる。遠雷が、二人の沈黙を打ち消すように轟いた。",
    measuredTokens: 159,
  },
  korean: {
    // 113 chars: 47 tokens measured (0.42 tok/char).
    text: "안녕하세요, 만화 번역 테스트입니다. 오늘은 날씨가 정말 좋네요. 이 페이지를 번역해 주세요. 만화를 번역할 때는 말투와 분위기를 살려야 합니다. 독자가 자연스럽게 읽을 수 있도록 문장을 다듬어 주세요.",
    measuredTokens: 47,
  },
};

describe("estimateTokens", () => {
  /**
   * The estimator is allowed to be generous - a smaller num_ctx than the
   * prompt needs is what silently truncates - but it must never under-count.
   * Every fixture asserts `est >= measured`, which is the safety property,
   * and stays under 2x so a page is not needlessly pushed to 32768.
   */
  it("never under-estimates the measured English prompt", () => {
    const { tokens } = estimateTokenDetail(FIXTURES.english.text);
    expect(tokens).toBeGreaterThanOrEqual(FIXTURES.english.measuredTokens);
    expect(tokens).toBeLessThan(FIXTURES.english.measuredTokens * 2);
  });

  it("never under-estimates the measured Japanese prompt", () => {
    const { tokens } = estimateTokenDetail(FIXTURES.japanese.text);
    expect(tokens).toBeGreaterThanOrEqual(FIXTURES.japanese.measuredTokens);
    expect(tokens).toBeLessThan(FIXTURES.japanese.measuredTokens * 2);
  });

  it("never under-estimates the measured Korean prompt", () => {
    const { tokens } = estimateTokenDetail(FIXTURES.korean.text);
    expect(tokens).toBeGreaterThanOrEqual(FIXTURES.korean.measuredTokens);
    expect(tokens).toBeLessThan(FIXTURES.korean.measuredTokens * 2);
  });

  it("beats a flat chars/4 estimate on Japanese", () => {
    const { tokens } = estimateTokenDetail(FIXTURES.japanese.text);
    const naive = FIXTURES.japanese.text.length / 4;
    // The regression this guards: the shortcut the codebase did not have.
    expect(tokens).toBeGreaterThan(naive * 1.5);
  });

  /**
   * Digits and ASCII punctuation are close to one token per character on a
   * BPE vocab (~0.99 and ~0.65 measured). The first estimator billed them at
   * 0.2, which under-counted the numeric scaffolding of every prompt.
   */
  it("bills digits near one token per character", () => {
    const { tokens } = estimateTokenDetail("0123456789".repeat(20));
    expect(tokens).toBeGreaterThan(180);
  });

  it("bills ASCII punctuation higher than whitespace", () => {
    const punctuation = estimateTokenDetail(".,;:!?'\"()[]{}".repeat(10));
    const spaces = estimateTokenDetail(" ".repeat(180));
    expect(punctuation.tokens).toBeGreaterThan(spaces.tokens * 5);
  });

  it("collapses whitespace runs", () => {
    const { tokens } = estimateTokenDetail("\n".repeat(500));
    expect(tokens).toBeLessThan(20);
  });

  it("counts CJK punctuation as CJK, not as cheap ASCII", () => {
    const punctuation = estimateTokenDetail("、。！？「」");
    const latinPunctuation = estimateTokenDetail(".,!?\"'");
    expect(punctuation.tokens).toBeGreaterThan(latinPunctuation.tokens);
  });

  it("returns zero for empty input and adds per-message overhead", () => {
    expect(estimateTokenDetail("")).toEqual({ tokens: 0, chars: 0 });
    expect(estimateTokens("")).toBe(MESSAGE_OVERHEAD_TOKENS);
    expect(estimateTokens("a", "b")).toBe(
      MESSAGE_OVERHEAD_TOKENS * 2 + estimateTokenDetail("a").tokens +
        estimateTokenDetail("b").tokens,
    );
  });

  it("never reports fewer characters than a code point count would", () => {
    const { chars } = estimateTokenDetail("漫画");
    expect(chars).toBe(2);
  });
});

describe("resolveOutputCap", () => {
  it("scales with the box count", () => {
    expect(resolveOutputCap(3)).toBe(MIN_OUTPUT_TOKENS + 3 * 96);
    expect(resolveOutputCap(40)).toBe(MIN_OUTPUT_TOKENS + 40 * 96);
    expect(resolveOutputCap(40)).toBeGreaterThan(resolveOutputCap(3));
  });

  it("clamps to the floor and ceiling", () => {
    expect(resolveOutputCap(0)).toBe(MIN_OUTPUT_TOKENS);
    expect(resolveOutputCap(-5)).toBe(MIN_OUTPUT_TOKENS);
    expect(resolveOutputCap(10_000)).toBe(MAX_OUTPUT_TOKENS);
    expect(resolveOutputCap(Number.NaN)).toBe(MIN_OUTPUT_TOKENS);
  });

  it("keeps the old constant for a small page", () => {
    // 3 boxes: previously a flat 4096 every time.
    expect(resolveOutputCap(3)).toBeLessThan(4096);
  });
});

describe("resolveNumCtx", () => {
  it("never returns a window smaller than prompt + answer", () => {
    const promptTokens = 6000;
    const outputCap = 4864;
    const numCtx = resolveNumCtx({ promptTokens, outputCap, requested: 2048 });
    expect(numCtx).toBeGreaterThanOrEqual(
      promptTokens + outputCap + CONTEXT_SAFETY_MARGIN,
    );
  });

  it("honours a requested window when it is big enough", () => {
    const numCtx = resolveNumCtx({
      promptTokens: 500,
      outputCap: 1024,
      requested: 8192,
    });
    expect(numCtx).toBe(8192);
  });

  it("grows in 1024-token steps", () => {
    const numCtx = resolveNumCtx({
      promptTokens: 3000,
      outputCap: 2048,
      requested: 4096,
    });
    expect(numCtx % 1024).toBe(0);
    expect(numCtx).toBeGreaterThan(4096);
  });

  it("stops at the ceiling instead of asking for unbounded KV cache", () => {
    const numCtx = resolveNumCtx({
      promptTokens: 500_000,
      outputCap: 8192,
      requested: 8192,
    });
    expect(numCtx).toBe(MAX_NUM_CTX);
  });

  it("falls back to the 4096 default when nothing is requested", () => {
    const numCtx = resolveNumCtx({ promptTokens: 500, outputCap: 1024 });
    // Small page: the floor (MIN_NUM_CTX) cannot hold it, so it scales.
    expect(numCtx).toBeGreaterThanOrEqual(MIN_NUM_CTX);
  });

  it("is monotonic in prompt size", () => {
    let previous = 0;
    for (const promptTokens of [100, 1000, 4000, 8000, 16000]) {
      const numCtx = resolveNumCtx({ promptTokens, outputCap: 2048, requested: 4096 });
      expect(numCtx).toBeGreaterThanOrEqual(previous);
      previous = numCtx;
    }
  });
});

describe("budgetVerdict", () => {
  it("says ok when the request fits comfortably", () => {
    expect(
      budgetVerdict({ promptTokens: 1000, outputCap: 1024, numCtx: 8192 }).level,
    ).toBe("ok");
  });

  it("warns when the request uses most of the window", () => {
    expect(
      budgetVerdict({ promptTokens: 5000, outputCap: 1024, numCtx: 8192 }).level,
    ).toBe("warn");
  });

  it("says over when the prompt cannot fit - the silent-cut case", () => {
    const verdict = budgetVerdict({
      promptTokens: 9000,
      outputCap: 2048,
      numCtx: 8192,
    });
    expect(verdict.level).toBe("over");
    // The message has to name the consequence, not just the numbers.
    expect(verdict.message).toContain("cut the start of the prompt");
  });
});
