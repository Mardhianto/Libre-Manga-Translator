/**
 * Schema validator for LLM translation responses.
 *
 * Accepts the shapes models actually emit (string arrays, `{text}` items,
 * `Box N` maps, bare arrays, single-box objects), normalizes them to one
 * string per OCR box, and throws a typed `TranslationValidationError` on
 * count/shape mismatch. It never pads, truncates, or paints JSON.stringify()d
 * objects: a mismatch must fail the page, not shift text into the wrong
 * bubble.
 *
 * Every accepted result carries diagnostics. `untranslated` marks boxes whose
 * output echoes the source (exact match, or ≥50% source-script share when the
 * source and target scripts are disjoint), and `maskUntranslated()` turns
 * those slots into "" so the renderer leaves the original pixels alone.
 */

import {
  classOf,
  classShare,
  expectedClassesForSource,
  type ScriptClass,
} from "../gate/charset";

export type TranslationValidationCode =
  | "NOT_OBJECT"
  | "MISSING_TRANSLATIONS"
  | "BAD_ITEM"
  | "COUNT_MISMATCH"
  | "BAD_SOURCE_TEXTS";

export class TranslationValidationError extends Error {
  readonly code: TranslationValidationCode;
  readonly expectedCount: number;
  readonly receivedCount?: number;

  constructor(
    message: string,
    code: TranslationValidationCode,
    details: { expectedCount: number; receivedCount?: number },
  ) {
    super(message);
    this.name = "TranslationValidationError";
    this.code = code;
    this.expectedCount = details.expectedCount;
    this.receivedCount = details.receivedCount;
  }
}

export function isTranslationValidationError(
  error: unknown,
): error is TranslationValidationError {
  return (
    error instanceof TranslationValidationError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: string }).name === "TranslationValidationError")
  );
}

export interface ValidatedTranslation {
  translations: Translations;
  sourceTexts?: string[];
  context?: {
    summary: string;
    dictionary: string;
  };
  diagnostics: TranslationDiagnostics;
}

export interface ValidateOptions {
  /** OCR text per box. Preferred over model-returned `sourceTexts` for echo checks. */
  sourceTexts?: string[];
  sourceLang?: string;
  targetLang?: string;
  /**
   * What the backend learned about the request itself (LMT-032): the raw
   * answer, its stop reason, and how much prompt was sent. Kept separate from
   * validation because validation must stay a pure shape check.
   */
  run?: LlmRunInfo;
}

/**
 * Facts about one LLM round-trip, collected by the backend that made it.
 * All optional: a caller that cannot report them must not fabricate them.
 */
export interface LlmRunInfo {
  /** Model answer before parsing; clipped by `clipRawResponse`. */
  rawResponse?: string;
  /** Provider stop reason ("stop", "length", "MAX_TOKENS", …). */
  finishReason?: string;
  /** Characters sent: system prompt + user prompt. */
  promptChars?: number;
  /** LLM requests spent on this page (format fallbacks + correction round). */
  llmCalls?: number;
}

/** Raw answers are capped before they reach storage: 50 debug entries × a
 *  whole answer would blow past the `local:` budget for no diagnostic gain. */
export const RAW_RESPONSE_LIMIT = 4096;

export function clipRawResponse(content: string | null | undefined): string {
  const text = typeof content === "string" ? content : "";
  return text.length <= RAW_RESPONSE_LIMIT
    ? text
    : `${text.slice(0, RAW_RESPONSE_LIMIT)}…[${text.length - RAW_RESPONSE_LIMIT} chars cut]`;
}

export function promptChars(
  systemPrompt: string,
  userPrompt: string,
): number {
  return systemPrompt.length + userPrompt.length;
}

/** Provider stop reasons that mean the answer was cut by the output cap. */
export function isTruncatedFinishReason(
  reason: string | undefined,
): boolean {
  if (!reason) return false;
  const normalized = reason.toLowerCase();
  return (
    normalized === "length" ||
    normalized === "max_tokens" ||
    normalized === "max_output_tokens" ||
    normalized === "max_output" ||
    normalized === "token_limit"
  );
}

/**
 * Fold per-call facts into one page-level record (last call wins on reason).
 *
 * `llmCalls` is the number of round-trips, not a caller-supplied number: a
 * backend that reports two facts must not be able to claim one call.
 */
export function mergeRunInfo(calls: LlmRunInfo[]): LlmRunInfo {
  if (calls.length === 0) return {};
  const last = calls[calls.length - 1];
  return {
    rawResponse: last.rawResponse,
    finishReason: last.finishReason,
    // The first call's prompt is the page's baseline; the correction prompt is
    // longer and would overstate what a normal page costs.
    promptChars: calls[0].promptChars,
    llmCalls: calls.length,
  };
}

/**
 * Attach diagnostics to a thrown error.
 *
 * Parse and transport failures are exactly the cases where the raw answer
 * matters most (a truncated page throws before validation ever runs), so the
 * backend stamps what it knows onto the error and the content script reads it
 * back with `diagnosticsFromError`. Non-object errors are returned untouched.
 */
export function attachDiagnostics<T>(error: T, run: LlmRunInfo): T {
  if (error && typeof error === "object") {
    Object.defineProperty(error, "lmtDiagnostics", {
      value: mergeRunInfo([run]),
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return error;
}

export function diagnosticsFromError(
  error: unknown,
): LlmRunInfo | undefined {
  if (!error || typeof error !== "object") return undefined;
  return (error as { lmtDiagnostics?: LlmRunInfo }).lmtDiagnostics;
}

const TEXT_KEYS = [
  "text",
  "translation",
  "translated",
  "content",
  "output",
  "value",
] as const;

const ALTERNATIVE_ARRAY_KEYS = ["translation", "results", "output", "data"] as const;

const BOX_KEY = /^(?:box[\s_-]*)?(\d+)$/i;

/**
 * Robust JSON extractor and parser for LLM outputs.
 * Handles markdown codeblocks, preamble conversational text, and raw JSON.
 */
export function parseLlmJson(content: string): any {
  const trimmed = content.trim();

  // 1. Direct JSON parse
  try {
    return JSON.parse(trimmed);
  } catch {}

  // 2. Extract markdown code block ```json ... ``` or ``` ... ``` anywhere in content
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch?.[1]) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {}
  }

  // 3. Extract outermost JSON object { ... }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {}
  }

  // 4. Extract outermost JSON array [ ... ]
  const firstBracket = trimmed.indexOf("[");
  const lastBracket = trimmed.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      return JSON.parse(trimmed.slice(firstBracket, lastBracket + 1));
    } catch {}
  }

  throw new Error(
    `Failed to parse server JSON: Unexpected format\nRaw: ${content.substring(0, 500)}`,
  );
}

export function validateTranslationResult(
  raw: unknown,
  expectedCount: number,
  options?: ValidateOptions,
): ValidatedTranslation {
  if (!raw || typeof raw !== "object") {
    throw new TranslationValidationError(
      "API Schema Error: Response is not an object.",
      "NOT_OBJECT",
      { expectedCount },
    );
  }

  const envelope = Array.isArray(raw)
    ? undefined
    : (raw as Record<string, any>);

  const translations = normalizeTranslations(raw, expectedCount);

  let sourceTexts: string[] | undefined = undefined;
  if (envelope?.sourceTexts !== undefined) {
    if (!Array.isArray(envelope.sourceTexts)) {
      throw new TranslationValidationError(
        "API Schema Error: 'sourceTexts' must be an array.",
        "BAD_SOURCE_TEXTS",
        { expectedCount },
      );
    }
    sourceTexts = envelope.sourceTexts.map((s: unknown) =>
      typeof s === "string" ? s : s === null || s === undefined ? "" : String(s),
    );
  }

  let context: { summary: string; dictionary: string } | undefined = undefined;
  if (envelope?.context && typeof envelope.context === "object") {
    context = {
      summary:
        typeof envelope.context.summary === "string"
          ? envelope.context.summary
          : "",
      dictionary:
        typeof envelope.context.dictionary === "string"
          ? envelope.context.dictionary
          : "",
    };
  }

  const untranslated = findUntranslated(
    translations,
    options?.sourceTexts ?? sourceTexts,
    options?.sourceLang,
    options?.targetLang,
  );

  const run = options?.run;
  return {
    translations,
    sourceTexts,
    context,
    diagnostics: {
      expectedCount,
      receivedCount: translations.length,
      untranslated,
      clean: untranslated.length === 0,
      ...(run
        ? {
            rawResponse: run.rawResponse
              ? clipRawResponse(run.rawResponse)
              : undefined,
            finishReason: run.finishReason,
            promptChars: run.promptChars,
            llmCalls: run.llmCalls,
            truncated: isTruncatedFinishReason(run.finishReason),
            // This validator never invents entries; the flag exists so the
            // Debug export can prove that in one line (LMT-032).
            padded: false,
          }
        : {}),
    },
  };
}

/**
 * Turn any accepted response shape into exactly `expectedCount` strings.
 * Throws on mismatch. Accepts bare arrays, `translations`, alternative keys,
 * `Box N` maps, object items, indexed items, and single-box objects.
 */
function normalizeTranslations(raw: unknown, expectedCount: number): string[] {
  if (Array.isArray(raw)) {
    return normalizeArray(raw, expectedCount);
  }

  if (!raw || typeof raw !== "object") {
    throw new TranslationValidationError(
      "API Schema Error: Response is not an object.",
      "NOT_OBJECT",
      { expectedCount },
    );
  }

  const obj = raw as Record<string, unknown>;

  if ("translations" in obj) {
    return normalizeCandidate(obj.translations, expectedCount, "translations");
  }

  for (const key of ALTERNATIVE_ARRAY_KEYS) {
    if (key in obj) {
      return normalizeCandidate(obj[key], expectedCount, key);
    }
  }

  // A single box object: {"box":1,"text":"Hi"}.
  if (expectedCount === 1 && hasTextKey(obj)) {
    return normalizeArray([obj], expectedCount);
  }

  // A top-level Box N map: {"Box 1":"A","Box 2":"B"}.
  if (looksLikeBoxMap(obj)) {
    return normalizeMap(obj, expectedCount);
  }

  throw new TranslationValidationError(
    `API Schema Error: no translation list found. Expected 'translations', a bare array, or a "Box N" map. Received keys: ${
      Object.keys(obj).slice(0, 8).join(", ") || "(none)"
    }.`,
    "MISSING_TRANSLATIONS",
    { expectedCount },
  );
}

function normalizeCandidate(
  candidate: unknown,
  expectedCount: number,
  label: string,
): string[] {
  if (Array.isArray(candidate)) {
    return normalizeArray(candidate, expectedCount);
  }
  if (candidate && typeof candidate === "object") {
    if (looksLikeBoxMap(candidate)) {
      return normalizeMap(candidate as Record<string, unknown>, expectedCount);
    }
    if (expectedCount === 1 && hasTextKey(candidate as Record<string, unknown>)) {
      return normalizeArray([candidate], expectedCount);
    }
  }

  throw new TranslationValidationError(
    `API Schema Error: '${label}' must be an array or a "Box N" map.`,
    "MISSING_TRANSLATIONS",
    { expectedCount },
  );
}

function normalizeArray(items: unknown[], expectedCount: number): string[] {
  const indexed = items.some((item) => itemSlot(item) !== undefined);

  if (!indexed) {
    if (items.length !== expectedCount) {
      throw countMismatch(expectedCount, items.length);
    }
    return items.map(
      (item, index) => normalizeItem(item, index, expectedCount).text,
    );
  }

  const slots = new Array<string | undefined>(expectedCount).fill(undefined);
  for (const [index, item] of items.entries()) {
    const { text, slot } = normalizeItem(item, index, expectedCount);
    if (slot === undefined) {
      throw new TranslationValidationError(
        "API Schema Error: response mixes indexed and unindexed translation items.",
        "BAD_ITEM",
        { expectedCount },
      );
    }
    if (slot < 0 || slot >= expectedCount) {
      throw countMismatch(expectedCount, Math.max(slot + 1, items.length));
    }
    if (slots[slot] !== undefined) {
      throw new TranslationValidationError(
        `API Schema Error: duplicate translation index ${slot + 1}.`,
        "BAD_ITEM",
        { expectedCount },
      );
    }
    slots[slot] = text;
  }

  const received = slots.filter((value) => value !== undefined).length;
  const missing = slots.findIndex((value) => value === undefined);
  if (missing !== -1) {
    throw new TranslationValidationError(
      `API Schema Error: Translation count mismatch. Expected ${expectedCount} items to match bubbles, received ${received} (Box ${
        missing + 1
      } is missing).`,
      "COUNT_MISMATCH",
      { expectedCount, receivedCount: received },
    );
  }

  return slots as string[];
}

function normalizeMap(
  map: Record<string, unknown>,
  expectedCount: number,
): string[] {
  const slots = new Array<string | undefined>(expectedCount).fill(undefined);
  let received = 0;

  for (const [key, value] of Object.entries(map)) {
    const match = key.match(BOX_KEY);
    if (!match) {
      throw new TranslationValidationError(
        `API Schema Error: unsupported box key "${key}".`,
        "BAD_ITEM",
        { expectedCount },
      );
    }
    const slot = Number(match[1]) - 1;
    if (!Number.isInteger(slot) || slot < 0 || slot >= expectedCount) {
      throw countMismatch(expectedCount, Math.max(received + 1, slot + 1));
    }
    if (slots[slot] !== undefined) {
      throw new TranslationValidationError(
        `API Schema Error: duplicate translation index ${slot + 1}.`,
        "BAD_ITEM",
        { expectedCount },
      );
    }
    slots[slot] = normalizeItem(value, slot, expectedCount).text;
    received++;
  }

  const missing = slots.findIndex((value) => value === undefined);
  if (missing !== -1 || received !== expectedCount) {
    throw new TranslationValidationError(
      `API Schema Error: Translation count mismatch. Expected ${expectedCount} items to match bubbles, received ${received}${
        missing !== -1 ? ` (Box ${missing + 1} is missing)` : ""
      }.`,
      "COUNT_MISMATCH",
      { expectedCount, receivedCount: received },
    );
  }

  return slots as string[];
}

function normalizeItem(
  item: unknown,
  index: number,
  expectedCount: number,
): { text: string; slot?: number } {
  if (item === null || item === undefined) {
    return { text: "" };
  }
  if (typeof item === "string") {
    return { text: item };
  }
  if (typeof item === "number" || typeof item === "boolean") {
    return { text: String(item) };
  }
  if (typeof item !== "object" || Array.isArray(item)) {
    throw new TranslationValidationError(
      `API Schema Error: unsupported translation item at index ${index} (${typeof item}).`,
      "BAD_ITEM",
      { expectedCount },
    );
  }

  const obj = item as Record<string, unknown>;
  const key =
    TEXT_KEYS.find(
      (candidate) =>
        typeof obj[candidate] === "string" ||
        typeof obj[candidate] === "number" ||
        typeof obj[candidate] === "boolean",
    ) ?? TEXT_KEYS.find((candidate) => candidate in obj);
  if (!key) {
    throw new TranslationValidationError(
      `API Schema Error: unsupported translation item at index ${index}. Expected one of ${TEXT_KEYS.join(
        ", ",
      )}, received keys: ${Object.keys(obj).slice(0, 8).join(", ") || "(none)"}.`,
      "BAD_ITEM",
      { expectedCount },
    );
  }

  const value = obj[key];
  if (value !== null && value !== undefined && typeof value === "object") {
    throw new TranslationValidationError(
      `API Schema Error: translation item at index ${index} has a non-string '${key}'.`,
      "BAD_ITEM",
      { expectedCount },
    );
  }

  const text =
    value === null || value === undefined
      ? ""
      : typeof value === "string"
        ? value
        : String(value);

  return { text, slot: itemSlot(item) };
}

function itemSlot(item: unknown): number | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return undefined;
  }
  const obj = item as Record<string, unknown>;

  const box = obj.box;
  if (typeof box === "number" && Number.isFinite(box)) {
    return Math.trunc(box) - 1;
  }
  if (typeof box === "string" && /^\d+$/.test(box.trim())) {
    return Number(box.trim()) - 1;
  }

  const index = obj.index;
  if (typeof index === "number" && Number.isFinite(index)) {
    return Math.trunc(index);
  }
  if (typeof index === "string" && /^\d+$/.test(index.trim())) {
    return Number(index.trim());
  }

  return undefined;
}

function hasTextKey(obj: Record<string, unknown>): boolean {
  return TEXT_KEYS.some((key) => key in obj);
}

function looksLikeBoxMap(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => BOX_KEY.test(key));
}

function countMismatch(
  expectedCount: number,
  receivedCount: number,
): TranslationValidationError {
  return new TranslationValidationError(
    `API Schema Error: Translation count mismatch. Expected ${expectedCount} items to match bubbles, received ${receivedCount}.`,
    "COUNT_MISMATCH",
    { expectedCount, receivedCount },
  );
}

function findUntranslated(
  translations: string[],
  sourceTexts: string[] | undefined,
  sourceLang: string | undefined,
  targetLang: string | undefined,
): number[] {
  if (
    !sourceTexts ||
    sourceTexts.length !== translations.length ||
    sourceTexts.length === 0
  ) {
    return [];
  }

  const targetClasses = targetLang
    ? expectedClassesForSource(targetLang)
    : null;
  const flagged: number[] = [];

  for (let i = 0; i < translations.length; i++) {
    const source = sourceTexts[i] ?? "";
    const output = translations[i] ?? "";
    if (!source.trim() || !output.trim()) continue;

    const normalizedSource = normalizeForEcho(source);
    const normalizedOutput = normalizeForEcho(output);
    if (normalizedSource.length === 0) continue;

    if (normalizedSource === normalizedOutput) {
      flagged.push(i);
      continue;
    }

    // Partial echo: only judge script when the two languages cannot share one.
    if (!targetClasses) continue;
    const sourceClasses = sourceClassesFor(source, sourceLang);
    if (!sourceClasses) continue;
    if (sourceClasses.some((cls) => targetClasses.includes(cls))) continue;
    if ([...normalizedOutput].length < 2) continue;
    if (classShare(output, sourceClasses) >= 0.5) {
      flagged.push(i);
    }
  }

  return flagged;
}

function sourceClassesFor(
  text: string,
  sourceLang: string | undefined,
): ScriptClass[] | null {
  const explicit = sourceLang ? expectedClassesForSource(sourceLang) : null;
  const dominant = dominantClasses(text);
  // Trust the configured source language when the text actually matches it;
  // otherwise the OCR reading is better evidence (Auto-Detect or misconfig).
  if (!explicit) return dominant;
  if (!dominant) return explicit;
  return classShare(text, explicit) >= 0.5 ? explicit : dominant;
}

/** Script classes with the most countable characters (Auto-Detect fallback). */
function dominantClasses(text: string): ScriptClass[] | null {
  const counts = new Map<ScriptClass, number>();
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    const cls = classOf(ch.codePointAt(0)!);
    if (cls === "other") continue;
    counts.set(cls, (counts.get(cls) ?? 0) + 1);
  }
  if (counts.size === 0) return null;

  let max = 0;
  for (const count of counts.values()) max = Math.max(max, count);
  return [...counts.entries()]
    .filter(([, count]) => count === max)
    .map(([cls]) => cls);
}

function normalizeForEcho(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** Empty the slots the validator flagged as echoed/untranslated. */
export function maskUntranslated(
  translations: Translations,
  untranslated: number[] | undefined,
): Translations {
  if (!untranslated?.length) return translations;
  const drop = new Set(untranslated);
  return translations.map((text, index) => (drop.has(index) ? "" : text));
}
