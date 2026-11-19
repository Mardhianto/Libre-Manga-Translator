// Shared heavy-inference handlers. Executed in the offscreen document on
// Chrome (MV3, via OFFSCREEN_* messages) and in offscreen.html hosted in a
// hidden background-page iframe on Firefox (MV2 has no offscreen API — see
// ensureFirefoxInferencePage). This module must never be statically imported
// by the background or content-script entries: it pulls onnxruntime-web and
// the full detection/OCR/inpaint pipeline, which would bust the single-file
// AMO size limit. Keep it free of CSS imports and DOM-at-import-time side
// effects so it stays clean in both hosts.
import { UNKNOWN_DETECTION_MODEL_MESSAGE, detectTextBubble, releaseDetection } from "./detections/main";
import { makeSiteRuleWithGemini, translateTextWithGemini, translateWithGemini } from "./gemini/main";
import { releaseOcrEngines, textRecognise } from "./ocr/main";
import {
  makeSiteRuleWithServer,
  translateWithServer,
} from "./server/main";
import { diagnosticsFromError } from "./server/validator";
import { isTransientError } from "./request-retry";
// NOTE: @mlc-ai/web-llm must stay dynamically imported (see webllm.ts and
// the FIREFOX gates below). A static import would bake the multi-MB
// prebundled file into shared initial chunks and break the 2MB-per-.js
// Firefox AMO limit. Same for @wllama/wllama (lib/wllama.ts).
import {
  applyMode,
  makeSiteRuleLocal,
  releaseLocalLlmIdle,
  translateLocal,
} from "./webllm";
import type { WllamaGpuCapability } from "./wllama";
import { DefaultConfig, SUPPORTED_LANG_GROUPS, llmModelDef, normalizeDetectionModel, resolveLangGroup } from "./configs";
import { env } from "./env";
import { ensureGpuState, gpuEnabledFor, refreshGpuState } from "./gpu-runtime";
import { checkWebGPUHighPerf, ensureWasmPaths } from "./hardware";
import { downloadArtifactHF, isArtifactCached, yieldToMain } from "./utils";
import { inpaintImageAuto, inpaintImageQuality } from "./inpaint/ladder";
import { getCachedSegmentation } from "./detections/segmentation";
import { releaseGate } from "./gate/osd";
import { releaseLama } from "./inpaint/lama";

/**
 * WebLLM reply for a mode that needs the local engine while the Translation
 * GPU toggle is off. Fail loud with the switch to flip instead of silently
 * loading 3-6 GB of weights the user explicitly disabled (LMT-028).
 */
const LLM_GPU_DISABLED_MESSAGE =
  "GPU acceleration for Translation is off. Enable Settings → GPU acceleration → Translation, or switch to Gemini / API mode.";

/**
 * Per-job execution deadline, owned by the context that actually runs the
 * request (LMT-010).
 *
 * The background service worker cannot cancel a `fetch` living in this
 * document, so it only forwards the budget and keeps a later last-resort guard
 * for the case where this document died. Aborting here is what closes the
 * socket / ends the decode loop while the slot is still held.
 */
function jobDeadline(
  timeoutMs: unknown,
  stage: string,
): { signal?: AbortSignal; dispose: () => void } {
  if (typeof timeoutMs !== "number" || !(timeoutMs > 0)) {
    return { dispose: () => {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new DOMException(
        `Timed out after ${Math.round(timeoutMs / 1000)}s: ${stage}`,
        "AbortError",
      ),
    );
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

function stageName(type: unknown): string {
  return String(type ?? "JOB").replace(/^OFFSCREEN_/, "");
}

/**
 * `fetch` and WebLLM reject with their own generic abort text ("The user
 * aborted a request"), which drops the stage name. When the deadline is what
 * fired, rewrite the error so the user sees the same "Timed out after Ns:
 * STAGE" line the background guard produces.
 *
 * The raw answer and call count a backend already attached (LMT-032) must
 * survive the rewrite, or a timed-out page loses the very facts that explain
 * it.
 */
function timedOutError(
  err: unknown,
  signal: AbortSignal | undefined,
  timeoutMs: unknown,
  stage: string,
): unknown {
  const isAbort = (err as Error | undefined)?.name === "AbortError";
  if (!signal?.aborted || !isAbort) return err;
  if (typeof timeoutMs !== "number") return err;
  const timeout = new DOMException(
    `Timed out after ${Math.round(timeoutMs / 1000)}s: ${stage}`,
    "AbortError",
  );
  const run = (err as { lmtDiagnostics?: unknown }).lmtDiagnostics;
  if (run !== undefined) {
    Object.defineProperty(timeout, "lmtDiagnostics", {
      value: run,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return timeout;
}

/**
 * Failure replies keep the run facts the backend stamped on the error
 * (LMT-032). Without this, a truncated or unparseable answer reached the Debug
 * panel as a bare message, which is the one case where the raw response is the
 * whole diagnosis.
 *
 * Only the run fields are sent: a failed page has no expected/received count,
 * and inventing zeros would read like a validation measurement.
 */
function errorResponse(err: unknown) {
  const run = diagnosticsFromError(err);
  return {
    error: (err as Error).message,
    ...(run ? { diagnostics: run } : {}),
    ...(isTransientError(err) ? { transient: true } : {}),
  };
}

/**
 * Boxes whose recognition failed or lost half their lines. Gate-skipped boxes
 * are excluded on purpose: they were held back deliberately, not failed.
 *
 * The content script needs this because `""` in `sourceTexts` is otherwise
 * indistinguishable from a legitimately empty bubble, and that ambiguity is
 * exactly why a broken page could be cached as a finished one.
 */
function ocrFailureIndexes(
  results: { failed?: boolean; partial?: boolean; gateSkip?: unknown }[],
): number[] {
  return results
    .map((r, i) => (!r.gateSkip && (r.failed || r.partial) ? i : -1))
    .filter((i) => i >= 0);
}

async function translateLocalRouted(
  ocrTexts: string[],
  targetLang: string,
  sourceLang: string,
  seriesContext: SeriesContext | undefined,
  llmModel: string,
  llmTemperature: number,
  detectedLabel?: string | null,
  signal?: AbortSignal,
): Promise<TranslateResult> {
  const def = llmModelDef(llmModel);
  // FIREFOX-gated so Chrome builds drop the wllama chunk + wasm entirely
  // (dead-branch elimination at build time); mirrored in webllm.ts/setup.
  if (def.engine === "wllama" && import.meta.env.FIREFOX) {
    const { translateWithWllama } = await import("./wllama");
    return translateWithWllama(
      ocrTexts,
      targetLang,
      sourceLang,
      seriesContext,
      def.id,
      llmTemperature,
      detectedLabel,
      signal,
    );
  }
  return translateLocal(
    ocrTexts,
    targetLang,
    sourceLang,
    seriesContext,
    def.id,
    llmTemperature,
    detectedLabel,
    signal,
  );
}

async function makeSiteRuleLocalRouted(
  title: string,
  path: string,
  llmModel: string,
  llmTemperature: number,
  signal?: AbortSignal,
): Promise<AIGeneratedRule> {
  const def = llmModelDef(llmModel);
  if (def.engine === "wllama" && import.meta.env.FIREFOX) {
    const { makeSiteRuleWithWllama } = await import("./wllama");
    return makeSiteRuleWithWllama(title, path, def.id, llmTemperature, signal);
  }
  return makeSiteRuleLocal(title, path, def.id, llmTemperature, signal);
}

/**
 * Release whichever local engine this build actually runs (LMT-029): wllama on
 * Firefox, WebLLM on Chrome. Keep the positive `import.meta.env.FIREFOX` form
 * so Chrome still drops the wllama chunk at build time.
 */
async function releaseLocalLlmRouted(mode?: string | null): Promise<void> {
  if (import.meta.env.FIREFOX) {
    const { applyMode: applyWllamaMode } = await import("./wllama");
    await applyWllamaMode(mode);
    return;
  }
  await applyMode(mode);
}

/** Same split for the deferred (mid-page) release. */
async function releaseLocalLlmIdleRouted(): Promise<boolean> {
  if (import.meta.env.FIREFOX) {
    const { releaseLocalLlmIdle: releaseWllamaIdle } = await import("./wllama");
    return releaseWllamaIdle();
  }
  return releaseLocalLlmIdle();
}

async function detectBackend(): Promise<{ backend: "webgpu" | "wasm"; reason?: string }> {
  try {
    if ("gpu" in navigator) {
      const adapter = await (navigator.gpu as any).requestAdapter({ powerPreference: "high-performance" });
      if (adapter) return { backend: "webgpu" };
      return {
        backend: "wasm",
        reason: "navigator.gpu present but requestAdapter() returned null",
      };
    }
    return { backend: "wasm", reason: "navigator.gpu missing in inference context" };
  } catch (e) {
    return {
      backend: "wasm",
      reason: `adapter probe threw: ${(e as Error)?.message ?? String(e)}`,
    };
  }
}

function serverConfig(config: Record<string, any>) {
  return {
    serverHost: config.serverHost,
    serverSchema: config.serverSchema,
    serverModel: config.serverModel,
    useServerApiKey: config.useServerApiKey,
    serverApiKey: config.serverApiKey,
    temperature: config.llmTemperature,
    // Prompt budget knobs (LMT-024). Absent values fall back to
    // `DefaultConfig` inside `callServer`.
    numCtx: config.serverNumCtx,
    disableThinking: config.serverDisableThinking,
  };
}

/**
 * Resolve the provider actually usable for a local-LLM request.
 *
 * On Firefox the wllama probe is authoritative: an adapter without JSPI still
 * can't run WebGPU inference (wllama disables it), so a "webgpu" adapter
 * reading must not mask the real fallback cause.
 *
 * `gpuProbe` lets the image path start `canUseWllamaWebGPU()` before OCR so
 * the probe resolves during inference instead of adding latency; the text
 * path passes nothing and probes inline.
 */
async function resolveLocalBackend(
  def: ReturnType<typeof llmModelDef>,
  gpuProbe?: Promise<WllamaGpuCapability> | null,
): Promise<{
  backend: "webgpu" | "wasm";
  gpuUnavailableReason?: string;
}> {
  const gpu = gpuProbe ? await gpuProbe : null;
  const backendRes = await detectBackend();
  const backend: "webgpu" | "wasm" =
    gpu && !gpu.ok ? "wasm" : backendRes.backend;
  if (backend !== "wasm") return { backend };

  let gpuUnavailableReason: string;
  if (gpu && !gpu.ok) {
    // Firefox wllama path: about:config-specific detail.
    gpuUnavailableReason = gpu.detail;
  } else if (def.engine === "wllama" || import.meta.env.FIREFOX) {
    gpuUnavailableReason =
      backendRes.reason ?? "WebGPU unavailable in this context";
  } else {
    // Chrome build (WebLLM owns GPU init): actionable hint.
    gpuUnavailableReason = backendRes.reason
      ? `${backendRes.reason} — check chrome://gpu`
      : "WebGPU unavailable in this context — check chrome://gpu";
  }
  return { backend, gpuUnavailableReason };
}

/** Start the Firefox-only wllama capability probe, or null when unused. */
function startLocalGpuProbe(
  def: ReturnType<typeof llmModelDef>,
): Promise<WllamaGpuCapability> | null {
  // Keep the positive `engine && FIREFOX` form: Rollup only drops the dynamic
  // import (and therefore the wllama chunk) when the guard folds to `false`
  // inline. An early-return helper leaves the `import()` reachable.
  if (def.engine === "wllama" && import.meta.env.FIREFOX) {
    return import("./wllama").then((m) => m.canUseWllamaWebGPU());
  }
  return null;
}

export async function handleDetectBbox(msg: any): Promise<Bbox[]> {
  const { detectionModel, detectionMinConfidence } = msg.config;
  // The toggles are read here, not only on GPU_STATE_CHANGED: a page
  // translated before the user ever opens Settings must already honour
  // them (LMT-028).
  await ensureGpuState();
  await yieldToMain();
  return detectTextBubble(msg.data, detectionMinConfidence, detectionModel);
}

export async function handleTranslateImage(msg: any): Promise<unknown> {
  const {
    currentMode,
    targetLang,
    sourceLang,
    geminiKey,
    geminiModel,
    ocrMinConfidence,
    ocrEngine,
    llmModel,
    llmTemperature,
    serverHost,
    serverSchema,
    serverModel,
    useServerApiKey,
    serverApiKey,
    scriptGate,
    gateForce,
  } = msg.config;
  const { src, bboxes, seriesContext, rawText } = msg.data;
  const gateOptions = {
    enabled: scriptGate ?? true,
    force: gateForce ?? false,
  };
  const stage = stageName(msg.type);
  const deadline = jobDeadline(msg.timeoutMs, stage);

  /**
   * The persisted GPU toggles are read once per job: a page translated right
   * after a settings change — or before Settings was ever opened — must
   * agree with what the panel shows (LMT-028).
   */
  const gpuStateReady = ensureGpuState();

  /** The local engine is only allowed when the Translation GPU toggle is on. */
  const localLlmBlocked = async (): Promise<{ error: string } | null> => {
    await gpuStateReady;
    return gpuEnabledFor("llm") ? null : { error: LLM_GPU_DISABLED_MESSAGE };
  };

  /**
   * Text-only jobs (rawText) skip the image pipeline: OCR has already run
   * elsewhere, so the same three backends answer with a single region.
   */
  const runRawText = async (signal?: AbortSignal) => {
    await yieldToMain();
    const tTrans = performance.now();
    if (currentMode === "webgpu") {
      const blocked = await localLlmBlocked();
      if (blocked) return blocked;
      const def = llmModelDef(llmModel);
      const probe = startLocalGpuProbe(def);
      const { backend, gpuUnavailableReason } = await resolveLocalBackend(
        def,
        probe,
      );
      if (backend === "wasm") {
        const hint = gpuUnavailableReason ? ` (${gpuUnavailableReason})` : "";
        return {
          error:
            def.engine === "wllama" && import.meta.env.FIREFOX
              ? `Local model requires WebGPU acceleration on Firefox${hint}. ` +
                `Enable "dom.webgpu.enabled" and "javascript.options.wasm_js_promise_integration" in about:config, or switch to API / Gemini mode.`
              : `Local AI requires WebGPU — not available in this context${hint}. Switch to Gemini / API mode.`,
          gpuUnavailableReason,
        };
      }
      const res = await translateLocalRouted(
        [rawText],
        targetLang,
        sourceLang,
        seriesContext,
        llmModel,
        llmTemperature,
        undefined,
        signal,
      );
      return {
        ...res,
        sourceTexts: [rawText],
        gateSkip: [null],
        timing: { translate: performance.now() - tTrans },
        backend,
      };
    }
    if (currentMode === "api") {
      const res = await translateWithServer(
        [rawText],
        targetLang,
        sourceLang,
        seriesContext,
        serverConfig(msg.config),
        undefined,
        signal,
      );
      return {
        ...res,
        sourceTexts: [rawText],
        gateSkip: [null],
        timing: { translate: performance.now() - tTrans },
      };
    }
    const res = await translateTextWithGemini(
      rawText,
      geminiKey,
      targetLang,
      sourceLang,
      seriesContext,
      geminiModel,
      llmTemperature,
      undefined,
      signal,
    );
    return {
      ...res,
      sourceTexts: [rawText],
      gateSkip: [null],
      gate: { mode: "off", checked: 0, skipped: 0, unavailable: false },
      timing: { translate: performance.now() - tTrans },
    };
  };

  const runImage = async (signal?: AbortSignal) => {
    if (currentMode === "webgpu") {
      await yieldToMain();
      const blocked = await localLlmBlocked();
      if (blocked) return blocked;
      const tOcr = performance.now();
      const def = llmModelDef(llmModel);
      // wllama-only WebGPU capability probe (Firefox builds), started before
      // OCR so it resolves during inference instead of adding latency. The
      // branch stays FIREFOX-gated so Chrome builds drop the wllama chunk
      // entirely (dead-branch elimination at build time); the engine check
      // additionally skips it for stale webllm prefs on Firefox profiles.
      const gpuProbe = startLocalGpuProbe(def);
      const ocrOut = await textRecognise(
        src,
        bboxes,
        sourceLang,
        ocrMinConfidence,
        undefined,
        undefined,
        gateOptions,
        ocrEngine,
      );
      const ocrResults = ocrOut.results;
      const ocr = performance.now() - tOcr;
      await yieldToMain();
      const { backend, gpuUnavailableReason } = await resolveLocalBackend(
        def,
        gpuProbe,
      );
      if (def.engine === "wllama" && backend === "wasm") {
        const hint = gpuUnavailableReason ? ` (${gpuUnavailableReason})` : "";
        return {
          error:
            `Local model requires WebGPU acceleration on Firefox${hint}. ` +
            `Enable "dom.webgpu.enabled" and "javascript.options.wasm_js_promise_integration" in about:config, or switch to API / Gemini mode.`,
          gpuUnavailableReason,
        };
      }
      const tTrans = performance.now();
      const res = await translateLocalRouted(
        ocrResults.map((r) => (r.gateSkip ? "" : r.text)),
        targetLang,
        sourceLang,
        seriesContext,
        llmModel,
        llmTemperature,
        // Auto-Detect: tell the LLM which script the OCR gate settled on
        // instead of letting it guess the input language (LMT-030).
        ocrOut.gate?.label || undefined,
        signal,
      );
      return {
        ...res,
        sourceTexts: ocrResults.map((r) => r.text),
        gateSkip: ocrResults.map((r) => r.gateSkip ?? null),
        ocrFailures: ocrFailureIndexes(ocrResults),
        gate: ocrOut.gate,
        timing: { ocr, translate: performance.now() - tTrans },
        backend,
        ...(gpuUnavailableReason ? { gpuUnavailableReason } : {}),
      };
    }

    if (currentMode === "api") {
      await yieldToMain();
      const tOcr = performance.now();
      const ocrOut = await textRecognise(
        src,
        bboxes,
        sourceLang,
        ocrMinConfidence,
        undefined,
        undefined,
        gateOptions,
        ocrEngine,
      );
      const ocr = performance.now() - tOcr;
      await yieldToMain();
      const tTrans = performance.now();
      const ocrResults = ocrOut.results;
      const res = await translateWithServer(
        ocrResults.map((r) => (r.gateSkip ? "" : r.text)),
        targetLang,
        sourceLang,
        seriesContext,
        serverConfig(msg.config),
        // Auto-Detect: the prompt names the script the gate settled on
        // instead of omitting the source language entirely (LMT-030).
        ocrOut.gate?.label || undefined,
        signal,
      );
      return {
        ...res,
        sourceTexts: ocrResults.map((r) => r.text),
        gateSkip: ocrResults.map((r) => r.gateSkip ?? null),
        ocrFailures: ocrFailureIndexes(ocrResults),
        gate: ocrOut.gate,
        timing: { ocr, translate: performance.now() - tTrans },
      };
    }

    await yieldToMain();
    const tTrans = performance.now();
    const res = await translateWithGemini(
      src,
      bboxes,
      geminiKey,
      targetLang,
      sourceLang,
      seriesContext,
      geminiModel,
      llmTemperature,
      undefined,
      signal,
    );
    // Match the webgpu/api response contract so content debug + cache
    // never see undefined sourceTexts/gate/timing on the Gemini path
    // (Gemini skips OCR: sourceTexts come from the validator, gate empty).
    return {
      ...res,
      sourceTexts: res.sourceTexts ?? new Array(bboxes.length).fill(""),
      gateSkip: new Array(bboxes.length).fill(null),
      gate: { mode: "off", checked: 0, skipped: 0, unavailable: false },
      timing: { translate: performance.now() - tTrans },
      backend: (await detectBackend()).backend,
    };
  };

  try {
    return typeof rawText === "string"
      ? await runRawText(deadline.signal)
      : await runImage(deadline.signal);
  } catch (err) {
    // A deadline abort must reach the user as the same "Timed out after Ns:
    // STAGE" line the background guard produces, keeping run facts (LMT-010,
    // LMT-032).
    return errorResponse(timedOutError(err, deadline.signal, msg.timeoutMs, stage));
  } finally {
    deadline.dispose();
  }
}

export async function handleMakeSiteRule(msg: any): Promise<unknown> {
  const {
    currentMode,
    geminiKey,
    geminiModel,
    llmModel,
    llmTemperature,
    serverHost,
    serverSchema,
    serverModel,
    useServerApiKey,
    serverApiKey,
  } = msg.config;
  const { title, path } = msg.data;
  const stage = stageName(msg.type);
  const deadline = jobDeadline(msg.timeoutMs, stage);

  try {
    if (currentMode === "webgpu") {
      await ensureGpuState();
      if (!gpuEnabledFor("llm")) return { error: LLM_GPU_DISABLED_MESSAGE };
      const def = llmModelDef(llmModel);
      const { backend, gpuUnavailableReason } = await resolveLocalBackend(
        def,
        startLocalGpuProbe(def),
      );
      if (backend === "wasm") {
        const hint = gpuUnavailableReason ? ` (${gpuUnavailableReason})` : "";
        return {
          error:
            def.engine === "wllama" && import.meta.env.FIREFOX
              ? `Local AI rule generation requires WebGPU acceleration on Firefox${hint}. ` +
                `Enable "dom.webgpu.enabled" and "javascript.options.wasm_js_promise_integration" in about:config, or switch to API / Gemini mode.`
              : `Local AI requires WebGPU — not available in this context${hint}. Switch to Gemini / API mode.`,
          gpuUnavailableReason,
        };
      }
      return await makeSiteRuleLocalRouted(
        title,
        path,
        llmModel,
        llmTemperature,
        deadline.signal,
      );
    }
    if (currentMode === "api") {
      return await makeSiteRuleWithServer(
        title,
        path,
        serverConfig(msg.config),
        deadline.signal,
      );
    }
    return await makeSiteRuleWithGemini(
      title,
      path,
      geminiKey,
      geminiModel,
      llmTemperature,
      deadline.signal,
    );
  } catch (err) {
    return errorResponse(timedOutError(err, deadline.signal, msg.timeoutMs, stage));
  } finally {
    deadline.dispose();
  }
}

export async function handleInpaintImage(msg: any): Promise<unknown> {
  const { src, bboxes, method, alwaysInpaint } = msg.data;
  const segmentation = getCachedSegmentation(src);

  // "quality": standalone LaMa-first pass with Fast fallback per region.
  // Anything else normalizes to the Fast ladder (no model rung).
  //
  // LaMa is the only model on the Quality path; its GPU toggle is read
  // inside `ensureLama()`, but the persisted state must be loaded before
  // that call can resolve it (LMT-028).
  await Promise.all([yieldToMain(), ensureGpuState()]);
  if (method === "quality") {
    // Pre-validate weights BEFORE touching LaMa: a missing/incomplete
    // download must not trigger a silent ~207 MB re-fetch at translate
    // time, and must never surface as an error — run the Fast ladder
    // (Telea rung included) and switch the stored option back to fast.
    let lamaCached = false;
    try {
      lamaCached = await isArtifactCached(
        DefaultConfig.lamaRepo,
        DefaultConfig.lamaModelPath,
      );
    } catch {
      lamaCached = false;
    }
    if (!lamaCached) {
      console.warn(
        "[inpaint] LaMa weights not cached — quality requested without a complete download; running Fast ladder and switching option back to fast.",
      );
      try {
        await storage.setItem("sync:inpaint-method", "fast");
      } catch {}
      return inpaintImageAuto(src, bboxes, { segmentation, alwaysInpaint });
    }
  }
  return method === "quality"
    ? inpaintImageQuality(src, bboxes, { segmentation, alwaysInpaint })
    : inpaintImageAuto(src, bboxes, { segmentation, alwaysInpaint });
}

export async function handleDeleteLlmCache(msg: any): Promise<{ success: true }> {
  const def = llmModelDef(msg.data.modelId);
  if (def.engine === "wllama" && import.meta.env.FIREFOX) {
    const { deleteWllamaCache } = await import("./wllama");
    await deleteWllamaCache(def);
  } else if (!import.meta.env.FIREFOX) {
    // Gated so Firefox builds drop the 6MB web-llm chunk entirely
    // (dead-branch elimination at build time).
    const { deleteModelAllInfoInCache } = await import("@mlc-ai/web-llm");
    await deleteModelAllInfoInCache(msg.data.modelId);
  } else {
    throw new Error("web-llm backend excluded from Firefox builds");
  }
  return { success: true };
}

export async function handleCheckWebgpuSupport(): Promise<{ supported: boolean }> {
  ensureWasmPaths();
  return { supported: await checkWebGPUHighPerf() };
}

/**
 * Provider flip (wasm↔webgpu): adopt the new toggles first, then drop every
 * hardware-bound session so the next inference recreates it with the new
 * provider list instead of reusing a stale one (LMT-028). The local LLM is
 * not ORT: it is only released when its own toggle actually went off, and
 * deferred if a page is mid-translation (LMT-029).
 */
export async function handleGpuStateChanged(msg: any): Promise<{ success: true }> {
  await ensureGpuState();
  const before = gpuEnabledFor("llm");
  await refreshGpuState(msg?.data);
  await Promise.allSettled([
    releaseDetection(),
    releaseOcrEngines(),
    releaseGate(),
    releaseLama(),
  ]);
  const llmStillOn = gpuEnabledFor("llm");
  if (before && !llmStillOn) await releaseLocalLlmIdleRouted();
  return { success: true };
}

/**
 * The mode lives in `sync:current-mode`; switching away from Local has to
 * free 1–3 GB of local-model VRAM instead of waiting for the document to die
 * (LMT-029). `applyMode` is a no-op for Gemini ↔ API.
 */
export async function handleModeChanged(msg: any): Promise<{ success: true }> {
  const mode = (msg?.data as { mode?: string } | undefined)?.mode;
  await ensureGpuState();
  await releaseLocalLlmRouted(mode);
  return { success: true };
}

export async function handlePrefetchModel(msg: any): Promise<{ success: true }> {
  const { type, data } = msg.data ?? {};
  ensureWasmPaths();
  if (type === "inpaint") {
    await downloadArtifactHF(DefaultConfig.lamaRepo, DefaultConfig.lamaModelPath, true);
  } else if (type === "ocr") {
    if (data === "manga-ocr") {
      await Promise.all([
        downloadArtifactHF(DefaultConfig.mangaOcrRepo, "encoder_model.onnx", true),
        downloadArtifactHF(DefaultConfig.mangaOcrRepo, "decoder_model.onnx", true),
        downloadArtifactHF(DefaultConfig.mangaOcrRepo, "vocab.txt", true),
      ]);
    } else if (data === "ppocrv6-manga") {
      await downloadArtifactHF(env.ppocrv6MangaRepo, "ppocr-rec-v6-small-manga.onnx", true);
    } else if (data === "pororo") {
      await Promise.all([
        downloadArtifactHF(env.pororoModelRepo, "brainocr.onnx", true),
        downloadArtifactHF(env.pororoModelRepo, "ocr-opt.txt", true),
      ]);
    } else {
      const raw = data && data !== "paddle" ? String(data) : "";
      const lang = !raw ? "chinese" : (SUPPORTED_LANG_GROUPS as readonly string[]).includes(raw) ? raw : resolveLangGroup(raw).group;
      await downloadArtifactHF(DefaultConfig.ocrRepo, DefaultConfig.ocrModelPath(lang), true);
      await downloadArtifactHF(DefaultConfig.ocrRepo, DefaultConfig.ocrDictPath(lang), true);
    }
  } else if (type === "detection") {
    const detId = normalizeDetectionModel(data);
    if (detId === "comic-bubble") await downloadArtifactHF(DefaultConfig.rtdetrModelRepo, "detector-v4-s_int8.onnx", true);
    else if (detId === "comic-text-detector") await downloadArtifactHF("direct-model-cache", DefaultConfig.comicTextDetectorUrl, true);
    else throw new Error(UNKNOWN_DETECTION_MODEL_MESSAGE(detId));
  }
  return { success: true };
}

export async function handleLlmCacheStatus(msg: any): Promise<{ statuses: Record<string, boolean> }> {
  const ids: string[] = Array.isArray(msg.data?.modelIds) ? msg.data.modelIds : [];
  const statuses: Record<string, boolean> = {};
  await Promise.all(
    ids.map(async (id) => {
      try {
        const def = llmModelDef(id);
        if (def.engine === "wllama" && import.meta.env.FIREFOX) {
          const { isWllamaModelCached } = await import("./wllama");
          // def falls back to the build default on stale ids — only report
          // true when the requested id itself is a known wllama model.
          statuses[id] = def.id === id ? await isWllamaModelCached(def) : false;
        } else if (!import.meta.env.FIREFOX) {
          // Gated so Firefox builds drop the web-llm chunk entirely.
          const { hasModelInCache } = await import("@mlc-ai/web-llm");
          statuses[id] = await hasModelInCache(id);
        } else {
          statuses[id] = false;
        }
      } catch {
        statuses[id] = false;
      }
    }),
  );
  return { statuses };
}

export async function handleGetModelStatuses(): Promise<{ statuses: Record<string, never>; downloads: Record<string, never> }> {
  // Best-effort: report empty but success so background can fallback to local probes.
  return { statuses: {}, downloads: {} };
}

export async function handleGetActiveDownloads(): Promise<{ downloads: Record<string, never> }> {
  return { downloads: {} };
}

export async function handleOffscreenMessage(msg: any): Promise<unknown> {
  switch (msg.type) {
    case "OFFSCREEN_DETECT_BBOX":
      return handleDetectBbox(msg);
    case "OFFSCREEN_TRANSLATE_IMAGE":
      return handleTranslateImage(msg);
    case "OFFSCREEN_MAKE_SITE_RULE_AI":
      return handleMakeSiteRule(msg);
    case "OFFSCREEN_INPAINT_IMAGE":
      return handleInpaintImage(msg);
    case "OFFSCREEN_DELETE_LLM_CACHE":
      return handleDeleteLlmCache(msg);
    case "OFFSCREEN_CHECK_WEBGPU_SUPPORT":
      return handleCheckWebgpuSupport();
    case "OFFSCREEN_GPU_STATE_CHANGED":
      return handleGpuStateChanged(msg);
    case "OFFSCREEN_MODE_CHANGED":
      return handleModeChanged(msg);
    case "OFFSCREEN_PREFETCH_MODEL":
      return handlePrefetchModel(msg);
    case "OFFSCREEN_LLM_CACHE_STATUS":
      return handleLlmCacheStatus(msg);
    case "OFFSCREEN_GET_MODEL_STATUSES":
      return handleGetModelStatuses();
    case "OFFSCREEN_GET_ACTIVE_DOWNLOADS":
      return handleGetActiveDownloads();
    default:
      throw new Error(`Unknown offscreen message: ${msg.type}`);
  }
}
