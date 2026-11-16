import { describe, expect, it } from "bun:test";
import {
  backoffDelayMs,
  delayUnlessAborted,
  isAbortError,
  isNonRetryable,
  isRetryableRequestError,
  isRetryableStatus,
  isTransientError,
  markNonRetryable,
  markTransient,
  parseRetryAfterMs,
  statusOf,
} from "../../src/lib/request-retry";

describe("isRetryableStatus", () => {
  it("retries rate limits, server errors and thrown fetches", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    // No status at all: fetch threw before a response existed.
    expect(isRetryableStatus(undefined)).toBe(true);
  });

  it("never retries a request the server rejected on its merits", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });
});

describe("isRetryableRequestError", () => {
  it("honours an explicit non-retryable mark", () => {
    const error = markNonRetryable(
      Object.assign(new Error("truncated answer"), { status: 503 }),
    );
    expect(isNonRetryable(error)).toBe(true);
    // The status alone would have said "retry"; the mark wins.
    expect(isRetryableRequestError(error)).toBe(false);
  });

  it("never retries an abort", () => {
    const aborted = Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
    });
    expect(isAbortError(aborted)).toBe(true);
    expect(isRetryableRequestError(aborted)).toBe(false);
  });

  it("reads the status the transport attached", () => {
    expect(statusOf(Object.assign(new Error("x"), { status: 503 }))).toBe(503);
    expect(statusOf(new Error("x"))).toBeUndefined();
    expect(statusOf(undefined)).toBeUndefined();
  });
});

describe("transient marking", () => {
  it("round-trips through the error object", () => {
    const error = markTransient(new Error("429"));
    expect(isTransientError(error)).toBe(true);
  });

  it("reads a status without an explicit mark", () => {
    expect(isTransientError(Object.assign(new Error("503"), { status: 503 }))).toBe(
      true,
    );
    expect(
      isTransientError(Object.assign(new Error("429"), { status: 429 })),
    ).toBe(true);
  });

  it("treats a status-carrying 400 as permanent", () => {
    expect(isTransientError(Object.assign(new Error("bad key"), { status: 400 }))).toBe(
      false,
    );
  });

  it("treats a thrown fetch as transport trouble, an abort as final", () => {
    // No status: fetch never got a response (DNS/socket/TLS).
    expect(isTransientError(new TypeError("Failed to fetch"))).toBe(true);
    expect(
      isTransientError(Object.assign(new Error("aborted"), { name: "AbortError" })),
    ).toBe(false);
    // A deterministic answer problem is not the provider's mood.
    expect(isTransientError(markNonRetryable(new Error("invalid JSON")))).toBe(
      false,
    );
  });
});

describe("parseRetryAfterMs", () => {
  it("accepts delta-seconds", () => {
    expect(parseRetryAfterMs("3")).toBe(3000);
    expect(parseRetryAfterMs(" 0.5 ")).toBe(500);
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  it("accepts an HTTP date", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfterMs("Thu, 01 Jan 2026 00:00:05 GMT", now)).toBe(5000);
    // A date in the past must not produce a negative wait.
    expect(parseRetryAfterMs("Thu, 01 Jan 2025 00:00:00 GMT", now)).toBe(0);
  });

  it("ignores absent and unparseable values", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("")).toBeUndefined();
    expect(parseRetryAfterMs("soon")).toBeUndefined();
  });
});

describe("backoffDelayMs", () => {
  it("doubles per attempt and stays within the jitter window", () => {
    expect(backoffDelayMs(0, 2000, () => 0)).toBe(2000);
    expect(backoffDelayMs(1, 2000, () => 0)).toBe(4000);
    expect(backoffDelayMs(2, 2000, () => 0)).toBe(8000);
    // 25 % spread, capped at 5 s.
    expect(backoffDelayMs(0, 2000, () => 1)).toBe(2500);
    expect(backoffDelayMs(3, 4000, () => 1)).toBe(32000 + 5000);
  });

  it("never produces a negative or fractional delay", () => {
    expect(backoffDelayMs(-3, 2000, () => 0)).toBe(2000);
    expect(Number.isInteger(backoffDelayMs(1, 333, () => 0.37))).toBe(true);
  });
});

describe("delayUnlessAborted", () => {
  it("resolves true after the wait", async () => {
    await expect(delayUnlessAborted(1)).resolves.toBe(true);
  });

  it("resolves true immediately for a non-positive wait", async () => {
    await expect(delayUnlessAborted(0)).resolves.toBe(true);
  });

  it("gives up when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(delayUnlessAborted(5000, controller.signal)).resolves.toBe(false);
  });

  it("gives up when the job is cancelled mid-wait", async () => {
    const controller = new AbortController();
    const pending = delayUnlessAborted(5000, controller.signal);
    controller.abort();
    await expect(pending).resolves.toBe(false);
  });
});
