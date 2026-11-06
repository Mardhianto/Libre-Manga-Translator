import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * LMT-029: `globalEngine` lived for the whole offscreen document, so leaving
 * Local mode kept 1–3 GB of WebLLM VRAM resident until the browser closed. The
 * release seam is exercised here against a fake engine — the real one needs
 * WebGPU and 3 GB of weights.
 */
let created = 0;
let unloaded = 0;
let unloadShouldThrow = false;

const fakeEngine = {
  reload: async () => {},
  chatCompletion: async () => ({
    choices: [
      {
        message: { content: JSON.stringify({ translations: ["A"] }) },
        finish_reason: "stop",
      },
    ],
  }),
  unload: async () => {
    unloaded++;
    if (unloadShouldThrow) throw new Error("unload exploded");
  },
  interruptGenerate: async () => {},
};

mock.module("../../src/lib/llm-engine", () => ({
  createLlmEngine: () => {
    created++;
    return fakeEngine;
  },
}));

const {
  applyMode,
  releaseLocalLlm,
  releaseLocalLlmIdle,
  translateLocal,
  withLocalLlmJob,
} = await import("../../src/lib/webllm");

/** Load the engine once, the way a page would. */
async function loadEngine() {
  const result = await translateLocal(["こんにちは"], "English", "Japanese");
  expect(result.translations).toHaveLength(1);
}

beforeEach(async () => {
  await releaseLocalLlm();
  created = 0;
  unloaded = 0;
  unloadShouldThrow = false;
});

afterEach(async () => {
  await releaseLocalLlm();
});

describe("releaseLocalLlm", () => {
  it("does nothing when no engine was ever created", async () => {
    await releaseLocalLlm();
    expect(unloaded).toBe(0);
  });

  it("is idempotent: the second call has no engine to unload", async () => {
    await loadEngine();
    expect(created).toBe(1);
    await releaseLocalLlm();
    await releaseLocalLlm();
    expect(unloaded).toBe(1);
  });

  it("clears the pointers even when unload() throws", async () => {
    await loadEngine();
    unloadShouldThrow = true;
    await releaseLocalLlm();
    unloadShouldThrow = false;

    // A released engine cannot be reused: the next translate must build a new
    // one, otherwise a half-unloaded engine would serve the page.
    await loadEngine();
    expect(created).toBe(2);
  });
});

describe("applyMode", () => {
  it("frees VRAM when the user leaves Local", async () => {
    await loadEngine();
    await applyMode("api");
    expect(unloaded).toBe(1);
  });

  it("does not unload on Gemini → API (no local engine involved)", async () => {
    await loadEngine();
    await applyMode("gemini");
    expect(unloaded).toBe(1);
    // Only the transition away from Local counts once; switching between the
    // two cloud modes must not unload again.
    await applyMode("api");
    expect(unloaded).toBe(1);
  });

  it("is a no-op while staying on Local", async () => {
    await loadEngine();
    await applyMode("webgpu");
    expect(unloaded).toBe(0);
    const again = await translateLocal(["こんにちは"], "English", "Japanese");
    expect(again.translations).toHaveLength(1);
    // Reused the resident engine instead of paying a 3–6 GB reload.
    expect(created).toBe(1);
  });
});

describe("releaseLocalLlmIdle", () => {
  it("defers a release requested mid-page to the last job", async () => {
    await loadEngine();

    let finishJob!: () => void;
    const gate = new Promise<void>((resolve) => {
      finishJob = resolve;
    });
    const job = withLocalLlmJob(async () => {
      await gate;
      return "done";
    });

    const released = await releaseLocalLlmIdle();
    expect(released).toBe(false);
    expect(unloaded).toBe(0);

    finishJob();
    await job;
    // The deferred release is fire-and-forget inside the job's `finally`.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unloaded).toBe(1);
  });

  it("releases immediately when nothing is running", async () => {
    await loadEngine();
    expect(await releaseLocalLlmIdle()).toBe(true);
    expect(unloaded).toBe(1);
  });
});
