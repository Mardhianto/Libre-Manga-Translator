import { describe, expect, it } from "bun:test";
import {
  DEFAULT_GPU_STATE,
  isGpuEnabledFor,
  normalizeGpuState,
  resolveExecutionProvidersForModel,
  type GpuState,
} from "../../src/lib/hardware";

const state = (patch: Partial<GpuState> = {}): GpuState => ({
  ...DEFAULT_GPU_STATE,
  ...patch,
  webgpuOverrides: {
    ...DEFAULT_GPU_STATE.webgpuOverrides,
    ...(patch.webgpuOverrides ?? {}),
  },
});

/**
 * LMT-028: the GPU toggles used to be written by the settings panel and read by
 * nobody — every ORT session was created with `options?.gpu` undefined, which
 * means "GPU if `navigator.gpu` exists". These vectors pin the policy that is
 * now actually applied to the loaders, including the `null` (never probed) case
 * that would otherwise force every user onto WASM.
 */
describe("isGpuEnabledFor", () => {
  it("master off wins over every override", () => {
    const off = state({ webgpuMaster: false, webgpuSupported: true });
    for (const key of ["llm", "inpaint", "ocr", "detection"] as const) {
      expect(isGpuEnabledFor(off, key), key).toBe(false);
    }
  });

  it("a single override off disables only its own stage", () => {
    const onlyOcrOff = state({
      webgpuSupported: true,
      webgpuOverrides: { ...DEFAULT_GPU_STATE.webgpuOverrides, ocr: false },
    });
    expect(isGpuEnabledFor(onlyOcrOff, "ocr")).toBe(false);
    expect(isGpuEnabledFor(onlyOcrOff, "detection")).toBe(true);
    expect(isGpuEnabledFor(onlyOcrOff, "inpaint")).toBe(true);
    expect(isGpuEnabledFor(onlyOcrOff, "llm")).toBe(true);
  });

  it("detection is independent from ocr", () => {
    const detectionOff = state({
      webgpuSupported: true,
      webgpuOverrides: { ...DEFAULT_GPU_STATE.webgpuOverrides, detection: false },
    });
    expect(isGpuEnabledFor(detectionOff, "detection")).toBe(false);
    expect(isGpuEnabledFor(detectionOff, "ocr")).toBe(true);
  });

  it("a probed-false device is never GPU", () => {
    const unsupported = state({ webgpuSupported: false });
    for (const key of ["llm", "inpaint", "ocr", "detection"] as const) {
      expect(isGpuEnabledFor(unsupported, key, { assumeSupported: true }), key).toBe(false);
    }
  });

  it("`null` means unknown, not unsupported", () => {
    const unknown = state({ webgpuSupported: null });
    // Caller that can see navigator.gpu keeps the historical behaviour…
    expect(isGpuEnabledFor(unknown, "llm", { assumeSupported: true })).toBe(true);
    // …and a context without WebGPU does not claim it.
    expect(isGpuEnabledFor(unknown, "llm", { assumeSupported: false })).toBe(false);
    expect(isGpuEnabledFor(unknown, "llm")).toBe(false);
  });

  it("a probed-true device is GPU when the toggle is on and master is on", () => {
    expect(isGpuEnabledFor(state({ webgpuSupported: true }), "detection")).toBe(true);
  });
});

describe("normalizeGpuState", () => {
  it("fills the new detection override for sparse legacy objects", () => {
    const legacy = normalizeGpuState({
      webgpuMaster: true,
      webgpuOverrides: { llm: false, inpaint: true, ocr: true } as any,
    });
    expect(legacy.webgpuOverrides.detection).toBe(true);
    expect(legacy.webgpuOverrides.llm).toBe(false);
  });

  it("an empty object is the default state", () => {
    expect(normalizeGpuState({})).toEqual(DEFAULT_GPU_STATE);
  });

  it("keeps an explicit false detection override", () => {
    const parsed = normalizeGpuState({
      webgpuOverrides: { llm: true, inpaint: true, ocr: true, detection: false },
    });
    expect(parsed.webgpuOverrides.detection).toBe(false);
  });
});

describe("gpu=false reaches the ORT provider list", () => {
  it("master off turns a GPU-capable artifact into wasm only", () => {
    const path = "comictextdetector.pt.onnx";
    expect(resolveExecutionProvidersForModel(path, true)).toEqual(["webgpu", "wasm"]);
    expect(resolveExecutionProvidersForModel(path, isGpuEnabledFor(
      state({ webgpuMaster: false, webgpuSupported: true }),
      "detection",
    ))).toEqual(["wasm"]);
  });

  it("per-stage off is honoured for each loader's model", () => {
    const cases = [
      { key: "detection" as const, path: "comictextdetector.pt.onnx" },
      { key: "ocr" as const, path: "osd_lstm.onnx" },
      { key: "ocr" as const, path: "languages/latin/rec.onnx" },
      { key: "ocr" as const, path: "encoder_model.onnx" },
      { key: "inpaint" as const, path: "lama-manga-dynamic.onnx" },
    ];
    for (const { key, path } of cases) {
      const gpu = isGpuEnabledFor(
        state({
          webgpuSupported: true,
          webgpuOverrides: { ...DEFAULT_GPU_STATE.webgpuOverrides, [key]: false },
        }),
        key,
      );
      expect(gpu, `${key} toggle off`).toBe(false);
      expect(resolveExecutionProvidersForModel(path, gpu), path).toEqual(["wasm"]);
    }
  });
});
