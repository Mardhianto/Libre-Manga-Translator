/// <reference types="svelte" />
declare module "*.svelte" {
  import type { ComponentType } from "svelte";
  const component: ComponentType;
  export default component;
}

type GateReason = "not-japanese" | "low-confidence";

interface TextStyle {
  fontSize?: number;
  color?: string;
  strokeColor?: string;
  strokeWidth?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

interface Bbox {
  id?: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  confidence: number;
  /** the script gate held this region back (optional, cache-compatible) */
  gateSkip?: GateReason;
  /** all ladder inpaint rungs declined this region */
  inpaintDeclined?: boolean;
  /** typography and styling overrides for this text bubble */
  style?: TextStyle;
  /** fixed inpainting area if decoupled from render box */
  inpaintArea?: { x1: number; y1: number; x2: number; y2: number };
}

type Translations = string[];

interface SeriesContext {
  seriesName: string;
  summary: string;
  dictionary: string;

  // Tracking the last translated position
  lastChapterId: string | null;
  lastPageIndex: number | null;

  recentHistory: {
    chapterId: string;
    pageIndex: number;
    text: string;
  }[];

  translatedCount: number;
}

interface PageCache {
  bboxes: Bbox[];
  translations: Translations;
  sourceTexts?: string[];
  cleanedSrc?: string;
}

interface TranslationDiagnostics {
  expectedCount: number;
  receivedCount: number;
  /** Box indices whose output echoed the source; masked before rendering. */
  untranslated: number[];
  clean: boolean;
  /**
   * Model answer before parsing, capped at `RAW_RESPONSE_LIMIT` (4 KB).
   * Present on validation/parse failures too, so a Debug export can show
   * whether the page was truncated, the wrong shape, or an echo.
   */
  rawResponse?: string;
  /** LLM requests spent on this page (format fallbacks + correction round). */
  llmCalls?: number;
  /** Provider stop reason; "length"/"MAX_TOKENS" means the answer was cut. */
  finishReason?: string;
  /** Characters sent: system prompt + user prompt. */
  promptChars?: number;
  /** The validator never fabricates missing entries, so this is false today. */
  padded?: boolean;
  /** True when `finishReason` says the provider hit its output cap. */
  truncated?: boolean;
}

interface TranslateResult {
  translations: Translations;
  sourceTexts?: string[];
  context?: { summary: string; dictionary: string };
  diagnostics?: TranslationDiagnostics;
}

interface DebugEntry {
  id: string;
  timestamp: number;
  success: boolean;
  mode: string;
  version?: string;
  device?: string;
  backend?: "webgpu" | "wasm";
  sourceLang: string;
  targetLang: string;
  langGroup?: string;
  /** True when `langGroup` is a silent fallback, not a resolved model pack. */
  langGroupFallback?: boolean;
  bboxCount: number;
  sourceTexts?: string[];
  translations?: string[];
  untranslated?: number[];
  /** Model answer before parsing (first 4 KB) — see `TranslationDiagnostics`. */
  rawResponse?: string;
  /** LLM requests spent on this page. */
  llmCalls?: number;
  /** Provider stop reason; "length" means the answer was cut. */
  finishReason?: string;
  /** Characters sent: system prompt + user prompt. */
  promptChars?: number;
  /** Validator never fabricates entries, so this stays false today. */
  padded?: boolean;
  /** `finishReason` hit the output cap. */
  truncated?: boolean;
  timing: {
    detect?: number;
    ocr?: number;
    translate?: number;
    inpaint?: number;
    total?: number;
  };
  ocrMinConfidence?: number;
  detectionMinConfidence?: number;
  temperature?: number;
  serverSchema?: string;
  geminiModel?: string;
  inpaintMethod?: "fast" | "quality" | "fallback";
  gate?: {
    mode: "off" | "cjk" | "other" | "auto";
    checked: number;
    skipped: number;
    group?: string;
    unavailable?: boolean;
    /** OSD label the page majority settled on, when Auto-Detect named one. */
    label?: string;
    /** How `group` was chosen: the gate's own pick, explicit source, or latin fallback. */
    groupSource?: "gate" | "explicit" | "fallback";
  };
  inpaintStats?: {
    fill: number;
    denoise: number;
    lama: number;
    telea: number;
    rectTelea: number;
    declined: number;
    skipped: number;
  };
  inpaintError?: string;
  /** First real LaMa failure on the page. A size skip is a note, never this. */
  inpaintLamaError?: string;
  /** Quality runs only: what the LaMa stage did, counted in boxes. */
  lamaStages?: {
    painted: number;
    skippedSize: number;
    failed: number;
    notAttempted: number;
  };
  models: {
    detection?: string;
    ocr?: string;
    llm?: string;
    server?: string;
  };
  error?: string;
}

type ExtractSource = "title" | "path" | "hash";

interface SiteRule {
  id: string;
  domain: string;
  seriesName: {
    regex: string;
    source: ExtractSource;
  };
  chapterId: {
    regex: string;
    source: ExtractSource;
  };
  pageIndex: {
    regex: string;
    source: ExtractSource;
  };
  /** CSS selector targeting the manga reader container element */
  containerSelector?: string;
  /** CSS selector targeting chapter page <img> elements */
  imageSelector?: string;
  /** Where to anchor the floating translate pill on each image */
  pillPosition?: string,
  /** Where to initially position the floating toolbar overlay */
  toolbarPosition?: string,
}

type AIGeneratedRule = Omit<SiteRule, "id" | "domain">;
