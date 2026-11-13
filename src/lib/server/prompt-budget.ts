/**
 * Prompt-size budgeting for API Mode (LMT-024).
 *
 * Ollama's OpenAI-compatible `/v1/chat/completions` cannot set `num_ctx`, so an
 * over-long prompt is silently cut from the *start* - the same prompt then
 * yields a plausible answer built from the middle of the rules, with no error
 * anywhere. The native `/api/chat` schema can set the window, which means the
 * request has to know how big the prompt is before it is sent.
 *
 * No browser imports on purpose: pure functions, unit-testable exactly like
 * `timeouts.ts`. Nothing here talks to a model; it only counts characters.
 */

import { classOf } from "../gate/charset";

/**
 * Tokens per character, measured against Ollama 0.40.15 / `qwen3.5:2b`
 * (Qwen BPE) with `prompt_eval_count` as ground truth.
 *
 * Measured per class on *diverse* samples of >=150 chars. Repeating one string
 * is not a valid measurement: BPE merges the repeat and reports roughly half
 * the real cost (`"あ".repeat(800)` measures 0.52 tok/char, real dialogue
 * 0.70-0.73). The earlier version of this table was calibrated on repeats and
 * under-estimated real prompts by up to 20% - the unsafe direction.
 *
 *   Japanese prose (diverse)   0.70-0.77 tok/char, rare kanji towards 1.0
 *   Hiragana-only dialogue     ~0.53
 *   Katakana loanwords         ~0.41-0.51
 *   Latin prose                ~0.15
 *   Latin prompt scaffolding   ~0.31  (short words, punctuation, newlines)
 *   ASCII punctuation          ~0.65
 *   ASCII digits               ~0.99  (mostly one token per digit)
 *   Korean                     ~0.37
 *
 * A flat `chars / 4` estimate under-predicts a Japanese manga prompt by ~3.5x,
 * which is why the CJK weights are the ones that actually protect the request.
 */
const TOKENS_PER_CHAR = {
  /** Han and kana: the dense case this budget exists for. */
  cjk: 0.71,
  /** CJK punctuation and fullwidth forms: one token each, never merged. */
  cjkPunctuation: 0.84,
  /** Hangul syllables tokenize in pairs or triples, not one-per-glyph. */
  hangul: 0.52,
  /** Latin, Cyrillic, Greek: ~4-7 chars per token, but not in prompts. */
  alphabetic: 0.25,
  /**
   * ASCII digits are billed almost one token each, which is why the numeric
   * parts of a prompt (box counts, indexes) are not free.
   */
  digit: 1.0,
  /** ASCII punctuation is likewise close to one token per character. */
  asciiPunctuation: 0.61,
  /** Thai, Arabic, Hebrew, Devanagari, Tamil, Telugu: unmeasured, mid-weight. */
  otherScript: 0.57,
  /** Runs of spaces and newlines collapse into very few tokens. */
  whitespace: 0.01,
} as const;

/** Per-message chat-template overhead (role tokens, turn delimiters). */
export const MESSAGE_OVERHEAD_TOKENS = 8;

/** Room reserved for the chat template beyond prompt + answer. */
export const CONTEXT_SAFETY_MARGIN = 512;

/** Output cap floor: enough for a short page's JSON envelope. */
export const MIN_OUTPUT_TOKENS = 1024;
/** Output cap ceiling: a longer answer than this means the page needs LMT-012. */
export const MAX_OUTPUT_TOKENS = 8192;
/** Tokens of answer budget granted per text box. */
export const OUTPUT_TOKENS_PER_BOX = 96;
/** Largest window asked for automatically. A 9B at 32k can OOM a 16 GB card. */
export const MAX_NUM_CTX = 32768;
/** Smallest window worth asking for. */
export const MIN_NUM_CTX = 1024;

export interface TokenEstimate {
  tokens: number;
  /** Characters counted, for the Debug line. */
  chars: number;
}

/**
 * Estimate tokens for `text`, weighting each code point by its class.
 *
 * The classifier must be the *same* partition the weights were measured on:
 * digits and ASCII punctuation are not `neutral`, they are close to one token
 * per character. Treating them as cheap was what let a digit-heavy prompt
 * under-estimate by 20%.
 */
export function estimateTokenDetail(text: string): TokenEstimate {
  if (!text) return { tokens: 0, chars: 0 };

  let tokens = 0;
  let chars = 0;
  for (const char of text) {
    chars++;
    const cp = char.codePointAt(0)!;

    // Whitespace collapses: a run of spaces or newlines is a token or two.
    if (
      cp === 0x20 ||
      (cp >= 0x09 && cp <= 0x0d) ||
      cp === 0x85 ||
      cp === 0xa0 ||
      cp === 0x3000
    ) {
      tokens += TOKENS_PER_CHAR.whitespace;
      continue;
    }

    // ASCII digits and fullwidth digits bill close to one token each.
    if ((cp >= 0x30 && cp <= 0x39) || (cp >= 0xff10 && cp <= 0xff19)) {
      tokens += TOKENS_PER_CHAR.digit;
      continue;
    }

    // ASCII punctuation: also close to one token per character.
    if (
      (cp >= 0x21 && cp <= 0x2f) ||
      (cp >= 0x3a && cp <= 0x40) ||
      (cp >= 0x5b && cp <= 0x60) ||
      (cp >= 0x7b && cp <= 0x7e)
    ) {
      tokens += TOKENS_PER_CHAR.asciiPunctuation;
      continue;
    }

    // CJK punctuation and fullwidth forms. These are `other` to `classOf`,
    // but they tokenize like CJK; calling them cheap under-counts Japanese.
    if (
      (cp >= 0x3001 && cp <= 0x303f) ||
      (cp >= 0xff01 && cp <= 0xff60)
    ) {
      tokens += TOKENS_PER_CHAR.cjkPunctuation;
      continue;
    }

    const cls = classOf(cp);
    if (cls === "han" || cls === "kana") {
      tokens += TOKENS_PER_CHAR.cjk;
    } else if (cls === "hangul") {
      tokens += TOKENS_PER_CHAR.hangul;
    } else if (cls === "latin" || cls === "cyrillic" || cls === "greek") {
      tokens += TOKENS_PER_CHAR.alphabetic;
    } else {
      tokens += TOKENS_PER_CHAR.otherScript;
    }
  }

  return { tokens: Math.ceil(tokens), chars };
}

/** Estimate tokens for one or more prompt parts, plus per-message overhead. */
export function estimateTokens(...parts: string[]): number {
  let total = MESSAGE_OVERHEAD_TOKENS * parts.length;
  for (const part of parts) total += estimateTokenDetail(part).tokens;
  return total;
}

/**
 * Answer budget for a page with `boxes` text regions.
 *
 * Thinking models bill reasoning tokens to the same cap, so a constant 4096 was
 * spent before the JSON started. Scaling with the box count is what LMT-027 did
 * for time and what LMT-012 will do for batching; here it just keeps the answer
 * from being cut.
 */
export function resolveOutputCap(boxes: number): number {
  const regions = Number.isFinite(boxes) ? Math.max(0, Math.floor(boxes)) : 0;
  const scaled = MIN_OUTPUT_TOKENS + regions * OUTPUT_TOKENS_PER_BOX;
  return Math.min(MAX_OUTPUT_TOKENS, Math.max(MIN_OUTPUT_TOKENS, scaled));
}

function roundUpTo(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

export interface NumCtxInput {
  /** Estimated prompt tokens (see `estimateTokens`). */
  promptTokens: number;
  /** Answer budget (see `resolveOutputCap`). */
  outputCap: number;
  /** What the user asked for. `undefined` uses the configured default. */
  requested?: number;
}

/**
 * The window to request. Never smaller than what the request needs: a window
 * that cannot hold `prompt + answer` reintroduces the silent cut this module
 * exists to prevent. Grows in 1024 steps and stops at `MAX_NUM_CTX`.
 */
export function resolveNumCtx({
  promptTokens,
  outputCap,
  requested,
}: NumCtxInput): number {
  const prompt = Number.isFinite(promptTokens) ? Math.max(0, promptTokens) : 0;
  const output = Number.isFinite(outputCap) ? Math.max(0, outputCap) : 0;
  const floor = Number.isFinite(requested) && (requested as number) > 0
    ? Math.floor(requested as number)
    : MIN_NUM_CTX;

  const needed =
    prompt + output + CONTEXT_SAFETY_MARGIN;

  const target = Math.max(floor, roundUpTo(needed, 1024));
  return Math.min(MAX_NUM_CTX, Math.max(MIN_NUM_CTX, target));
}

export type BudgetLevel = "ok" | "warn" | "over";

export interface BudgetVerdict {
  level: BudgetLevel;
  /** Human-readable, shown in the Debug entry and next to the setting. */
  message?: string;
}

export interface BudgetVerdictInput {
  promptTokens: number;
  outputCap: number;
  numCtx: number;
}

const formatTokens = (value: number) =>
  Math.round(value).toLocaleString("en-US");

/**
 * Compare what the request needs against what the window can hold.
 *
 * `over` is the case that must never pass silently: the server will drop the
 * start of the prompt and answer from whatever survived.
 */
export function budgetVerdict({
  promptTokens,
  outputCap,
  numCtx,
}: BudgetVerdictInput): BudgetVerdict {
  const needed = promptTokens + outputCap + CONTEXT_SAFETY_MARGIN;

  if (needed > numCtx) {
    return {
      level: "over",
      message:
        `Prompt ~${formatTokens(promptTokens)} tok + ${formatTokens(outputCap)} tok answer ` +
        `exceeds the ${formatTokens(numCtx)}-token window. ` +
        `The server will cut the start of the prompt - shorten the series context or raise the context window.`,
    };
  }

  // Above 75% of the window the answer is one long box away from a cut.
  if (needed > numCtx * 0.75) {
    return {
      level: "warn",
      message:
        `Prompt ~${formatTokens(promptTokens)} tok + ${formatTokens(outputCap)} tok answer ` +
        `uses most of the ${formatTokens(numCtx)}-token window.`,
    };
  }

  return { level: "ok" };
}
