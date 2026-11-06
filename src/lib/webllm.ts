import type { MLCEngine } from "@mlc-ai/web-llm";
import { DefaultConfig, normalizeLlmModel } from "./configs";
import { createLlmEngine } from "./llm-engine";
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
} from "./server/validator";

let globalEngine: MLCEngine | null = null;
let currentlyLoadedModel: string | null = null;
/** In-flight translate jobs; a release requested mid-page is deferred to the last one (LMT-029). */
let activeJobs = 0;
let releasePending = false;

/**
 * Free the local LLM. Called when the user leaves Local mode or turns the
 * Translation GPU toggle off: the offscreen document otherwise lives for the
 * whole browser session and keeps 1–3 GB of VRAM plus the weights loaded
 * (LMT-029).
 *
 * The globals are cleared *before* awaiting `unload()` so a translate that
 * starts during teardown creates a fresh engine instead of grabbing the one
 * being disposed. `unload()` failures are not fatal — the pointers are already
 * gone, and the next translate reloads from cache.
 */
export async function releaseLocalLlm(): Promise<void> {
  const engine = globalEngine;
  globalEngine = null;
  currentlyLoadedModel = null;
  if (!engine) return;
  try {
    await engine.unload();
    console.info("[webllm] local LLM unloaded (VRAM freed)");
  } catch (err) {
    console.warn("[webllm] unload during release failed:", err);
  }
}

/**
 * Mode-change seam. Only leaving Local needs the VRAM back; switching
 * Gemini ↔ API touches no local engine, so it must not force a 3–6 GB reload
 * for a user who comes back.
 */
export async function applyMode(mode: string | null | undefined): Promise<void> {
  if (mode === "webgpu") return;
  await releaseLocalLlm();
}

/**
 * Release unless a page is mid-translation — aborting `chatCompletion` here
 * would turn a mode flip into a failed page. The last job's `finally` runs the
 * deferred release instead.
 */
export async function releaseLocalLlmIdle(): Promise<boolean> {
  if (activeJobs > 0) {
    releasePending = true;
    return false;
  }
  await releaseLocalLlm();
  return true;
}

/**
 * WebLLM has no `AbortSignal` support: `chatCompletion` runs until it decides
 * to stop. `interruptGenerate()` is the only way to end the decode loop early,
 * so a cancelled job is honoured by interrupting the engine the request is
 * already running on (LMT-010).
 *
 * The rejection reuses `signal.reason` when the caller supplied one, so a
 * deadline abort keeps the "Timed out after Ns: TRANSLATE_IMAGE" text the
 * background uses everywhere else.
 */
function abortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  return new DOMException("Translation job cancelled", "AbortError");
}

export async function translateLocal(
  ocrResults: string[],
  targetLang: string,
  sourceLang: string,
  seriesContext?: SeriesContext,
  model = DefaultConfig.llmModels[0].id,
  temperature = DefaultConfig.llmTemperature,
  /** Auto-Detect only: the script the OCR gate identified. */
  detectedLabel?: string | null,
  /** Cancels generation at the job deadline (LMT-010). */
  signal?: AbortSignal,
): Promise<TranslateResult> {
  // Registered here (not in runLLMModel) so the answer and its correction
  // round-trip are one unit: a release requested between them waits instead of
  // tearing the engine out mid-page (LMT-029).
  return withLocalLlmJob(() =>
    translateLocalUncounted(
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

async function translateLocalUncounted(
  ocrResults: string[],
  targetLang: string,
  sourceLang: string,
  seriesContext?: SeriesContext,
  model = DefaultConfig.llmModels[0].id,
  temperature = DefaultConfig.llmTemperature,
  /** Auto-Detect only: the script the OCR gate identified. */
  detectedLabel?: string | null,
  /** Cancels generation at the job deadline (LMT-010). */
  signal?: AbortSignal,
): Promise<TranslateResult> {
  signal?.throwIfAborted();
  const resolvedModel = normalizeLlmModel(model);
  if (!ocrResults || ocrResults.length === 0) {
    return { translations: [] };
  }
  const { systemPrompt, userPrompt, schema } = buildTranslationPrompts(
    ocrResults,
    targetLang,
    sourceLang,
    seriesContext,
    detectedLabel,
  );

  const calls: LlmRunInfo[] = [];
  let raw: any;
  try {
    const first = await runLLMModel(
      systemPrompt,
      userPrompt,
      schema,
      resolvedModel,
      temperature,
      signal,
    );
    calls.push(first.info);
    raw = first.data;
  } catch (error) {
    throw attachDiagnostics(error, mergeRunInfo(calls));
  }

  try {
    return validateTranslationResult(raw, ocrResults.length, {
      sourceTexts: ocrResults,
      sourceLang,
      targetLang,
      run: mergeRunInfo(calls),
    });
  } catch (error) {
    if (!isTranslationValidationError(error)) throw error;

    console.warn(
      `[webllm] validation failed (${error.code}): ${error.message} — requesting correction`,
    );
    try {
      const corrected = await runLLMModel(
        systemPrompt,
        `${userPrompt}\n\nCORRECTION: ${error.message}\nReturn the full corrected JSON now.`,
        schema,
        resolvedModel,
        temperature,
        signal,
      );
      calls.push(corrected.info);
      return validateTranslationResult(corrected.data, ocrResults.length, {
        sourceTexts: ocrResults,
        sourceLang,
        targetLang,
        run: mergeRunInfo(calls),
      });
    } catch (retryError) {
      throw attachDiagnostics(retryError, mergeRunInfo(calls));
    }
  }
}

export async function makeSiteRuleLocal(
  title: string,
  path: string,
  model = DefaultConfig.llmModels[0].id,
  temperature = DefaultConfig.llmTemperature,
  signal?: AbortSignal,
): Promise<AIGeneratedRule> {
  const resolvedModel = normalizeLlmModel(model);
  const { systemPrompt, userPrompt, schema } = buildSiteRulePrompts(
    title,
    path,
  );

  const { data } = await withLocalLlmJob(() =>
    runLLMModel(
      systemPrompt,
      userPrompt,
      schema,
      resolvedModel,
      temperature,
      signal,
    ),
  );
  return data;
}

async function runLLMModel(
  systemPrompt: string,
  userPrompt: string,
  schema: object,
  model: string,
  temperature: number,
  signal?: AbortSignal,
): Promise<{ data: any; info: LlmRunInfo }> {
  if (signal?.aborted) throw abortError(signal);

  if (!globalEngine) {
    globalEngine = createLlmEngine();
  }

  if (currentlyLoadedModel !== model) {
    await globalEngine.reload(model);
    currentlyLoadedModel = model;
  }

  // `interruptGenerate()` stops the decode loop, but `chatCompletion` then
  // resolves with whatever was decoded so far (possibly nothing usable), so
  // the job must also reject: the promise below races the interrupt signal.
  const engine = globalEngine;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    if (!signal) return;
    onAbort = () => {
      engine.interruptGenerate().catch(() => {});
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    if (signal?.aborted) throw abortError(signal);

    const reply = await Promise.race([
      engine.chatCompletion({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature,
        response_format: {
          type: "json_object",
          schema: JSON.stringify(schema),
        },
      }),
      interrupted,
    ]);

    const content = reply.choices[0]?.message?.content;
    if (!content) {
      throw new Error("Local LLM returned empty response");
    }

    // WebLLM reports OpenAI-style `finish_reason`; "length" means the answer hit
    // `max_tokens` and was cut, which the Debug export must show (LMT-032).
    const info: LlmRunInfo = {
      rawResponse: clipRawResponse(content),
      finishReason: reply.choices[0]?.finish_reason,
      promptChars: promptChars(systemPrompt, userPrompt),
    };

    try {
      return { data: parseLlmJson(content), info };
    } catch (error) {
      console.error("Failed to parse LLM output:", content);
      // Keep the raw answer reachable: a parse failure is the one case where the
      // Debug export is the only way to see what the model actually wrote.
      throw attachDiagnostics(
        new Error(
          `Local LLM generated invalid JSON: ${(error as Error).message}`,
        ),
        info,
      );
    }
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Job counter for deferred releases (LMT-029). `runLLMModel` is the only place
 * that keeps the engine busy, so enter/exit is textually adjacent to it here.
 */
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
