import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import {
  WEBGPU_INCOMPATIBLE_MARKERS,
  isModelWebGpuCapable,
  resolveExecutionProvidersForModel,
} from "../../src/lib/hardware";
import { KNOWN_MODEL_SHA256 } from "../../src/lib/manifests/hashes";
import { DefaultConfig } from "../../src/lib/configs";

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8");

/**
 * The GPU denylist is a list of *strings* matched against model paths. Its
 * failure mode is silent: rename a weight upstream and the entry stops
 * matching, the model starts claiming WebGPU, and `create()` succeeds while
 * `run()` throws (or the whole stage crawls on a shader fallback).
 *
 * These tests bind the denylist to the download manifest so that drift is a
 * red test rather than a runtime surprise on someone's machine.
 */
describe("WebGPU denylist ↔ download manifest", () => {
  const manifestKeys = Object.keys(KNOWN_MODEL_SHA256);

  it("every denylist marker still matches at least one shipped artifact", () => {
    for (const marker of WEBGPU_INCOMPATIBLE_MARKERS) {
      const matched = manifestKeys.filter((key) => key.includes(marker));
      expect(
        matched.length,
        `marker "${marker}" matches no artifact in KNOWN_MODEL_SHA256 — the model was renamed and this entry is now dead`,
      ).toBeGreaterThan(0);
    }
  });

  it("no two markers are redundant", () => {
    // "languages/chinese/rec.onnx" is intentionally listed alongside
    // "chinese/rec.onnx" (bare-path and prefixed callers); nothing else may
    // duplicate, or a removal will not actually disable the guard.
    for (const marker of WEBGPU_INCOMPATIBLE_MARKERS) {
      if (marker === "languages/chinese/rec.onnx") continue;
      const coveredByOthers = WEBGPU_INCOMPATIBLE_MARKERS.filter(
        (other) => other !== marker && other !== "languages/chinese/rec.onnx" && marker.includes(other),
      );
      expect(
        coveredByOthers.length,
        `marker "${marker}" is shadowed by ${coveredByOthers.join(", ")}`,
      ).toBe(0);
    }
  });

  it("the four CPU-forced stages resolve to wasm only", () => {
    const cpuBound = [
      "detector-v4-s_int8.onnx", // default detector (RT-DETR)
      "languages/chinese/rec.onnx", // Japanese + Chinese OCR
      "chinese/rec.onnx",
      "lama-manga-dynamic.onnx", // neural inpaint
      "brainocr.onnx", // Pororo Korean OCR
    ];
    for (const path of cpuBound) {
      expect(isModelWebGpuCapable(path), path).toBe(false);
      expect(resolveExecutionProvidersForModel(path, true), path).toEqual(["wasm"]);
    }
  });

  it("GPU-capable artifacts keep the webgpu+wasm list when GPU is on", () => {
    const gpuOk = [
      "comictextdetector.pt.onnx",
      "osd_lstm.onnx", // script gate
      "languages/latin/rec.onnx",
      "languages/korean/rec.onnx",
      "ppocr-rec-v6-small-manga.onnx",
      "encoder_model.onnx", // manga-ocr
    ];
    for (const path of gpuOk) {
      expect(isModelWebGpuCapable(path), path).toBe(true);
      expect(resolveExecutionProvidersForModel(path, true), path).toEqual([
        "webgpu",
        "wasm",
      ]);
    }
  });

  it("GPU off means wasm for everything, denylisted or not", () => {
    expect(resolveExecutionProvidersForModel("languages/latin/rec.onnx", false)).toEqual([
      "wasm",
    ]);
    expect(resolveExecutionProvidersForModel("lama-manga.onnx", false)).toEqual(["wasm"]);
  });

  it("Japanese really does resolve to the denylisted Chinese pack", () => {
    // The most common source language is the reason this denylist is a
    // branding problem at all — if that mapping changes, revisit the naming.
    expect((DefaultConfig as any).ocrLangGroupMap["Japanese"]).toBe("chinese");
    expect(isModelWebGpuCapable(DefaultConfig.ocrModelPath("chinese"))).toBe(false);
  });
});

/**
 * Previous LMT shipped a mode called "WebGPU" whose default detector, Japanese OCR,
 * Korean OCR and neural inpaint all ran on WASM CPU. The label changed to
 * "Local"; the stored id did not, so no existing install needs a migration.
 */
describe("Mode naming is honest", () => {
  const localMode = DefaultConfig.modes.find((m) => m.id === "webgpu");

  it("the on-device mode is labelled Local, not WebGPU", () => {
    expect(localMode?.label).toBe("Local");
    expect(DefaultConfig.modes.some((m) => m.label === "WebGPU")).toBe(false);
  });

  it("the storage key keeps id webgpu (no migration for existing users)", () => {
    expect(localMode?.id).toBe("webgpu");
    expect(DefaultConfig.currentMode).toBe("webgpu");
  });

  it("README no longer names a mode after one execution provider", () => {
    const readme = read("../../README.md");
    expect(readme).not.toMatch(/\*\*WebGPU Mode\*\*/);
    expect(readme).toMatch(/Local Mode/);
    expect(readme).toMatch(/cannot execute/);
    expect(readme).not.toMatch(/every stage.{0,30}GPU/i);
  });

  it("privacy.md and technical.md do not resurrect the blanket claim", () => {
    // GPU claims must be scoped per stage and point at the denylist, not blanket.
    expect(read("../../docs/technical.md")).toMatch(/### What runs on GPU/);

    for (const file of ["../../docs/technical.md", "../../privacy.md"]) {
      const text = read(file);
      expect(text, `${file} advertises every stage as GPU-accelerated`).not.toMatch(
        /all stages.{0,40}GPU/i,
      );
    }
  });
});
