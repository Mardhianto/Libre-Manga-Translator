import { beforeEach, describe, expect, it } from "bun:test";

/**
 * LMT-029 on the Firefox branch: the wllama singleton used to live for the
 * whole hidden-inference iframe, so leaving Local kept a multi-GB GGUF model
 * (plus its worker) resident. The engine itself needs WebGPU + a real GGUF, so
 * these tests cover the release *seam* — the deferred-release bookkeeping that
 * `translateWithWllama` / `makeSiteRuleWithWllama` participate in.
 */
const { applyMode, releaseLocalLlm, releaseLocalLlmIdle, translateWithWllama, withLocalLlmJob } =
  await import("../../src/lib/wllama");

beforeEach(async () => {
  await releaseLocalLlm();
});

describe("wllama release seam", () => {
  it("is a safe no-op when no model was ever loaded", async () => {
    await releaseLocalLlm();
    await releaseLocalLlm();
    expect(await releaseLocalLlmIdle()).toBe(true);
  });

  it("does not tear down the engine while staying on Local", async () => {
    // Nothing to release here, but the call must resolve without throwing:
    // `applyMode` runs on every mode write, including Local → Local.
    await expect(applyMode("webgpu")).resolves.toBeUndefined();
  });

  it("defers a release requested mid-page to the last job", async () => {
    let finishJob!: () => void;
    const gate = new Promise<void>((resolve) => {
      finishJob = resolve;
    });
    const job = withLocalLlmJob(async () => {
      await gate;
      return "done";
    });

    // The page is mid-translation: releasing now would kill the worker.
    expect(await releaseLocalLlmIdle()).toBe(false);

    finishJob();
    expect(await job).toBe("done");

    // The deferred release already ran in the job's `finally`; nothing is
    // running, so the next request releases immediately.
    expect(await releaseLocalLlmIdle()).toBe(true);
  });

  it("counts a whole translate call as one job (correction retry included)", async () => {
    // An empty page returns before the engine is touched, which is exactly the
    // path that must not leave a stray `activeJobs` entry behind.
    const result = await translateWithWllama([], "English", "Japanese");
    expect(result.translations).toEqual([]);
    expect(await releaseLocalLlmIdle()).toBe(true);
  });
});
