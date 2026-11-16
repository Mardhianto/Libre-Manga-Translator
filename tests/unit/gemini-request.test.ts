import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DefaultConfig } from "../../src/lib/configs";
import { sendRequestToGemini } from "../../src/lib/gemini/main";
import { isTransientError } from "../../src/lib/request-retry";

/**
 * Gemini's retry policy is the same one the API backend uses (LMT-034): a 503
 * "high demand" is a property of the moment and must be retried, while a 400
 * from a bad key or model name must fail immediately. These tests pin that,
 * because the previous behaviour — one attempt, no status on the error — turned
 * a temporary spike into a hard page failure on every open page.
 */

const originalFetch = globalThis.fetch;
const originalRetries = DefaultConfig.geminiMaxRetries;
const originalDelay = DefaultConfig.geminiRetryDelayMs;

beforeEach(() => {
  // Keep the suite fast: the policy, not the clock, is what is under test.
  DefaultConfig.geminiRetryDelayMs = 1;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  DefaultConfig.geminiMaxRetries = originalRetries;
  DefaultConfig.geminiRetryDelayMs = originalDelay;
});

function geminiOk(text: unknown) {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: { parts: [{ text: JSON.stringify(text) }] },
          finishReason: "STOP",
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function geminiError(status: number, message: string, retryAfter?: string) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (retryAfter) headers.set("Retry-After", retryAfter);
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers,
  });
}

const okPayload = { translations: [{ text: "hello" }] };

function call() {
  return sendRequestToGemini("system", "user", "key", "gemini-2.5-flash", 0.3);
}

describe("sendRequestToGemini retry policy", () => {
  it("retries a 503 and succeeds on the next attempt", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return geminiError(503, "high demand");
      return geminiOk(okPayload);
    }) as unknown as typeof fetch;

    const result = await call();
    expect(calls).toBe(2);
    expect(result.data).toEqual(okPayload);
  });

  it("retries a 429 up to the configured cap, then throws a transient error", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return geminiError(429, "quota exceeded");
    }) as unknown as typeof fetch;

    const error = await call().catch((err) => err);
    expect(calls).toBe(DefaultConfig.geminiMaxRetries + 1);
    expect((error as Error).message).toContain("quota exceeded");
    expect((error as { status?: number }).status).toBe(429);
    expect(isTransientError(error)).toBe(true);
  });

  it("does not retry a 400 (bad key / bad model)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return geminiError(400, "API key not valid");
    }) as unknown as typeof fetch;

    const error = await call().catch((err) => err);
    expect(calls).toBe(1);
    expect((error as Error).message).toContain("API key not valid");
    expect(isTransientError(error)).toBe(false);
  });

  it("honours Retry-After instead of its own backoff", async () => {
    DefaultConfig.geminiMaxRetries = 1;
    const timestamps: number[] = [];
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      timestamps.push(Date.now());
      if (calls === 1) return geminiError(503, "high demand", "0.05");
      return geminiOk(okPayload);
    }) as unknown as typeof fetch;

    await call();
    expect(calls).toBe(2);
    // 50 ms of Retry-After, not the 1 ms configured backoff.
    expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(40);
  });

  it("keeps the status when the error body is not JSON", async () => {
    globalThis.fetch = (async () =>
      new Response("<html>service unavailable</html>", {
        status: 503,
        headers: { "Content-Type": "text/html" },
      })) as unknown as typeof fetch;

    const error = await call().catch((err) => err);
    expect((error as { status?: number }).status).toBe(503);
    // The opaque HTML body must not hide the real failure.
    expect((error as Error).message).toContain("503");
    expect(isTransientError(error)).toBe(true);
  });

  it("never retries an aborted job", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      controller.signal.throwIfAborted();
      return geminiOk(okPayload);
    }) as unknown as typeof fetch;

    const error = await sendRequestToGemini(
      "system",
      "user",
      "key",
      "gemini-2.5-flash",
      0.3,
      undefined,
      controller.signal,
    ).catch((err) => err);

    expect(calls).toBe(0);
    expect((error as Error).name).toBe("AbortError");
  });

  it("rejects a key that is not printable ASCII before any request", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return geminiOk(okPayload);
    }) as unknown as typeof fetch;

    await expect(
      sendRequestToGemini("system", "user", "key\u200b", "gemini-2.5-flash", 0.3),
    ).rejects.toThrow(/invisible\/non-ASCII/);
    expect(calls).toBe(0);
  });
});
