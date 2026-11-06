import type { ChatOptions } from "@mlc-ai/web-llm";
import { env } from "./env";

const ocrLangGroupMap: Record<string, string> = {
  // English
  English: "english",

  // Chinese/Japanese
  Japanese: "chinese",
  "Chinese (Simplified)": "chinese",
  "Chinese (Traditional)": "chinese",

  // Korean & Thai
  Korean: "korean",
  Thai: "thai",
  Greek: "greek",

  // East Slavic
  Russian: "eslav",
  Bulgarian: "eslav",
  Ukrainian: "eslav",
  Belarusian: "eslav",

  // v3 Models (South Asian & Middle Eastern)
  Arabic: "arabic",
  Urdu: "arabic",
  "Persian/Farsi": "arabic",
  Hindi: "hindi",
  Marathi: "hindi",
  Nepali: "hindi",
  Sanskrit: "hindi",
  Tamil: "tamil",
  Telugu: "telugu",

  // All other Latin-based languages will default to "latin" if not explicitly mapped
};

/** WebGPU feature a local LLM may require before `reload()` will succeed. */
export type LlmRequiredFeature = "shader-f16";

/** Which runtime serves a local model: WebLLM/MLC chunks, or wllama GGUF. */
export type LlmEngine = "webllm" | "wllama";

/**
 * One selectable local LLM.
 *
 * `vram` is the *runtime* label shown next to the name; `weightMb` is the
 * measured download footprint, so the two numbers stop being the same string
 * (LMT-013). `engine`/`browsers` describe the build that offers the row:
 * WebLLM models are Chrome-only, wllama GGUF models are Firefox-only, because
 * `@mlc-ai/web-llm` cannot fit the 2 MB-per-.js AMO limit and Firefox has no
 * WebGPU compute path for it.
 */
export interface LlmModelDef {
  id: string;
  label: string;
  desc: string;
  vram: string;
  /** Sum of the model repo's weight shards, in MiB. */
  weightMb: number;
  /** Adapter feature WebLLM checks before loading (see `ShaderF16SupportError`). */
  requiresFeature?: LlmRequiredFeature;
  /** Defaults to "webllm" so merged/pre-existing rows stay WebLLM. */
  engine?: LlmEngine;
  /** Build targets this model is offered on ("chrome" covers non-Firefox). */
  browsers?: string[];
  /** wllama-only: HF repo + file served through the shared model cache. */
  repo?: string;
  file?: string;
  /** wllama-only: exact GGUF size, used by the storage manager. */
  bytes?: number;
}

/** @deprecated kept for imports written against the Chrome branch; use `LlmModelDef`. */
export type LlmModelOption = LlmModelDef;

export const DefaultConfig = {
  currentMode: "webgpu",
  sourceLang: "Auto-Detect",
  targetLang: "English",

  // Translation backends: "webgpu" (in-browser WebLLM) | "gemini" (cloud) | "api" (external server)
  // The `webgpu` id is a persisted storage value (`sync:current-mode`) and
  // stays for compatibility. It is NOT the label: in the default local config
  // the detector, Japanese/Chinese OCR and LaMa inpaint run on WASM CPU
  // (see `hardware.ts` `WEBGPU_INCOMPATIBLE_MARKERS`), so the mode is named
  // for what it guarantees — nothing leaves the device — not for one provider.
  modes: [
    {
      id: "webgpu",
      label: "Local",
      color: "amber",
      classes: "text-amber-700 dark:text-amber-400",
      activeClasses: "bg-amber-100 dark:bg-amber-900/30",
    },
    {
      id: "gemini",
      label: "Gemini",
      color: "emerald",
      classes: "text-emerald-700 dark:text-emerald-400",
      activeClasses: "bg-emerald-100 dark:bg-emerald-900/30",
    },
    {
      id: "api",
      label: "API Mode",
      color: "sky",
      classes: "text-sky-700 dark:text-sky-400",
      activeClasses: "bg-sky-100 dark:bg-sky-900/30",
    },
  ],

  // External LLM server (API Mode) - Ollama / LM Studio / OpenAI-compatible
  serverHost: "http://127.0.0.1:11434/v1",
  serverSchema: "openai",
  serverModel: "qwen3.5:4b",
  useServerApiKey: false,
  serverApiKey: "",
  serverEndpoints: {
    openai: "chat/completions",
    lmstudio: "chat",
  },
  serverMaxRetries: 1,
  serverRetryDelayMs: 2000,

  // Per-job execution budgets (ms) for work forwarded to the offscreen
  // document (LMT-010 / LMT-027). The offscreen document owns the clock and
  // aborts the request at the deadline, so a slow page is actually cancelled
  // instead of merely abandoned; the background service worker only mounts a
  // last-resort guard `timeoutGuardGraceMs` later. Resolution lives in
  // `timeouts.ts` so the numbers stay unit-testable.
  timeoutShortJobMs: 90_000,
  timeoutLocalTranslateMs: 480_000,
  timeoutApiTranslateMs: 180_000,
  /**
   * Budget added per text region for API translation. A dense page spends one
   * inference round-trip on the answer plus one on the correction, so a flat
   * page budget cut off pages that were still generating.
   */
  timeoutApiTranslatePerBoxMs: 15_000,
  timeoutGeminiTranslateMs: 180_000,
  timeoutInpaintMs: 180_000,
  /** LaMa runs on wasm CPU (~30s+ per 512px tile) - budget per region. */
  timeoutQualityInpaintMs: 300_000,
  timeoutQualityInpaintPerBoxMs: 60_000,
  /** Extra time the background waits past the offscreen deadline. */
  timeoutGuardGraceMs: 5_000,

  detectionMinConfidence: 0.5,
  skipBboxRefining: false,
  autoTranslate: false,
  autoTranslateConcurrency: 1,
  rtdetrModelRepo: env.rtdetrModelRepo,
  comicTextDetectorUrl: env.comicTextDetectorUrl,

  // Inpainting method: "fast" (model-free ladder: fitted mask -> planar fill
  // -> denoise -> Telea, each rung decline-gated) | "quality" (standalone
  // LaMa-first pass per region, falling back into Fast where LaMa declines)
  inpaintMethod: "fast",
  alwaysInpaint: false,
  lamaRepo: env.lamaInpaintModelRepo,
  lamaModelPath: "lama-manga-dynamic.onnx" as `${string}.onnx`,

  ocrEngine: "paddle", // "paddle" | "ppocrv6-manga" (JA-only) | "manga-ocr" (JA-only) | "pororo" (KO-only)
  ocrMinConfidence: 0.7,
  ocrLangGroupMap, // Map source language to language group for model & dictionary selection
  ocrBatchSize: 4,
  ocrRecImgHeight: 48,
  ocrRepo: env.paddleOCRModelRepo,
  mangaOcrRepo: env.mangaOCRModelRepo,
  pororoRepo: env.pororoModelRepo,
  ocrModelPath: (langGroup: string): `${string}.onnx` =>
    `languages/${langGroup}/rec.onnx`,
  ocrDictPath: (langGroup: string) => `languages/${langGroup}/dict.txt`,
  // Script-ID gate: verifies detected regions really hold the selected
  // source script before translating (strict when a CJK source is explicit,
  // additive page-majority under Auto-Detect).
  scriptGate: true,
  gateRepo: env.gateModelRepo,
  gateModelPath: "osd_lstm.onnx" as `${string}.onnx`,
  gateLabelsPath: "osd_labels.json",

  llmTemperature: 0.3,
  minTranslations: 5, // number of translations per series before resetting context

  geminiModels: [
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
    { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash" },
    { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
    { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite" },
    { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite" },
  ],
  detectionModels: [
    {
      id: "comic-bubble",
      label: "Comic Bubble Detector (RT-DETR)",
      size: "11.1 MB",
      desc: "Bubble & free text detection (default)",
    },
    {
      id: "comic-text-detector",
      label: "Comic Text Detector & Segmentation",
      size: "94.7 MB",
      desc: "Text boxes + pixel segmentation mask",
    },
  ],
  llmModels: [
    {
      id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
      label: "Llama-3.2-1B",
      desc: "Small — fastest, lightweight dialogue translation.",
      vram: "~880 MB",
      weightMb: 672,
      engine: "webllm",
      browsers: ["chrome"],
    },
    // Retained for future re-enablement if upstream WebLLM fixes Gemma 3 sliding-window attention correctness:
    // {
    //   id: "gemma3-1b-it-q4f16_1-MLC",
    //   label: "Gemma3-1B",
    //   desc: "Small — fastest, good enough for simple dialogue.",
    //   vram: "~800 MB",
    // },
    {
      id: "Qwen3.5-0.8B-q4f16_1-MLC",
      label: "Qwen3.5-0.8B",
      desc: "Ultra-compact — low memory, quick responses.",
      vram: "~1.6 GB",
      weightMb: 426,
      engine: "webllm",
      browsers: ["chrome"],
    },
    {
      id: "gemma-2-2b-jpn-it-q4f16_1-MLC",
      label: "Gemma2-2B-JPN",
      desc: "Japanese-tuned — best small model for JP source pages.",
      vram: "~1.9 GB",
      weightMb: 1424,
      requiresFeature: "shader-f16",
      engine: "webllm",
      browsers: ["chrome"],
    },
    {
      id: "Qwen3.5-2B-q4f16_1-MLC",
      label: "Qwen3.5-2B",
      desc: "Balanced — speed and quality for most manga.",
      vram: "~2.3 GB",
      weightMb: 1032,
      engine: "webllm",
      browsers: ["chrome"],
    },
    {
      id: "Hermes-3-Llama-3.2-3B-q4f16_1-MLC",
      label: "Hermes-3-3B",
      desc: "Balanced — steadiest structured output at 3B.",
      vram: "~2.3 GB",
      weightMb: 1733,
      engine: "webllm",
      browsers: ["chrome"],
    },
    {
      id: "Qwen3.5-4B-q4f16_1-MLC",
      label: "Qwen3.5-4B",
      desc: "Good — better reasoning for more complex manga.",
      vram: "~3.9 GB",
      weightMb: 2280,
      engine: "webllm",
      browsers: ["chrome"],
    },
    {
      id: "Phi-4-mini-instruct-q4f16_1-MLC",
      label: "Phi-4-mini",
      desc: "Balanced — strong instruction following, larger download.",
      vram: "~3.4 GB",
      weightMb: 2079,
      engine: "webllm",
      browsers: ["chrome"],
    },
    {
      id: "Qwen3.5-9B-q4f16_1-MLC",
      label: "Qwen3.5-9B",
      desc: "Best quality — needs a GPU with 8 GB+ VRAM.",
      vram: "~6.4 GB",
      weightMb: 4827,
      engine: "webllm",
      browsers: ["chrome"],
    },
    // ── Firefox-only (wllama / GGUF) ──────────────────────────────────────
    // Kept in the same list so storage ids, cache names and the storage
    // manager stay engine-agnostic; `visibleLlmModels()` hides them on Chrome.
    {
      id: "Qwen3.5-4B-Q3_K_M-GGUF",
      label: "Qwen3.5-4B",
      desc: "Balanced — speed and quality for most manga.",
      vram: "~2.1 GB",
      weightMb: 2187,
      engine: "wllama",
      browsers: ["firefox"],
      repo: env.ggufModelRepo,
      file: "Qwen3.5-4B-Q3_K_M.gguf",
      bytes: 2293388448,
    },
    {
      id: "tiny-aya-global-q4_k_m-GGUF",
      label: "Tiny Aya Global",
      desc: "Tiny multilingual model — focused on translating text.",
      vram: "~2.0 GB",
      weightMb: 2045,
      engine: "wllama",
      browsers: ["firefox"],
      repo: "CohereLabs/tiny-aya-global-GGUF",
      file: "tiny-aya-global-q4_k_m.gguf",
      bytes: 2143977056,
    },
    {
      id: "tiny-aya-fire-q4_k_m-GGUF",
      label: "Tiny Aya Fire",
      desc: "Tiny Fire model — focused on translating CJK / Asian language.",
      vram: "~2.0 GB",
      weightMb: 2045,
      engine: "wllama",
      browsers: ["firefox"],
      repo: "CohereLabs/tiny-aya-fire-GGUF",
      file: "tiny-aya-fire-q4_k_m.gguf",
      bytes: 2143977056,
    },
  ] satisfies LlmModelDef[],
  // Per-model ChatConfig overrides merged onto each model's downloaded
  // mlc-chat-config.json (via ModelRecord.overrides).
  //
  // Retained for Gemma 3 if re-enabled in the future:
  // gemma3-1b ships BOTH `context_window_size: 8192` and
  // `sliding_window_size: 512` as positive, and WebLLM rejects that
  // (WindowSizeConfigurationError). Qwen3.5 and Llama records don't need this.
  llmModelOverrides: {
    // "gemma3-1b-it-q4f16_1-MLC": { sliding_window_size: -1 },
  } as Record<string, ChatOptions>,
  availableLanguages: [
    "Auto-Detect",
    "Indonesian",
    "Spanish",
    "Portuguese",
    "French",
    "Vietnamese",
    "Tagalog",
    "Malay",
    "Thai",
    "German",
    "Italian",
    "Dutch",
    "Polish",
    "Czech",
    "Slovak",
    "Croatian",
    "Bosnian",
    "Serbian",
    "Slovenian",
    "Danish",
    "Norwegian",
    "Swedish",
    "Icelandic",
    "Estonian",
    "Lithuanian",
    "Hungarian",
    "Albanian",
    "Welsh",
    "Irish",
    "Turkish",
    "Afrikaans",
    "Swahili",
    "Uzbek",
    "Latin",
    "Greek",
    ...Object.keys(ocrLangGroupMap),
  ],
  bundleFonts: [
    { id: "system", label: "System", stack: "'Segoe UI', sans-serif" },
    { id: "noto", label: "Noto Sans", stack: "'Noto Sans', sans-serif" },
    { id: "bangers", label: "Bangers", stack: "'Bangers', cursive" },
    { id: "comic", label: "Comic Neue", stack: "'Comic Neue', cursive" },
  ],
};

// ── OCR language-group resolution ─────────────────────────────────────────
// Groups with a dedicated `languages/<group>/rec.onnx` + `dict.txt` on the
// paddleocr-onnx repo (mirrors `monkt/paddleocr-onnx/languages/`).
export const SUPPORTED_LANG_GROUPS = [
  "arabic",
  "chinese",
  "english",
  "eslav",
  "greek",
  "hindi",
  "korean",
  "latin",
  "tamil",
  "telugu",
  "thai",
] as const;

export interface ResolvedLangGroup {
  /** Repo folder under `languages/`, e.g. "thai" or fallback "latin". */
  group: string;
  /** True when `sourceLang` had no direct mapping and fell back to latin. */
  fellBack: boolean;
}

/**
 * Single source of truth for source-language → rec-model group resolution.
 * - "Latin" (capitalised UI label) resolves to "latin" and is not a fallback.
 * - "Auto-Detect" resolves to "latin" **as a placeholder**: the gate has not
 *   spoken yet, so latin is an assumption, not an answer. `fellBack: true`
 *   lets callers log/notice it instead of claiming the page was identified
 * - Direct `ocrLangGroupMap` hits resolve silently.
 * - Anything else falls back to "latin" with `fellBack: true` so callers can
 *   surface which `rec.onnx` was actually used.
 */
export function resolveLangGroup(sourceLang: string): ResolvedLangGroup {
  if (sourceLang === "Latin") {
    return { group: "latin", fellBack: false };
  }
  if (sourceLang === "Auto-Detect") {
    return { group: "latin", fellBack: true };
  }
  const mapped = ocrLangGroupMap[sourceLang];
  if (mapped && (SUPPORTED_LANG_GROUPS as readonly string[]).includes(mapped)) {
    return { group: mapped, fellBack: false };
  }
  if (mapped) {
    console.warn(
      `[ocr] language "${sourceLang}" maps to unknown group "${mapped}", falling back to "latin"`,
    );
    return { group: "latin", fellBack: true };
  }
  return { group: "latin", fellBack: true };
}

/**
 * Normalize stored detection-model ids.
 * - Known ids pass through untouched.
 * - Falsy values fall back to the default detection model.
 */
export function normalizeDetectionModel(id: string | null | undefined): string {
  return id || DefaultConfig.detectionModels[0].id;
}

/** "firefox" for Firefox builds, "chrome" for everything else. */
export function currentBrowser(): "firefox" | "chrome" {
  try {
    const envBrowser = (import.meta.env as Record<string, string | undefined>)
      .BROWSER;
    if (envBrowser === "firefox") return "firefox";
  } catch {
    // import.meta.env unavailable (e.g. self-check scripts) — fall through
  }
  if (
    typeof navigator !== "undefined" &&
    /firefox/i.test(navigator.userAgent ?? "")
  ) {
    return "firefox";
  }
  return "chrome";
}

/**
 * LLM models offered in this build: WebLLM/MLC on Chrome, wllama GGUF on
 * Firefox. FireFox rows are hidden rather than removed so a single
 * `DefaultConfig.llmModels` list still resolves storage ids and cache names on
 * both targets.
 */
export function visibleLlmModels(): LlmModelDef[] {
  const browser = currentBrowser();
  const engine: LlmEngine = browser === "firefox" ? "wllama" : "webllm";
  return (DefaultConfig.llmModels as LlmModelDef[]).filter((m) =>
    (m.browsers ?? [m.engine === "wllama" ? "firefox" : "chrome"]).includes(
      browser,
    ) && (m.engine ?? "webllm") === engine,
  );
}

/** Resolve a stored model id, falling back to this build's default (handles cross-engine stale ids). */
export function llmModelDef(id?: string | null): LlmModelDef {
  const list = requireLlmModels();
  if (id === "Qwen3.5-4B-IQ4_XS-GGUF") {
    const upgraded = list.find((m) => m.id === "Qwen3.5-4B-Q3_K_M-GGUF");
    if (upgraded) return upgraded;
  }
  return list.find((m) => m.id === id) ?? list[0];
}

export function defaultLlmModelId(): string {
  return llmModelDef(null).id;
}

/**
 * The model list this build must be able to resolve. Guarantees a non-empty
 * array: `visibleLlmModels()` can only be empty if a caller passed a build with
 * no matching engine rows, which would otherwise crash on `[0]`.
 */
export function requireLlmModels(): LlmModelDef[] {
  const list = visibleLlmModels();
  return list.length > 0 ? list : (DefaultConfig.llmModels as LlmModelDef[]);
}

/**
 * Normalize stored LLM model ids.
 * - Known active ids pass through untouched.
 * - Falsy, unknown, or deprecated ids fall back to the default LLM model.
 */
export function normalizeLlmModel(id: string | null | undefined): string {
  return llmModelDef(id).id;
}
