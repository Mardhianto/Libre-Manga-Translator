/**
 * Hardware probe + GPU offload contract — Phase 4.1b (MIT-only, LMT-native).
 *
 * Single ownership point for:
 *  - WebGPU `high-performance` adapter probe (`checkWebGPUHighPerf`)
 *  - Persisted GPU state (`normalizeGpuState`, cache `true` only)
 *  - ONNX execution-provider resolution (`resolveExecutionProviders`)
 *
 * This module is the *only* place that imports `onnxruntime-web` eagerly
 * for `ort.env.wasm.wasmPaths` configuration. All callers import
 * helpers from here, so the module identity is stable.
 */
import * as ort from "onnxruntime-web/all";

// Keep ort log level error-only.
ort.env.logLevel = "error";

/**
 * Probe for a high-performance WebGPU adapter.
 * - Must run in offscreen/document context (service workers have no `navigator.gpu`).
 * - Returns false if no adapter, adapter is null, or probe throws.
 * - No side effects — caller decides persistence.
 */
export async function checkWebGPUHighPerf(): Promise<boolean> {
  try {
    const gpu: unknown = (globalThis as unknown as Record<string, unknown>).navigator
      ? (navigator as unknown as { gpu?: { requestAdapter: (opts: unknown) => Promise<unknown> } }).gpu
      : undefined;
    if (!gpu || typeof (gpu as { requestAdapter?: unknown }).requestAdapter !== "function") return false;
    const adapter = await (gpu as { requestAdapter: (opts: unknown) => Promise<unknown> }).requestAdapter({
      powerPreference: "high-performance",
    });
    return Boolean(adapter);
  } catch {
    return false;
  }
}

/**
 * Probe a WebGPU adapter feature that a local LLM may declare in
 * `ModelRecord.required_features` (currently only `shader-f16`).
 *
 * WebLLM throws `ShaderF16SupportError` inside `reload()` when the feature is
 * missing, which surfaces to the user as a failed download *after* several
 * hundred MB. Ask the adapter first so unsupported models can be hidden or
 * disabled instead.
 *
 * Returns `null` when it cannot be determined (no WebGPU, probe threw) so
 * callers keep every model visible rather than hiding them on a bad probe.
 */
export async function checkWebGPUFeature(feature: string): Promise<boolean | null> {
  try {
    const gpu = (navigator as unknown as {
      gpu?: { requestAdapter: (opts: unknown) => Promise<{ features?: { has: (f: string) => boolean } } | null> };
    }).gpu;
    if (!gpu || typeof gpu.requestAdapter !== "function") return null;
    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return null;
    if (!adapter.features || typeof adapter.features.has !== "function") return null;
    return adapter.features.has(feature);
  } catch {
    return null;
  }
}

/**
 * Execution provider list for ONNX Runtime Web.
 * - When `gpu` is true: WebGPU + WASM fallback.
 * - When `gpu` is false: WASM only (MV3-safe).
 */
export function resolveExecutionProviders(gpu: boolean): readonly string[] {
  if (gpu) {
    return ["webgpu", "wasm"];
  }
  return ["wasm"];
}

/**
 * Models that MUST run on WASM CPU because their ONNX graph contains operators
 * WebGPU cannot execute:
 * - MaxPool with `ceil_mode=1` → RT-DETR detector, PaddleOCR Chinese pack
 *   (the pack `Japanese` resolves to — see `configs.ts` `ocrLangGroupMap`)
 * - LaMa FFC complex-Add (`/model/model.5/conv1/ffc/convg2g/Add` has no JSEP
 *   kernel — `create()` succeeds, `run()` throws)
 * - Pororo (`brainocr.onnx`) Korean OCR
 *
 * Exported as data so a test can prove every marker still names a real
 * artifact: a string-keyed denylist silently stops matching the day a model is
 * renamed, and the model starts claiming GPU it cannot use.
 */
export const WEBGPU_INCOMPATIBLE_MARKERS = [
  "detector-v4-s_int8.onnx",
  "chinese/rec.onnx",
  "languages/chinese/rec.onnx",
  "lama-manga",
  "brainocr.onnx",
] as const;

export function isModelWebGpuCapable(pathOrUrl: string): boolean {
  return WEBGPU_INCOMPATIBLE_MARKERS.some((marker) => pathOrUrl.includes(marker))
    ? false
    : true;
}

/**
 * Resolve execution providers for a specific model path or URL.
 * Automatically restricts models with unsupported operators (e.g. ceil_mode=1)
 * to WASM CPU, while allowing compatible models to leverage WebGPU.
 */
export function resolveExecutionProvidersForModel(
  pathOrUrl: string,
  gpu?: boolean,
): readonly string[] {
  if (!isModelWebGpuCapable(pathOrUrl)) {
    return ["wasm"];
  }
  const useGpu = gpu ?? (typeof navigator !== "undefined" && "gpu" in navigator);
  return resolveExecutionProviders(useGpu);
}

/** Persisted GPU state shape (stored via `wxt/storage`). */
export interface GpuState {
  webgpuSupported: boolean | null; // null = unknown, true/false = probed
  webgpuMaster: boolean;
  webgpuOverrides: {
    llm: boolean;
    inpaint: boolean;
    ocr: boolean;
    /**
     * Detection is its own stage (RT-DETR / ComicTextDetector), separate from
     * OCR recognition. It used to share the `ocr` toggle, which meant turning
     * off recognition also forced the detector to CPU (LMT-028).
     */
    detection: boolean;
  };
}

export const DEFAULT_GPU_STATE: GpuState = {
  webgpuSupported: null,
  webgpuMaster: true,
  webgpuOverrides: { llm: true, inpaint: true, ocr: true, detection: true },
};

/**
 * Deep-merge persisted GPU state over defaults.
 * - Sparse legacy objects (e.g. missing `webgpuOverrides`) are completed.
 * - Transient `false` probes are *not* persisted here — callers should only
 *   write `true` (verified high-performance) and leave `null` otherwise.
 */
export function normalizeGpuState(raw: Partial<GpuState> | undefined | null): GpuState {
  return {
    webgpuSupported: raw?.webgpuSupported ?? DEFAULT_GPU_STATE.webgpuSupported,
    webgpuMaster: raw?.webgpuMaster ?? DEFAULT_GPU_STATE.webgpuMaster,
    webgpuOverrides: {
      llm: raw?.webgpuOverrides?.llm ?? DEFAULT_GPU_STATE.webgpuOverrides.llm,
      inpaint: raw?.webgpuOverrides?.inpaint ?? DEFAULT_GPU_STATE.webgpuOverrides.inpaint,
      ocr: raw?.webgpuOverrides?.ocr ?? DEFAULT_GPU_STATE.webgpuOverrides.ocr,
      detection: raw?.webgpuOverrides?.detection ?? DEFAULT_GPU_STATE.webgpuOverrides.detection,
    },
  };
}

/**
 * Effective GPU flag for a subsystem (`master && per-subsystem`).
 *
 * `webgpuSupported` is `null` on most installs: the probe only ever persists
 * `true`, and a failed re-probe removes the key. Treating `null` as "no" here
 * would force every never-probed user onto WASM the moment this flag is
 * actually wired into the ORT loads (LMT-028), so the unknown state is
 * delegated to the caller through `assumeSupported` — a context that can see
 * `navigator.gpu` passes `true` to keep the previous behaviour.
 */
export function isGpuEnabledFor(
  state: GpuState,
  key: keyof GpuState["webgpuOverrides"],
  options?: { assumeSupported?: boolean },
): boolean {
  if (!state.webgpuMaster || state.webgpuOverrides[key] !== true) return false;
  if (state.webgpuSupported === true) return true;
  if (state.webgpuSupported === false) return false;
  return options?.assumeSupported === true;
}

/**
 * Probe once (offscreen) and persist `true` only.
 * - Returns the probed boolean (true/false).
 * - When true, writes `local:webgpu-supported = true` so future loads skip probing.
 * - When false, does NOT overwrite a previously verified `true` — leaves cache as-is.
 */
export async function probeAndCacheWebGPU(): Promise<boolean> {
  const ok = await checkWebGPUHighPerf();
  if (ok) {
    try {
      // `storage` is provided by WXT globals; guard for node/test contexts.
      const maybeStorage = (globalThis as unknown as { storage?: { setItem: (k: string, v: unknown) => Promise<void> } }).storage;
      if (maybeStorage) await maybeStorage.setItem("local:webgpu-supported", true);
    } catch {}
  }
  return ok;
}

/** Ensure `ort.env.wasm.wasmPaths` points to extension-local assets (MV3-safe, no CDN). */
export function ensureWasmPaths(): void {
  try {
    const url = typeof browser !== "undefined" && (browser as unknown as { runtime?: { getURL: (p: string) => string } }).runtime?.getURL
      ? (browser as unknown as { runtime: { getURL: (p: string) => string } }).runtime.getURL("/")
      : "/";
    // Only set if not already set — respects existing test harnesses.
    if (!(ort.env.wasm as unknown as Record<string, unknown>).wasmPaths) {
      (ort.env.wasm as unknown as Record<string, unknown>).wasmPaths = url;
    }
  } catch {}
}
