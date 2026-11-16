/**
 * Shared retry policy for every LLM transport (LMT-034).
 *
 * Both backends (`server/main.ts`, `gemini/main.ts`) need the same answer to
 * "is this failure worth another round-trip?", and getting it wrong is
 * expensive in both directions: retrying a malformed answer doubles the bill
 * for the same mistake, and not retrying a 503 turns a five-second hiccup into
 * a hard page failure. The predicates live here, away from ONNX/fetch, so they
 * can be unit-tested without a browser.
 */

/**
 * Marks an error that must not be retried even though its shape looks
 * retryable — a JSON parse failure is a deterministic answer problem, not a
 * transport problem. Keeping the flag inside the error (rather than a return
 * value) lets it survive the offscreen relay.
 */
export function markNonRetryable<T>(error: T): T {
  if (error && typeof error === "object") {
    Object.defineProperty(error, "lmtNoRetry", {
      value: true,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return error;
}

export function isNonRetryable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { lmtNoRetry?: unknown }).lmtNoRetry === true;
}

/**
 * Marks a failure that a later attempt could plausibly fix (rate limit, server
 * overload, socket reset). The overlay reads this to decide whether offering
 * "Retry" is honest — a wrong API key is not.
 */
export function markTransient<T>(error: T): T {
  if (error && typeof error === "object") {
    Object.defineProperty(error, "lmtTransient", {
      value: true,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return error;
}

export function isTransientError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const marked = (error as { lmtTransient?: unknown }).lmtTransient === true;
  if (marked) return true;
  // A malformed answer is deterministic; retrying it only spends a request.
  if (isNonRetryable(error)) return false;
  if (isAbortError(error)) return false;
  const status = statusOf(error);
  // With a status we can be precise: only 429/5xx are the provider's mood.
  if (status !== undefined) return isRetryableStatus(status);
  // No status at all: fetch threw before any response existed (DNS, socket,
  // TLS). That is a transport failure, and transport failures pass.
  return true;
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ((error as { name?: unknown }).name === "AbortError") return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /abort/i.test(message);
}

export function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/**
 * Only transport failures and transient server states deserve another attempt.
 * 4xx means the request itself is wrong (auth, model name, unsupported
 * response_format), 429 is rate limiting, and 5xx is the server's problem.
 * `undefined` = fetch threw before any status existed.
 */
export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  return status === 429 || status >= 500;
}

export function isRetryableRequestError(error: unknown): boolean {
  if (isNonRetryable(error)) return false;
  if (isAbortError(error)) return false;
  return isRetryableStatus(statusOf(error));
}

/** `Retry-After` is either delta-seconds or an HTTP date; both are valid. */
export function parseRetryAfterMs(
  header: string | null,
  now = Date.now(),
): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/**
 * Linear-then-exponential backoff with jitter. Jitter matters here: several
 * pages of the same chapter fail at once (one shared quota), so a fixed delay
 * would resend all of them into the same wall at the same instant.
 *
 * `jitter` is injectable so tests can assert exact numbers.
 */
export function backoffDelayMs(
  attempt: number,
  baseMs: number,
  jitter: () => number = Math.random,
): number {
  const step = Math.max(0, Math.trunc(attempt));
  const raw = baseMs * Math.pow(2, step);
  const spread = Math.min(raw * 0.25, 5_000);
  return Math.round(raw + jitter() * spread);
}

/** Sleep that gives up immediately when the job is cancelled. */
export function delayUnlessAborted(
  ms: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (!(ms > 0)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
