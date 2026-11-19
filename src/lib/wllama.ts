import type { Wllama } from "@wllama/wllama";
import { DefaultConfig, llmModelDef, type LlmModelDef } from "./configs";
import { buildSiteRulePrompts, buildTranslationPrompts } from "./prompts";
import {
  attachDiagnostics,
  clipRawResponse,
  isTranslationValidationError,
  mergeRunInfo,
  parseLlmJson,
  promptChars,
  validateTranslationResult,
  type LlmRunInfo,
  type ValidatedTranslation,
} from "./server/validator";
import {
  keepBetterTranslation,
  untranslatedCorrectionPrompt,
} from "./server/correction";
import { fetchAndCacheWithProgress } from "./utils";
// Bundled at build time (8.4MB .wasm asset, not .js — outside the AMO
// 2MB-per-.js rule). Never the CDN variant (remote code is rejected).
import wllamaWasmUrl from "@wllama/wllama/src/wasm/wllama.wasm?url";

// Dynamic-only, same as webllm.ts: keeps the engine out of initial chunks.
const loadWllama = () => import("@wllama/wllama");

let wllama: Wllama | null = null;
let loadedModelId: string | null = null;

export function ggufUrl(def: LlmModelDef): string {
  return `https://huggingface.co/${def.repo}/resolve/main/${def.file}`;
}

async function cachedGgufBlob(def: LlmModelDef): Promise<Blob | null> {
  try {
    const cache = await caches.open(def.repo as string);
    const res = await cache.match(ggufUrl(def));
    if (!res || !res.ok) return null;
    const blob = await res.blob();
    return blob.size > 1024 ? blob : null;
  } catch {
    return null;
  }
}

/**
 * Lightweight GGUF presence check for cache-status probes. Uses the stored
 * content-length header instead of reading the body: a multi-GB blob()
 * can stall the check.
 */
export async function isWllamaModelCached(def: LlmModelDef): Promise<boolean> {
  try {
    if (!def.repo || !def.file) return false;
    const cache = await caches.open(def.repo);
    const res = await cache.match(ggufUrl(def));
    if (!res || !res.ok) return false;
    const size = parseInt(res.headers.get("content-length") ?? "0", 10);
    if (size > 1024) return true;
    // No content-length stored (older entries) — fall back to blob size.
    if (!res.headers.get("content-length")) {
      const blob = await res.blob();
      return blob.size > 1024;
    }
    return false;
  } catch {
    return false;
  }
}

/** Load can stall silently (blocked worker, slow ingest) — fail loudly instead. */
const LOAD_TIMEOUT_MS = 10 * 60 * 1000;

async function ensureWllama(
  def: LlmModelDef,
  onProgress?: (loaded: number, total: number) => void,
  onStage?: (text: string) => void,
  signal?: AbortSignal,
): Promise<Wllama> {
  if (wllama && loadedModelId === def.id && wllama.isModelLoaded()) {
    return wllama;
  }
  if (wllama) {
    try {
      await wllama.exit();
    } catch {
      // ignore teardown errors when switching models
    }
    wllama = null;
    loadedModelId = null;
  }
  onStage?.("Starting runtime…");
  const createInstance = async () => {
    const { Wllama: WllamaClass, LoggerWithoutDebug } = await loadWllama();
    return new WllamaClass({ default: wllamaWasmUrl }, {
      logger: LoggerWithoutDebug,
      suppressNativeLog: true,
    });
  };
  let instance = await createInstance();

  onStage?.("Reading cached model…");
  let blob = await cachedGgufBlob(def);
  if (!blob) {
    await fetchAndCacheWithProgress(
      def.repo as string,
      def.file as string,
      onProgress,
      { signal },
    );
    blob = await cachedGgufBlob(def);
    if (!blob) throw new Error("GGUF download produced no cached file");
  }

  onStage?.("Loading weights into memory — first run takes minutes…");
  // ponytail: n_ctx 4096 keeps 4B GGUF KV cache within 32-bit wasm memory limits; raise if translation prompts exceed 1500 tokens
  const params = { n_ctx: 4096 };
  const load = (async () => {
    try {
      await instance.loadModel([blob], { ...params, n_gpu_layers: 999999 });
    } catch (err) {
      // WebGPU-by-default builds can fail where WebGPU is unavailable or
      // blocked: retry pure CPU on a fresh instance before giving up.
      const msg = (err as Error)?.message ?? "";
      if (/webgpu|gpu|dawn|abort|crash|pipeline|shader/i.test(msg)) {
        try {
          await instance.exit();
        } catch {}
        instance = await createInstance();
        await instance.loadModel([blob], { ...params, n_gpu_layers: 0 });
      } else {
        throw err;
      }
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            "GGUF load timed out after 10 minutes — check the setup-tab console for worker/CSP errors",
          ),
        ),
      LOAD_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([load, timeout]);
  } catch (err) {
    try {
      await instance.exit();
    } catch {}
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  wllama = instance;
  loadedModelId = def.id;
  return instance;
}

/** Explicit download step for setup UI (progress) — reuses the shared model cache. */
export async function downloadWllamaModel(
  def: LlmModelDef,
  onProgress?: (loaded: number, total: number) => void,
  onStage?: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  await ensureWllama(def, onProgress, onStage, signal);
}

export async function resetWllama(): Promise<void> {
  if (wllama) {
    try {
      await wllama.exit();
    } catch {
      // ignore teardown errors
    }
    wllama = null;
    loadedModelId = null;
  }
}

/** In-flight local jobs; a release requested mid-page is deferred (LMT-029). */
let activeJobs = 0;
let releasePending = false;

/**
 * Free the resident GGUF engine. Mirrors `webllm.ts` `releaseLocalLlm()`:
 * `applyMode()` calls it when the user leaves Local, and keeping a 2 GB model
 * loaded in the Firefox background iframe for the rest of the session is the
 * same regression LMT-029 fixed on Chrome.
 */
export async function releaseLocalLlm(): Promise<void> {
  await resetWllama();
}

/** Mode-change seam. Gemini ↔ API touches no local engine, so it is a no-op. */
export async function applyMode(mode: string | null | undefined): Promise<void> {
  if (mode === "webgpu") return;
  await releaseLocalLlm();
}

/** Release unless a page is mid-translation; the last job runs it instead. */
export async function releaseLocalLlmIdle(): Promise<boolean> {
  if (activeJobs > 0) {
    releasePending = true;
    return false;
  }
  await releaseLocalLlm();
  return true;
}

/** Job counter for deferred releases — see `withLocalLlmJob` in webllm.ts. */
export async function withLocalLlmJob<T>(task: () => Promise<T>): Promise<T> {
  activeJobs++;
  try {
    return await task();
  } finally {
    activeJobs--;
    if (activeJobs === 0 && releasePending) {
      releasePending = false;
      void releaseLocalLlm();
    }
  }
}

export async function deleteWllamaCache(def: LlmModelDef): Promise<void> {
  if (wllama && loadedModelId === def.id) {
    await resetWllama();
  }
  try {
    const cache = await caches.open(def.repo as string);
    await cache.delete(ggufUrl(def));
  } catch {
    // cache already gone — nothing to do
  }
}

export function isWllamaModelLoaded(id: string): boolean {
  return !!wllama && loadedModelId === id && wllama.isModelLoaded();
}

export interface WllamaGpuCapability {
  ok: boolean;
  reason: "webgpu-ready" | "no-navigator-gpu" | "no-jspi" | "no-adapter";
  /** human-readable cause, persisted to the debug log when WebGPU is unusable */
  detail: string;
}

/**
 * Pre-check whether this browser can run wllama on WebGPU. The three
 * probes mirror @wllama/wllama src/utils.ts (isSupportWebGPU /
 * isSupportJSPI) plus an adapter request; they are inlined so the check
 * runs without instantiating Wllama. An adapter alone is NOT enough on
 * Firefox: without JSPI wllama disables WebGPU and falls back to CPU.
 */
export async function canUseWllamaWebGPU(): Promise<WllamaGpuCapability> {
  if (!(navigator as any)?.gpu) {
    return {
      ok: false,
      reason: "no-navigator-gpu",
      detail: "navigator.gpu missing — enable dom.webgpu.enabled in about:config",
    };
  }
  if (!(WebAssembly as any)?.Suspending) {
    return {
      ok: false,
      reason: "no-jspi",
      detail:
        "WebAssembly.Suspending (JSPI) missing — enable javascript.options.wasm_js_promise_integration in about:config",
    };
  }
  try {
    const adapter = await (navigator as any).gpu.requestAdapter();
    if (!adapter) {
      return {
        ok: false,
        reason: "no-adapter",
        detail: "navigator.gpu present but requestAdapter() returned null",
      };
    }
  } catch (e) {
    return {
      ok: false,
      reason: "no-adapter",
      detail: `requestAdapter() threw: ${(e as Error)?.message ?? String(e)}`,
    };
  }
  return { ok: true, reason: "webgpu-ready", detail: "WebGPU adapter + JSPI available" };
}

async function runWllamaModel(
  systemPrompt: string,
  userPrompt: string,
  schema: string,
  def: LlmModelDef,
  temperature = DefaultConfig.llmTemperature,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw abortError(signal);
  const instance = await ensureWllama(def, undefined, undefined, signal);
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ] as { role: "system" | "user" | "assistant"; content: string }[];

  // Disable Qwen thinking mode when the template supports it; harmless otherwise.
  let chat_template_kwargs: Record<string, unknown> | undefined;
  try {
    const tpl = instance.getChatTemplate() ?? "";
    if (tpl.includes("thinking")) chat_template_kwargs = { enable_thinking: false };
  } catch {
    // template unreadable — proceed without kwargs
  }

  const parsedSchema = JSON.parse(schema);
  const attempts: ({ type: "json_schema" } | { type: "json_object" } | null)[] =
    [
      { type: "json_schema" },
      { type: "json_object" },
      null, // unconstrained fallback; parseLlmJson below still applies
    ];
  let resultText = "";
  let llmPerf: LlmPerf | undefined;
  let llmFinishReason: string | undefined;
  let lastErr: unknown = null;
  for (const mode of attempts) {
    try {
      const t0 = performance.now();
      const reply = await instance.createChatCompletion({
        messages,
        temperature,
        max_tokens: 1024,
        timings_per_token: true,
        ...(signal ? { abortSignal: signal } : {}),
        ...(chat_template_kwargs ? { chat_template_kwargs } : {}),
        ...(mode === null
          ? {}
          : mode.type === "json_schema"
            ? {
                response_format: {
                  type: "json_schema",
                  json_schema: {
                    name: "translation",
                    schema: parsedSchema,
                  },
                },
              }
            : { response_format: { type: "json_object" } }),
      });
      llmPerf = extractWllamaPerf(reply, performance.now() - t0);
      resultText = reply.choices[0].message.content as string;
      llmFinishReason = reply.choices[0].finish_reason ?? undefined;
      break;
    } catch (err) {
      lastErr = err;
      // A deadline abort is not a dead worker: keep the engine loaded so the
      // next page does not pay a multi-minute GGUF reload (LMT-010).
      if (signal?.aborted) throw abortError(signal);
      const msg = (err as Error)?.message ?? String(err);
      if (/crash|abort/i.test(msg)) {
        // Worker aborted or crashed — instance dead. Reset singleton to prevent poisoning future attempts.
        await resetWllama();
        throw err instanceof Error ? err : new Error(String(err));
      }
    }
  }
  if (!resultText) {
    const msg = (lastErr as Error)?.message ?? String(lastErr);
    if (/crash|abort/i.test(msg)) {
      await resetWllama();
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  const info: LlmRunInfo = {
    rawResponse: clipRawResponse(resultText),
    finishReason: llmFinishReason,
    promptChars: promptChars(systemPrompt, userPrompt),
  };
  try {
    return { data: parseLlmJson(resultText), info, llmPerf };
  } catch (error) {
    console.error("Failed to parse LLM output:", resultText);
    throw attachDiagnostics(
      new Error(`Local LLM generated invalid JSON: ${(error as Error).message}`),
      info,
    );
  }
}

/** Reuse the caller's abort reason so the user sees "Timed out after Ns: …". */
function abortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  return new DOMException("Translation job cancelled", "AbortError");
}

/**
 * Token stats for one wllama request. The non-streaming response type
 * carries usage but no timings, so prefer the llama-server timings block
 * when the runtime includes it and fall back to wall-clock decode rate.
 */
function extractWllamaPerf(reply: unknown, totalMs: number): LlmPerf | undefined {
  const raw = reply as unknown as {
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    timings?: {
      prompt_n?: number;
      predicted_n?: number;
      prompt_ms?: number;
      predicted_ms?: number;
      prompt_per_second?: number;
      predicted_per_second?: number;
    };
  };
  const usage = raw?.usage;
  const t = raw?.timings;
  if (!usage && !t) return undefined;
  const promptTokens = usage?.prompt_tokens ?? t?.prompt_n;
  const completionTokens = usage?.completion_tokens ?? t?.predicted_n;
  const promptTps = t?.prompt_per_second;
  const genTps = t?.predicted_per_second ??
    (totalMs > 0 && completionTokens
      ? completionTokens / (totalMs / 1000)
      : undefined);
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(t?.prompt_ms !== undefined ? { promptMs: t.prompt_ms } : {}),
    ...(t?.predicted_ms !== undefined ? { genMs: t.predicted_ms } : {}),
    ...(promptTps !== undefined ? { promptTps } : {}),
    ...(genTps !== undefined ? { genTps } : {}),
    totalMs,
  };
}

export async function translateWithWllama(
  ocrResults: string[],
  targetLang: string,
  sourceLang: string,
  seriesContext?: SeriesContext,
  model?: string,
  temperature = DefaultConfig.llmTemperature,
  /** Auto-Detect only: the script the OCR gate identified (LMT-030). */
  detectedLabel?: string | null,
  /** Cancels generation at the job deadline (LMT-010). */
  signal?: AbortSignal,
): Promise<TranslateResult> {
  // One unit per page: the answer and its correction retry must not be split
  // by a release requested between them (LMT-029).
  return withLocalLlmJob(() =>
    translateWithWllamaUncounted(
      ocrResults,
      targetLang,
      sourceLang,
      seriesContext,
      model,
      temperature,
      detectedLabel,
      signal,
    ),
  );
}

async function translateWithWllamaUncounted(
  ocrResults: string[],
  targetLang: string,
  sourceLang: string,
  seriesContext?: SeriesContext,
  model?: string,
  temperature = DefaultConfig.llmTemperature,
  /** Auto-Detect only: the script the OCR gate identified (LMT-030). */
  detectedLabel?: string | null,
  /** Cancels generation at the job deadline (LMT-010). */
  signal?: AbortSignal,
): Promise<TranslateResult> {
  if (signal?.aborted) throw abortError(signal);
  if (!ocrResults || ocrResults.length === 0) {
    return { translations: [] };
  }
  const def = llmModelDef(model);

  const { systemPrompt, userPrompt, schema } = buildTranslationPrompts(
    ocrResults,
    targetLang,
    sourceLang,
    seriesContext,
    detectedLabel,
  );

  const calls: LlmRunInfo[] = [];
  let first: Awaited<ReturnType<typeof runWllamaModel>>;
  try {
    first = await runWllamaModel(
      systemPrompt,
      userPrompt,
      JSON.stringify(schema),
      def,
      temperature,
      signal,
    );
  } catch (error) {
    throw attachDiagnostics(error, mergeRunInfo(calls));
  }
  calls.push(first.info);
  // Token stats are additive debug data; absent when the runtime omits timings.
  const withPerf = (result: ValidatedTranslation): TranslateResult =>
    first.llmPerf ? { ...result, llmPerf: first.llmPerf } : result;

  try {
    const validated = validateTranslationResult(first.data, ocrResults.length, {
      sourceTexts: ocrResults,
      sourceLang,
      targetLang,
      run: mergeRunInfo(calls),
    });
    return withPerf(
      await correctUntranslatedWllama(
        validated,
        systemPrompt,
        userPrompt,
        JSON.stringify(schema),
        def,
        temperature,
        ocrResults,
        sourceLang,
        targetLang,
        calls,
        signal,
      ),
    );
  } catch (error) {
    if (!isTranslationValidationError(error)) throw error;

    console.warn(
      `[wllama] validation failed (${error.code}): ${error.message} — requesting correction`,
    );
    try {
      const corrected = await runWllamaModel(
        systemPrompt,
        `${userPrompt}\n\nCORRECTION: ${error.message}\nReturn the full corrected JSON now.`,
        JSON.stringify(schema),
        def,
        temperature,
        signal,
      );
      calls.push(corrected.info);
      return withPerf(
        validateTranslationResult(corrected.data, ocrResults.length, {
          sourceTexts: ocrResults,
          sourceLang,
          targetLang,
          run: mergeRunInfo(calls),
        }),
      );
    } catch (retryError) {
      throw attachDiagnostics(retryError, mergeRunInfo(calls));
    }
  }
}

/**
 * One correction round for boxes the validator refused (C3). The page parsed
 * and every box has an entry, so this is not the format-failure path above:
 * the model simply left some boxes empty, echoed, or in the wrong language.
 */
async function correctUntranslatedWllama(
  first: ValidatedTranslation,
  systemPrompt: string,
  userPrompt: string,
  schemaStr: string,
  def: LlmModelDef,
  temperature: number,
  ocrResults: string[],
  sourceLang: string,
  targetLang: string,
  calls: LlmRunInfo[],
  signal?: AbortSignal,
): Promise<ValidatedTranslation> {
  const flagged = first.diagnostics.untranslated;
  if (flagged.length === 0) return first;

  try {
    const correctionPrompt = untranslatedCorrectionPrompt(flagged);
    const corrected = await runWllamaModel(
      systemPrompt,
      `${userPrompt}\n\nCORRECTION: ${correctionPrompt}\nReturn the full corrected JSON now.`,
      schemaStr,
      def,
      temperature,
      signal,
    );
    calls.push(corrected.info);
    const second = validateTranslationResult(corrected.data, ocrResults.length, {
      sourceTexts: ocrResults,
      sourceLang,
      targetLang,
      run: mergeRunInfo(calls),
    });
    return keepBetterTranslation(first, second);
  } catch (error) {
    console.warn(
      `[wllama] untranslated correction failed — keeping the first answer:`,
      error,
    );
    return first;
  }
}

export async function makeSiteRuleWithWllama(
  title: string,
  path: string,
  model?: string,
  temperature = DefaultConfig.llmTemperature,
  signal?: AbortSignal,
): Promise<AIGeneratedRule> {
  return withLocalLlmJob(() =>
    makeSiteRuleWithWllamaUncounted(title, path, model, temperature, signal),
  );
}

async function makeSiteRuleWithWllamaUncounted(
  title: string,
  path: string,
  model?: string,
  temperature = DefaultConfig.llmTemperature,
  signal?: AbortSignal,
): Promise<AIGeneratedRule> {
  if (signal?.aborted) throw abortError(signal);
  const def = llmModelDef(model);
  const { systemPrompt, userPrompt, schema } = buildSiteRulePrompts(
    title,
    path,
  );

  const { data } = await runWllamaModel(
    systemPrompt,
    userPrompt,
    JSON.stringify(schema),
    def,
    temperature,
    signal,
  );
  return data as AIGeneratedRule;
}
