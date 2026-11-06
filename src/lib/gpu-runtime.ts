/**
 * Effective GPU state for the inference document (LMT-028).
 *
 * The settings panel has always persisted the GPU toggles, but nothing read
 * them: every ORT session was created with `options?.gpu` undefined, which
 * falls back to "GPU if `navigator.gpu` exists". This module is the single
 * place that turns the persisted toggles into the boolean the loaders pass to
 * `downloadArtifactHF(..., { gpu })`.
 *
 * It is a leaf module (only `hardware` + `wxt/storage`) so every stage module
 * can call `gpuEnabledFor()` without creating an import cycle.
 */
import {
  DEFAULT_GPU_STATE,
  isGpuEnabledFor,
  normalizeGpuState,
  type GpuState,
} from "./hardware";

let state: GpuState = DEFAULT_GPU_STATE;
let loadPromise: Promise<GpuState> | null = null;

/** Whether this context can even see a WebGPU device. */
export function hasWebGpu(): boolean {
  try {
    return typeof navigator !== "undefined" && "gpu" in navigator;
  } catch {
    return false;
  }
}

async function readPersisted(): Promise<GpuState> {
  try {
    const items = await storage.getItems([
      "local:webgpu-supported",
      "sync:webgpu-master",
      "sync:webgpu-overrides",
    ]);
    const pick = (key: string) => items.find((i) => i.key === key)?.value;
    return normalizeGpuState({
      webgpuSupported: pick("local:webgpu-supported") as GpuState["webgpuSupported"],
      webgpuMaster: pick("sync:webgpu-master") as boolean | undefined,
      webgpuOverrides: pick("sync:webgpu-overrides") as GpuState["webgpuOverrides"] | undefined,
    });
  } catch {
    // No storage access (unit test / service worker edge): keep defaults, the
    // caller's `assumeSupported` still decides.
    return DEFAULT_GPU_STATE;
  }
}

/**
 * Load the persisted toggles once per document.
 *
 * `webgpuSupported === null` only means "never probed / probe was inconclusive",
 * and `isGpuEnabledFor` resolves that per call against `navigator.gpu`, so this
 * does not probe by itself. Probing here would race the panel's explicit
 * "Re-check" and could flip the flag while a page is loading.
 */
export function ensureGpuState(): Promise<GpuState> {
  if (!loadPromise) {
    loadPromise = readPersisted().then((next) => {
      state = next;
      return next;
    });
  }
  return loadPromise;
}

/** Effective flag for one subsystem; synchronous, for use inside loaders. */
export function gpuEnabledFor(key: keyof GpuState["webgpuOverrides"]): boolean {
  return isGpuEnabledFor(state, key, { assumeSupported: hasWebGpu() });
}

/**
 * Apply a state pushed by `GPU_STATE_CHANGED`. Accepts the panel's snapshot so a
 * toggle takes effect without re-reading storage; falls back to a fresh read
 * when the payload is missing or malformed.
 */
export async function refreshGpuState(next?: unknown): Promise<GpuState> {
  if (next && typeof next === "object") {
    state = normalizeGpuState(next as Partial<GpuState>);
    loadPromise = Promise.resolve(state);
    return state;
  }
  loadPromise = null;
  return ensureGpuState();
}
