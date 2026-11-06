import { UNKNOWN_DETECTION_MODEL_MESSAGE, detectTextBubble, releaseDetection } from "@/lib/detections/main";
import { makeSiteRuleWithGemini, translateWithGemini, translateTextWithGemini } from "@/lib/gemini/main";
import "@/assets/app.css";
import { releaseOcrEngines, textRecognise } from "@/lib/ocr/main";
import {
  makeSiteRuleWithServer,
  translateWithServer,
} from "@/lib/server/main";
import { diagnosticsFromError } from "@/lib/server/validator";
import { deleteModelAllInfoInCache, hasModelInCache } from "@mlc-ai/web-llm";
import { makeSiteRuleLocal, translateLocal } from "@/lib/webllm";
import { releaseLocalLlmIdle, applyMode } from "@/lib/webllm";
import { ensureGpuState, gpuEnabledFor, refreshGpuState } from "@/lib/gpu-runtime";
import { inpaintImageAuto, inpaintImageQuality } from "@/lib/inpaint/ladder";
import { getCachedSegmentation } from "@/lib/detections/segmentation";
import { checkWebGPUHighPerf, ensureWasmPaths } from "@/lib/hardware";
import { releaseGate } from "@/lib/gate/osd";
import { releaseLama } from "@/lib/inpaint/lama";
import { downloadArtifactHF, isArtifactCached, yieldToMain } from "@/lib/utils";
import { DefaultConfig, SUPPORTED_LANG_GROUPS, normalizeDetectionModel, resolveLangGroup } from "@/lib/configs";
import { env } from "@/lib/env";

async function detectBackend(): Promise<"webgpu" | "wasm"> {
  try {
    if ("gpu" in navigator) {
      const adapter = await (navigator.gpu as any).requestAdapter({ powerPreference: "high-performance" });
      if (adapter) return "webgpu";
    }
  } catch {
    // fall through to wasm
  }
  return "wasm";
}

/**
 * WebLLM reply for a mode that needs the local engine while the Translation
 * GPU toggle is off. Fail loud with the switch to flip instead of silently
 * loading 3-6 GB of weights the user explicitly disabled (LMT-028).
 */
const LLM_GPU_DISABLED_MESSAGE =
  "GPU acceleration for Translation is off. Enable Settings → GPU acceleration → Translation, or switch to Gemini / API mode.";

function serverConfig(config: Record<string, any>) {
  return {
    serverHost: config.serverHost,
    serverSchema: config.serverSchema,
    serverModel: config.serverModel,
    useServerApiKey: config.useServerApiKey,
    serverApiKey: config.serverApiKey,
    temperature: config.llmTemperature,
  };
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
  };
}

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

browser.runtime.onMessage.addListener((msg, _, sendResponse) => {
  if (msg.type === "OFFSCREEN_DETECT_BBOX") {
    const { detectionModel, detectionMinConfidence } = msg.config;

    (async () => {
      // The toggles are read here, not only on GPU_STATE_CHANGED: a page
      // translated before the user ever opens Settings must already honour
      // them (LMT-028).
      await ensureGpuState();
      await yieldToMain();
      return detectTextBubble(msg.data, detectionMinConfidence, detectionModel);
    })()
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));

    return true;
  }

  if (msg.type === "OFFSCREEN_TRANSLATE_IMAGE") {
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

    /**
     * The persisted GPU toggles are read once per job: a page translated right
     * after a settings change — or before Settings was ever opened — must
     * agree with what the panel shows (LMT-028).
     */
    const gpuStateReady = ensureGpuState();

    /** WebLLM is only allowed when the Translation GPU toggle is on. */
    const localLlmBlocked = async (): Promise<{ error: string } | null> => {
      await gpuStateReady;
      return gpuEnabledFor("llm") ? null : { error: LLM_GPU_DISABLED_MESSAGE };
    };

    /**
     * Runs one translate branch under the forwarded deadline and replies with
     * exactly one response. The signal reaches the backend that owns the
     * request, so the deadline actually closes the socket / interrupts
     * generation instead of only abandoning the promise (LMT-010).
     */
    const runTranslation = (
      stage: string,
      task: (signal?: AbortSignal) => Promise<unknown>,
    ) => {
      const deadline = jobDeadline(msg.timeoutMs, stage);
      task(deadline.signal)
        .then(sendResponse)
        .catch((err) =>
          sendResponse(
            errorResponse(
              timedOutError(err, deadline.signal, msg.timeoutMs, stage),
            ),
          ),
        )
        .finally(deadline.dispose);
    };

    if (typeof rawText === "string") {
      if (currentMode === "webgpu") {
        runTranslation(stageName(msg.type), async (signal) => {
          await yieldToMain();
          const blocked = await localLlmBlocked();
          if (blocked) return blocked;
          const tTrans = performance.now();
          const backend = await detectBackend();
          if (backend === "wasm") {
            return {
              error:
                "Local AI requires WebGPU — not available in this context. Check chrome://gpu or switch to Gemini / API mode.",
            };
          }
          const res = await translateLocal(
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
        });
      } else if (currentMode === "api") {
        runTranslation(stageName(msg.type), async (signal) => {
          await yieldToMain();
          const tTrans = performance.now();
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
        });
      } else {
        runTranslation(stageName(msg.type), async (signal) => {
          await yieldToMain();
          const tTrans = performance.now();
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
        });
      }
      return true;
    }

    if (currentMode === "webgpu") {
      runTranslation(stageName(msg.type), async (signal) => {
        await yieldToMain();
        const blocked = await localLlmBlocked();
        if (blocked) return blocked;
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
        const ocrResults = ocrOut.results;
        const ocr = performance.now() - tOcr;
        await yieldToMain();
        const tTrans = performance.now();
        const backend = await detectBackend();
        if (backend === "wasm") {
          return {
            error:
              "Local AI requires WebGPU — not available in this context. Check chrome://gpu or switch to Gemini / API mode.",
          };
        }
        const res = await translateLocal(
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
          gate: ocrOut.gate,
          timing: { ocr, translate: performance.now() - tTrans },
          backend,
        };
      });
    } else if (currentMode === "api") {
      runTranslation(stageName(msg.type), async (signal) => {
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
          gate: ocrOut.gate,
          timing: { ocr, translate: performance.now() - tTrans },
        };
      });
    } else {
      runTranslation(stageName(msg.type), async (signal) => {
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
          backend: await detectBackend(),
        };
      });
    }

    return true;
  }

  if (msg.type === "OFFSCREEN_MAKE_SITE_RULE_AI") {
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

    const deadline = jobDeadline(msg.timeoutMs, stageName(msg.type));
    const run = async (): Promise<unknown> => {
      if (currentMode === "webgpu") {
        await ensureGpuState();
        if (!gpuEnabledFor("llm")) return { error: LLM_GPU_DISABLED_MESSAGE };
        const backend = await detectBackend();
        if (backend === "wasm") {
          return {
            error:
              "Local AI requires WebGPU — not available in this context. Check chrome://gpu or switch to Gemini / API mode.",
          };
        }
        return makeSiteRuleLocal(
          title,
          path,
          llmModel,
          llmTemperature,
          deadline.signal,
        );
      }
      if (currentMode === "api") {
        return makeSiteRuleWithServer(
          title,
          path,
          serverConfig(msg.config),
          deadline.signal,
        );
      }
      return makeSiteRuleWithGemini(
        title,
        path,
        geminiKey,
        geminiModel,
        llmTemperature,
        deadline.signal,
      );
    };

    run()
      .then(sendResponse)
      .catch((err) =>
        sendResponse(
          errorResponse(
            timedOutError(
              err,
              deadline.signal,
              msg.timeoutMs,
              stageName(msg.type),
            ),
          ),
        ),
      )
      .finally(deadline.dispose);

    return true;
  }

  if (msg.type === "OFFSCREEN_INPAINT_IMAGE") {
    const { src, bboxes, method, alwaysInpaint } = msg.data;
    const segmentation = getCachedSegmentation(src);

    // "quality": standalone LaMa-first pass with Fast fallback per region.
    // Anything else normalizes to the Fast ladder (no model rung).
    (async () => {
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
    })()
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));

    return true;
  }

  if (msg.type === "OFFSCREEN_DELETE_LLM_CACHE") {
    deleteModelAllInfoInCache(msg.data.modelId)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ error: err.message }));

    return true;
  }

  if (msg.type === "OFFSCREEN_CHECK_WEBGPU_SUPPORT") {
    ensureWasmPaths();
    checkWebGPUHighPerf()
      .then((supported) => sendResponse({ supported }))
      .catch((err) => sendResponse({ supported: false, error: (err as Error).message }));
    return true;
  }

  if (msg.type === "OFFSCREEN_GPU_STATE_CHANGED") {
    // Provider flip (wasm↔webgpu): adopt the new toggles first, then drop every
    // hardware-bound session so the next inference recreates it with the new
    // provider list instead of reusing a stale one (LMT-028). The local LLM is
    // not ORT: it is only released when its own toggle actually went off, and
    // deferred if a page is mid-translation (LMT-029).
    const task = (async () => {
      await ensureGpuState();
      const before = gpuEnabledFor("llm");
      await refreshGpuState(msg.data);
      await Promise.allSettled([
        releaseDetection(),
        releaseOcrEngines(),
        releaseGate(),
        releaseLama(),
      ]);
      const llmStillOn = gpuEnabledFor("llm");
      if (before && !llmStillOn) await releaseLocalLlmIdle();
      return { success: true };
    })();
    task.then(sendResponse).catch((err) => sendResponse({ success: false, error: (err as Error).message }));
    return true;
  }

  if (msg.type === "OFFSCREEN_MODE_CHANGED") {
    // The mode lives in `sync:current-mode`; switching away from Local has to
    // free 1–3 GB of WebLLM VRAM instead of waiting for the document to die
    // (LMT-029). `applyMode` is a no-op for Gemini ↔ API.
    const mode = (msg.data as { mode?: string } | undefined)?.mode;
    ensureGpuState()
      .then(() => applyMode(mode))
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: (err as Error).message }));
    return true;
  }

  if (msg.type === "OFFSCREEN_PREFETCH_MODEL") {
    const { type, data } = msg.data ?? {};
    const task = (async () => {
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
    })();
    task.then(sendResponse).catch((err) => sendResponse({ error: (err as Error).message }));
    return true;
  }

  if (msg.type === "OFFSCREEN_LLM_CACHE_STATUS") {
    const ids: string[] = Array.isArray(msg.data?.modelIds) ? msg.data.modelIds : [];
    const task = (async () => {
      const statuses: Record<string, boolean> = {};
      await Promise.all(
        ids.map(async (id) => {
          try {
            statuses[id] = await hasModelInCache(id);
          } catch {
            statuses[id] = false;
          }
        }),
      );
      return { statuses };
    })();
    task.then(sendResponse).catch((err) => sendResponse({ error: (err as Error).message }));
    return true;
  }

  if (msg.type === "OFFSCREEN_GET_MODEL_STATUSES") {
    // Best-effort: report empty but success so background can fallback to local probes.
    sendResponse({ statuses: {}, downloads: {} });
    return true;
  }

  if (msg.type === "OFFSCREEN_GET_ACTIVE_DOWNLOADS") {
    sendResponse({ downloads: {} });
    return true;
  }
});
