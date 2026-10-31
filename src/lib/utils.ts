import * as ort from "onnxruntime-web/all";
import { resolveExecutionProvidersForModel } from "./hardware";
import { getExpectedSha256, verifyBufferSha256 } from "./manifests/hashes";

export function sniffMime(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png";
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
    return "image/gif";
  if (
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  )
    return "image/avif";
  return "image/jpeg";
}

export async function fetchAsImageBitmap(url: string): Promise<ImageBitmap> {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const mime = sniffMime(bytes);
  const blob = new Blob([arrayBuffer], { type: mime });
  return createImageBitmap(blob);
}

export function arrayBufferToBase64DataUrl(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const mime = sniffMime(bytes);
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

export async function fetchAsBase64(url: string) {
  const res = await fetch(url);
  const blob = await res.blob();
  const mimeType = blob.type || "image/jpeg";
  const arrayBuffer = await blob.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuffer);
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < uint8.length; i += chunkSize) {
    binary += String.fromCharCode(...uint8.subarray(i, i + chunkSize));
  }
  const base64 = btoa(binary);
  return `data:${mimeType};base64,${base64}`;
}

// Store in-flight requests to prevent duplicate network calls
const inFlightRequests = new Map<
  string,
  Promise<ort.InferenceSession | Response | undefined>
>();

export function downloadArtifactHF(
  repoID: string,
  path: `${string}.onnx`,
  noReturn?: boolean,
  options?: { gpu?: boolean },
): Promise<ort.InferenceSession>;

export function downloadArtifactHF(
  repoID: string,
  path: string,
  noReturn?: boolean,
  options?: { gpu?: boolean },
): Promise<Response>;

export async function downloadArtifactHF(
  repoID: string,
  path: string,
  noReturn?: boolean,
  options?: { gpu?: boolean },
): Promise<ort.InferenceSession | Response | undefined> {
  const isDirectUrl =
    path.startsWith("http://") ||
    path.startsWith("https://") ||
    repoID.startsWith("http://") ||
    repoID.startsWith("https://");

  const url = isDirectUrl
    ? path.startsWith("http://") || path.startsWith("https://")
      ? path
      : `${repoID}/${path}`
    : `https://huggingface.co/${repoID}/resolve/main/${path}`;

  const cacheName = isDirectUrl ? "direct-model-cache" : repoID;

  if (inFlightRequests.has(url)) {
    const result = await inFlightRequests.get(url);
    return result instanceof Response ? result.clone() : result;
  }

  const requestPromise = (async () => {
    const cache = await caches.open(cacheName);

    // Cache-first: silent per-load update checks were removed. Updates are
    // manual via CHECK_MODEL_UPDATES / UPDATE_CACHED_MODEL (updates.ts).
    let response = await cache.match(url);

    if (!response) {
      const fetched = await fetch(url);
      if (!fetched.ok) throw new Error(`Failed to download model from ${url} (${fetched.status} ${fetched.statusText})`);
      const buffer = await fetched.arrayBuffer();

      const expectedSha256 = getExpectedSha256(path, url);
      if (expectedSha256) {
        const isValid = await verifyBufferSha256(buffer, expectedSha256);
        if (!isValid) {
          await cache.delete(url).catch(() => {});
          throw new Error(`Integrity check failed: SHA-256 mismatch for ${path}`);
        }
      }

      response = new Response(buffer, {
        headers: fetched.headers,
        status: fetched.status,
        statusText: fetched.statusText,
      });
      await cache.put(url, response.clone());
    }

    if (noReturn) return;

    if (path.endsWith(".onnx") || url.endsWith(".onnx") || url.includes(".onnx?")) {
      const modelIdentifier = path || url;
      const providers = resolveExecutionProvidersForModel(modelIdentifier, options?.gpu);
      // Copy bytes per attempt: a failed create() may neuter the buffer,
      // so the WASM retry gets fresh bytes, not a detached view.
      const modelBytes = new Uint8Array(await response.arrayBuffer());
      try {
        return await ort.InferenceSession.create(modelBytes.slice().buffer, {
          executionProviders: providers,
        });
      } catch (err: any) {
        if (providers.includes("webgpu")) {
          console.warn(`[ort] WebGPU session creation failed for ${modelIdentifier}, falling back to WASM:`, err?.message);
          return await ort.InferenceSession.create(modelBytes.slice().buffer, {
            executionProviders: ["wasm"],
          });
        }
        throw err;
      }
    } else {
      return response.clone();
    }
  })();

  inFlightRequests.set(url, requestPromise);

  try {
    const result = await requestPromise;
    return result instanceof Response ? result.clone() : result;
  } finally {
    inFlightRequests.delete(url);
  }
}

export async function downloadArtifactFromUrl(
  url: string,
  cacheKey: string = "direct-model-cache",
  options?: { gpu?: boolean },
): Promise<ort.InferenceSession> {
  const res = await downloadArtifactHF(cacheKey, url, false, options);
  return res as unknown as ort.InferenceSession;
}

export async function openSetupTab(modelId?: string, clean?: boolean) {
  await browser.runtime.sendMessage({
    type: "OPEN_SETUP_TAB",
    data: { modelId, clean },
  });
}

/**
 * Probe the extension-side CacheStorage via the background service worker.
 * Direct `caches.open()` from a content-world context (sidebar/overlay
 * shadow UIs) reads the page's partition — not the partition the popup,
 * setup tab, offscreen doc, and service worker share. Routing through the
 * background guarantees every UI reads the same partition.
 * Falls back to a local probe if the background is unreachable.
 */
export async function probeArtifactsCached(
  entries: { repo: string; path: string }[],
): Promise<boolean[]> {
  try {
    const res = (await browser.runtime.sendMessage({
      type: "IS_MODEL_CACHED",
      data: { entries },
    })) as { results?: boolean[] };
    if (Array.isArray(res?.results) && res.results.length === entries.length) {
      return res.results;
    }
  } catch {
    // fall through to local probe
  }
  return Promise.all(
    entries.map((e) => isArtifactCached(e.repo, e.path)),
  );
}

/**
 * Intersect `local:cached-llms` (stale-prone: written once at setup
 * download) with real WebLLM weight presence via offscreen
 * `hasModelInCache`. Returns the verified-cached ids; prunes stale
 * entries from storage as a side effect (self-heal).
 */
export async function probeLlmsCached(modelIds: string[]): Promise<string[]> {
  let statuses: Record<string, boolean> | null = null;
  try {
    const res = (await browser.runtime.sendMessage({
      type: "LLM_CACHE_STATUS",
      data: { modelIds },
    })) as { success?: boolean; statuses?: Record<string, boolean> };
    // Only trust an explicit success: a failed probe must not wipe the list.
    if (res?.success && res.statuses) statuses = res.statuses;
  } catch {
    // fall through: probe unavailable, keep existing list
  }
  if (!statuses) return [...modelIds];
  const verified = modelIds.filter((id) => statuses[id] === true);
  // Self-heal: drop ids the probe says are missing, keep newly verified ones.
  try {
    const items = await storage.getItems(["local:cached-llms"]);
    const listed = (items[0]?.value as string[]) || [];
    const merged = [
      ...new Set([
        ...listed.filter((id) => (statuses && id in statuses ? statuses[id] : true)),
        ...verified,
      ]),
    ];
    if (merged.length !== listed.length || merged.some((id, i) => id !== listed[i])) {
      await storage.setItem("local:cached-llms", merged);
    }
  } catch {
    // storage prune is best-effort
  }
  return verified;
}

/**
 * Check if a specific artifact exists in CacheStorage with a valid (> 1KB) body.
 */
export async function isArtifactCached(
  repoID: string,
  path: string,
): Promise<boolean> {
  try {
    const isDirectUrl =
      path.startsWith("http://") ||
      path.startsWith("https://") ||
      repoID.startsWith("http://") ||
      repoID.startsWith("https://");

    const url = isDirectUrl
      ? path.startsWith("http://") || path.startsWith("https://")
        ? path
        : `${repoID}/${path}`
      : `https://huggingface.co/${repoID}/resolve/main/${path}`;

    const cacheName = isDirectUrl ? "direct-model-cache" : repoID;
    const cache = await caches.open(cacheName);
    const matched = await cache.match(url);
    if (!matched || !matched.ok) return false;
    const blob = await matched.blob();
    return blob.size > 1024;
  } catch {
    return false;
  }
}

/**
 * In-memory chunks retained after a Pause (abort). Keyed by resolved URL.
 * Deliberately not persisted — a killed worker or closed page drops partials
 * (completed files stay in CacheStorage and are skipped on restart).
 * Lives in module scope so every caller in this JS context (page, worker)
 * shares one store; cross-context sharing goes through the background
 * download manager, which holds its own store in the worker heap.
 */
const partialDownloads = new Map<string, { chunks: Uint8Array[]; loaded: number; total: number }>();

/** Resolve a repo/path pair to its download URL + CacheStorage name. */
export function resolveArtifactUrl(repoID: string, path: string): { url: string; cacheName: string } {
  const isDirectUrl =
    path.startsWith("http://") ||
    path.startsWith("https://") ||
    repoID.startsWith("http://") ||
    repoID.startsWith("https://");

  const url = isDirectUrl
    ? path.startsWith("http://") || path.startsWith("https://")
      ? path
      : `${repoID}/${path}`
    : `https://huggingface.co/${repoID}/resolve/main/${path}`;

  return { url, cacheName: isDirectUrl ? "direct-model-cache" : repoID };
}

/**
 * Stream a resolved artifact URL into CacheStorage with progress reporting.
 *
 * Supports user-controlled Pause / Resume / Stop via `opts.signal`:
 * - Pause: abort the fetch with an AbortController; received chunks are kept
 *   in the in-memory partial store keyed by URL.
 * - Resume: call again (same URL); a `Range: bytes=<loaded>-` request
 *   continues where the previous attempt left off (server must honor Range;
 *   otherwise the file restarts from scratch).
 * - Stop: abort, then call `clearPartialByUrl(url)` to discard
 *   the retained chunks.
 * Callers must swallow abort errors (see `isAbortError`) instead of
 * surfacing them as failures. A stream that ends short of the advertised
 * length is never cached — it keeps its partial and throws a resumable error.
 */
export async function streamArtifactToCache(
  url: string,
  cacheName: string,
  opts?: { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void },
): Promise<void> {
  const onProgress = opts?.onProgress;
  const cache = await caches.open(cacheName);

  // If already cached and valid, notify 100% and finish
  const existing = await cache.match(url);
  if (existing && existing.ok) {
    const blob = await existing.blob();
    if (blob.size > 1024) {
      if (onProgress) onProgress(blob.size, blob.size);
      return;
    }
    await cache.delete(url);
  }

  const signal = opts?.signal;
  if (signal?.aborted) throw new DOMException("Download aborted", "AbortError");

  // Resume from a previously paused attempt (chunks retained in memory).
  let partial = partialDownloads.get(url);
  let startByte = partial?.loaded ?? 0;

  const doFetch = async (from: number): Promise<Response> => {
    const headers = from > 0 ? { Range: `bytes=${from}-` } : undefined;
    return fetch(url, { signal, headers });
  };

  let res = await doFetch(startByte);
  // Unsatisfiable range (file completed elsewhere) — drop partial, restart fresh.
  if (res.status === 416) {
    partialDownloads.delete(url);
    partial = undefined;
    startByte = 0;
    res = await doFetch(0);
  }
  if (!res.ok && res.status !== 206)
    throw new Error(`Download failed: HTTP ${res.status} (${res.statusText})`);

  const isPartial = res.status === 206;
  if (!isPartial && startByte > 0) {
    // Server ignored Range — restart this file from scratch.
    partialDownloads.delete(url);
    partial = undefined;
    startByte = 0;
  }

  const contentLength = res.headers.get("content-length");
  const contentRangeTotal = res.headers.get("content-range")?.match(/\/(\d+)\s*$/)?.[1];
  const total = contentRangeTotal
    ? parseInt(contentRangeTotal, 10)
    : contentLength
      ? (isPartial ? startByte : 0) + parseInt(contentLength, 10)
      : (partial?.total ?? 0);

  if (!res.body) {
    const blob = await res.blob();
    if (signal?.aborted) throw new DOMException("Download aborted", "AbortError");
    // Small non-streaming bodies can't resume mid-file — cache whole blob.
    if (startByte === 0) {
      await cache.put(url, new Response(blob, { headers: res.headers }));
    }
    if (onProgress) onProgress(blob.size, blob.size);
    return;
  }

  const entry = partial ?? { chunks: [] as Uint8Array[], loaded: 0, total };
  entry.total = total || entry.total;
  // Retain chunks before streaming so an abort keeps what arrived so far.
  partialDownloads.set(url, entry);
  const chunks = entry.chunks;
  let loaded = startByte > 0 ? entry.loaded : 0;
  if (startByte === 0 && chunks.length > 0) {
    chunks.length = 0;
    loaded = 0;
  }

  const reader = res.body.getReader();
  const onAbort = () => {
    try {
      reader.cancel();
    } catch {
      // ignore — abort path rethrows below
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Download aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.length;
        entry.loaded = loaded;
        entry.total = total || entry.total;
        if (onProgress) onProgress(loaded, total);
      }
    }
  } catch (err) {
    // Keep partial chunks for Resume; Stop callers clear via clearPartialDownload.
    entry.loaded = loaded;
    throw err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  // reader.cancel() on abort resolves the pending read() with done:true, so
  // the loop above can exit "normally" on a truncated stream. Never cache
  // that as complete — Pause keeps the partial for Resume, anything else fails.
  if (signal?.aborted) throw new DOMException("Download aborted", "AbortError");
  if (total > 0 && loaded !== total) {
    entry.loaded = loaded;
    throw new Error(
      `Download incomplete: received ${(loaded / 1024 / 1024).toFixed(1)} MB of ${(total / 1024 / 1024).toFixed(1)} MB. Resume to continue.`,
    );
  }

  // Firefox limits individual ArrayBuffer/ArrayBufferView to 2GB in WebIDL.
  // Pass chunk array directly to Blob; each chunk is << 2GB.
  const blob = new Blob(chunks as BlobPart[]);
  const headers = new Headers(res.headers);
  headers.set("content-length", String(loaded));
  headers.delete("content-range");
  const finalResponse = new Response(blob, {
    status: 200,
    statusText: "OK",
    headers,
  });

  await cache.put(url, finalResponse);
  partialDownloads.delete(url);
}

/**
 * Download an artifact with streaming progress reporting and store in CacheStorage.
 * Thin wrapper over `streamArtifactToCache` — same Pause/Resume/Stop contract
 * (see above). Prefer the background download manager for UI downloads so
 * pause/resume works across setup tab, popup, and sidebar.
 */
export async function fetchAndCacheWithProgress(
  repoID: string,
  path: string,
  onProgress?: (loaded: number, total: number) => void,
  options?: { signal?: AbortSignal },
): Promise<void> {
  const { url, cacheName } = resolveArtifactUrl(repoID, path);
  return streamArtifactToCache(url, cacheName, { signal: options?.signal, onProgress });
}

/** Discard retained partial chunks (Stop). Completed cache entries are kept. */
export function clearPartialDownload(repoID: string, path: string): void {
  partialDownloads.delete(resolveArtifactUrl(repoID, path).url);
}

/** Same as `clearPartialDownload` for callers that already resolved the URL. */
export function clearPartialByUrl(url: string): void {
  partialDownloads.delete(url);
}

/** Discard ALL retained partial chunks (e.g. Clear All in storage manager). */
export function clearAllPartialDownloads(): void {
  partialDownloads.clear();
}

/** True for user-initiated Pause/Stop aborts (fetch + WebLLM reload). */
export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  if (name === "AbortError") return true;
  const msg = (err as { message?: unknown }).message;
  return typeof msg === "string" && /abort/i.test(msg);
}

/**
 * Cooperative time-slicing. Yields event loop to pending UI tasks (e.g. extension popup clicks).
 * Uses native `scheduler.yield()` when available (Chromium 115+), falling back to `setTimeout(0)`.
 */
export async function yieldToMain(): Promise<void> {
  if (typeof (globalThis as any).scheduler?.yield === "function") {
    return (globalThis as any).scheduler.yield();
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface RunLock {
  <T>(task: () => Promise<T>): Promise<T>;
  getDeadLetterCount(): number;
  reset(): void;
}

/**
 * Shared global tail across all ONNX Runtime locks in the same JS context.
 * ONNX Runtime Web's WASM backend is non-reentrant across sessions in the
 * same thread ("Session already started"), so all ORT subsystems share one
 * underlying execution chain while keeping per-subsystem dead-letter counters.
 */
let sharedOrtTail: Promise<unknown> = Promise.resolve();

/**
 * FIFO promise serializer with dead-letter isolation.
 * Prevents concurrent inference runs on non-reentrant ONNX sessions.
 * One task rejection never breaks or stalls subsequent tasks in chain.
 */
export function createRunLock(subsystem = "core"): RunLock {
  let deadLetters = 0;

  const lock = function runExclusive<T>(task: () => Promise<T>): Promise<T> {
    // ponytail: unbounded queue; upgrade to bounded semaphore if memory spikes under burst.
    const run = () => task();
    const result = sharedOrtTail.then(run, run);
    sharedOrtTail = result.catch((err) => {
      deadLetters++;
      console.error(`[dead-letter:${subsystem}] (#${deadLetters}) Task rejected:`, err);
    });
    return result;
  } as RunLock;

  lock.getDeadLetterCount = () => deadLetters;
  lock.reset = () => {
    sharedOrtTail = Promise.resolve();
    deadLetters = 0;
  };

  return lock;
}
