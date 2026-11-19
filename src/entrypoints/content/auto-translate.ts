import { resolveActiveSiteRule, type SiteRule } from "@/lib/adapters";
import { storage } from "#imports";
import * as Registry from "./translation-registry";
import { getElementSrc, type MangaTargetElement } from "@/lib/canvas";

export type TranslateFn = (img: MangaTargetElement) => Promise<void>;

export const MANUAL_CONCURRENCY = 3;

/**
 * A page is dispatched at most this many times by the auto queue (LMT-034).
 * Without a cap, a provider outage produced an endless
 * fail → idle → rescan → enqueue loop: every cycle spent a slot, churned
 * `lmt:translation-status` events, and (through the old per-page modal)
 * replaced the error dialog the user was aiming at.
 */
export const MAX_AUTO_ATTEMPTS = 2;

/** Consecutive page failures that pause automatic work. */
export const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Event the overlay dispatches when its pipeline fails.
 *
 * The overlay owns the message (it is the only place that knows whether the
 * failure came from detection, translation or rendering), and decides how to
 * show it: a dismissible dialog for a manual run, a toast once the page is
 * auto-translating and the reader is scrolling past it. The queue listens only
 * to spend the retry budget and to decide when to stop hammering a provider.
 */
export interface TranslationFailureDetail {
  src: string;
  message: string;
}

export interface AutoTranslateCallbacks {
  /** Automatic work stopped after a run of failures. */
  onQueuePaused?: (failedPages: number) => void;
}

export class AutoTranslateQueue {
  private queue: { img: MangaTargetElement; fn: TranslateFn }[] = [];
  // Slots are held for the full pipeline lifetime and released on the
  // registry `lmt:translation-status` done/idle events — NOT when
  // translateFn settles (it resolves right after overlay mount, long
  // before detect/translate/inpaint finish).
  private inFlight = new Set<string>();
  private concurrency = 1;
  private seenKeys = new Set<string>();
  private lastTranslateFn: TranslateFn | null = null;
  private statusListener: ((e: Event) => void) | null = null;
  private failureListener: ((e: Event) => void) | null = null;
  /** srcKey → attempts spent since the last success (LMT-034). */
  private attempts = new Map<string, number>();
  /** Pages whose budget is gone: they wait for the user, not for a rescan. */
  private failed = new Set<string>();
  /** srcKey → failure message awaiting the trailing `idle` event. */
  private pendingFailure = new Map<string, string>();
  /** Pages dispatched by the observer rather than by a user click. */
  private autoInFlight = new Set<string>();
  private consecutiveFailures = 0;
  private paused = false;

  constructor(private callbacks: AutoTranslateCallbacks = {}) {
    this.statusListener = (e: Event) => {
      const detail = (e as CustomEvent<{ src?: string; status?: string }>)
        .detail;
      if (!detail || !detail.src) return;
      if (detail.status !== "done" && detail.status !== "idle") return;
      const k = Registry.srcKeyOf(detail.src);

      if (detail.status === "done") {
        // A clean page clears its budget and the failure streak: the provider
        // is healthy again, so a paused queue may resume.
        this.attempts.delete(k);
        this.pendingFailure.delete(k);
        this.autoInFlight.delete(k);
        this.consecutiveFailures = 0;
        this.paused = false;
        this.inFlight.delete(k);
        // done → keep seenKeys so finished pages never requeue.
        if (this.lastTranslateFn) this.drain(this.lastTranslateFn);
        return;
      }

      // idle: the pipeline ended. Only a page that also emitted a failure
      // event is charged — closing the overlay by hand is not a failure.
      const message = this.pendingFailure.get(k);
      this.pendingFailure.delete(k);
      if (message !== undefined) {
        this.settleFailure(k, message);
      } else if (!this.failed.has(k)) {
        this.seenKeys.delete(k);
      }
      this.autoInFlight.delete(k);
      this.inFlight.delete(k);
      if (this.lastTranslateFn) this.drain(this.lastTranslateFn);
    };
    document.addEventListener("lmt:translation-status", this.statusListener);

    this.failureListener = (e: Event) => {
      const detail = (e as CustomEvent<TranslationFailureDetail>).detail;
      if (!detail?.src) return;
      this.pendingFailure.set(
        Registry.srcKeyOf(detail.src),
        detail.message || "Translation failed",
      );
    };
    document.addEventListener("lmt:translation-failure", this.failureListener);
  }

  setCallbacks(callbacks: AutoTranslateCallbacks) {
    this.callbacks = callbacks;
  }

  destroy() {
    if (this.statusListener) {
      document.removeEventListener(
        "lmt:translation-status",
        this.statusListener,
      );
      this.statusListener = null;
    }
    if (this.failureListener) {
      document.removeEventListener(
        "lmt:translation-failure",
        this.failureListener,
      );
      this.failureListener = null;
    }
  }

  setConcurrency(n: number) {
    const clamped = Math.min(10, Math.max(1, Math.trunc(n) || 1));
    if (clamped === this.concurrency) return;
    this.concurrency = clamped;
    if (this.lastTranslateFn && this.inFlight.size < this.concurrency && this.queue.length > 0) {
      this.drain(this.lastTranslateFn);
    }
  }

  getConcurrency() {
    return this.concurrency;
  }

  /** True when automatic work stopped after a run of failures. */
  isPaused() {
    return this.paused;
  }

  get failedCount() {
    return this.failed.size;
  }

  hasFailed(img: MangaTargetElement): boolean {
    const src = getElementSrc(img);
    return src ? this.failed.has(Registry.srcKeyOf(src)) : false;
  }

  /** Clear the failure budget for one page — used by an explicit user retry. */
  clearFailure(img: MangaTargetElement) {
    const src = getElementSrc(img);
    if (!src) return;
    const k = Registry.srcKeyOf(src);
    this.failed.delete(k);
    this.attempts.delete(k);
    this.pendingFailure.delete(k);
  }

  /** Clear every failure budget and resume automatic work. */
  resume() {
    this.failed.clear();
    this.attempts.clear();
    this.pendingFailure.clear();
    this.consecutiveFailures = 0;
    this.paused = false;
    if (this.lastTranslateFn) this.drain(this.lastTranslateFn);
  }

  evict(img: MangaTargetElement) {
    const src = getElementSrc(img);
    if (!src) return;
    const k = Registry.srcKeyOf(src);
    this.seenKeys.delete(k);
    this.attempts.delete(k);
    this.failed.delete(k);
    this.pendingFailure.delete(k);
    this.autoInFlight.delete(k);
    if (this.inFlight.delete(k) && this.lastTranslateFn) {
      this.drain(this.lastTranslateFn);
    }
  }

  enqueue(
    img: MangaTargetElement,
    translateFn: (img: MangaTargetElement) => Promise<void>,
    /** `false` for a user click: it must not feed the auto pause counter. */
    automatic = true,
  ) {
    const src = getElementSrc(img);
    if (!src) return;
    const k = Registry.srcKeyOf(src);
    if (
      Registry.isPending(k) ||
      this.inFlight.has(k) ||
      Registry.getStatus(k) === "done" ||
      this.seenKeys.has(k) ||
      this.queue.some((e) => e.img === img)
    )
      return;
    this.seenKeys.add(k);
    if (automatic) this.autoInFlight.add(k);
    this.queue.push({ img, fn: translateFn });
    this.lastTranslateFn = translateFn;
    this.drain(translateFn);
  }

  /**
   * Charge one failure against a page: silently retry while it has budget
   * left, then park it until the user asks again. A run of consecutive
   * automatic failures stops the whole queue.
   */
  private settleFailure(k: string, _message: string) {
    const attempt = this.attempts.get(k) ?? 0;

    // A manual run is the user insisting: it must not consume the automatic
    // budget or push the queue towards its pause threshold (LMT-034). It does
    // park the page, though — otherwise the very next DOM mutation would
    // re-enqueue the page the user just watched fail, and the modal would
    // reappear on its own.
    if (!this.autoInFlight.has(k)) {
      this.attempts.delete(k);
      this.failed.add(k);
      this.seenKeys.delete(k);
      return;
    }

    if (attempt >= MAX_AUTO_ATTEMPTS) {
      this.failed.add(k);
      this.seenKeys.delete(k);
    } else {
      // Silent retry: a later mutation/rescan may dispatch this page again.
      this.seenKeys.delete(k);
    }

    this.consecutiveFailures += 1;

    if (
      this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES &&
      !this.paused
    ) {
      this.paused = true;
      this.clear();
      this.callbacks.onQueuePaused?.(this.failed.size);
    }
  }

  private drain(translateFn: (img: MangaTargetElement) => Promise<void>) {
    if (this.paused) return;
    while (this.inFlight.size < this.concurrency && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      const targetImg = entry.img;
      const src = getElementSrc(targetImg);
      if (!src || !document.body.contains(targetImg)) {
        // Skip detached images without consuming a slot
        if (src) this.seenKeys.delete(Registry.srcKeyOf(src));
        continue;
      }
      // Strict registry guard at drain time as well (covers race between enqueue and drain)
      const k = Registry.srcKeyOf(src);
      if (Registry.isPending(k) || this.inFlight.has(k)) {
        continue;
      }
      if (Registry.getStatus(k) === "done") {
        this.seenKeys.delete(k);
        continue;
      }
      // A page whose budget is gone must not be dispatched by a rescan.
      if (this.failed.has(k)) {
        this.seenKeys.delete(k);
        continue;
      }

      this.attempts.set(k, (this.attempts.get(k) ?? 0) + 1);
      this.inFlight.add(k);
      // Fire-and-forget: translateFn sets up its own overlay and async
      // flow. Failure or done signals through the registry event above.
      translateFn(targetImg)
        .then(() => {
          // The overlay mounted and owns the rest of the pipeline; nothing to
          // settle here unless it bailed before ever opening.
          if (!Registry.isPending(k) && Registry.getStatus(k) !== "done") {
            this.inFlight.delete(k);
            this.seenKeys.delete(k);
            Registry.markIdle(src);
            if (this.lastTranslateFn) this.drain(this.lastTranslateFn);
          }
        })
        .catch((err) => {
          // Failed before the overlay existed (detection/mount throw): no
          // failure event was dispatched, so settle it here.
          console.warn("LMT: auto-translate task failed:", err);
          this.settleFailure(k, (err as Error)?.message ?? String(err));
          this.pendingFailure.delete(k);
          this.autoInFlight.delete(k);
          this.inFlight.delete(k);
          Registry.markIdle(src);
          if (this.lastTranslateFn) this.drain(this.lastTranslateFn);
        });
    }
  }

  clear() {
    for (const entry of this.queue) {
      const src = getElementSrc(entry.img);
      if (src) this.seenKeys.delete(Registry.srcKeyOf(src));
    }
    this.queue = [];
  }

  get length() {
    return this.queue.length;
  }

  get activeCount() {
    return this.inFlight.size;
  }
}

export class AutoTranslateOrchestrator {
  private isEnabled = false;
  private observer: IntersectionObserver | null = null;
  private mutationObserver: MutationObserver | null = null;
  private queue = new AutoTranslateQueue();
  private observedImages = new WeakSet<MangaTargetElement>();
  private activeRule: SiteRule | null = null;
  private translateFn: ((img: MangaTargetElement) => Promise<void>) | null = null;
  private unwatchStorage: (() => void) | null = null;
  private unwatchConcurrency: (() => void) | null = null;

  async init(
    translateFn: (img: MangaTargetElement) => Promise<void>,
    callbacks: AutoTranslateCallbacks = {},
  ) {
    this.translateFn = translateFn;
    this.queue.setCallbacks(callbacks);

    await this.applyCap();
    const initialEnabled =
      await storage.getItem<boolean>("sync:auto-translate");
    if (initialEnabled ?? false) {
      await this.start();
    }

    this.unwatchStorage = storage.watch<boolean>(
      "sync:auto-translate",
      async (newVal) => {
        if (newVal) {
          // Cap first so the rescan drains at the slider value, not stale 3.
          await this.applyCap();
          // Turning auto ON is an explicit request to try the failed pages
          // again, so the budget resets here and only here.
          this.queue.resume();
          this.start();
        } else {
          this.stop();
          // Manual-only mode: absolute cap of 3, slider ignored.
          this.queue.setConcurrency(MANUAL_CONCURRENCY);
        }
      },
    );

    this.unwatchConcurrency = storage.watch<number>(
      "sync:auto-translate-concurrency",
      async () => {
        await this.applyCap();
      },
    );
  }

  /** Manual pill path: shares the same queue even when auto is off. */
  enqueueManual(img: MangaTargetElement) {
    // An explicit user click always overrides an earlier failure.
    this.queue.clearFailure(img);
    if (this.translateFn) {
      // `automatic: false` — a manual run must not push the queue towards its
      // automatic pause threshold (LMT-034).
      this.queue.enqueue(img, this.translateFn, false);
    }
  }

  /** User asked to try every failed page again. */
  retryFailed() {
    this.queue.resume();
  }

  isPaused() {
    return this.queue.isPaused();
  }

  /** Unified cap: slider 1..10 when auto ON, absolute 3 when OFF. */
  private async applyCap() {
    const [enabled, slider] = await Promise.all([
      storage.getItem<boolean>("sync:auto-translate"),
      storage.getItem<number>("sync:auto-translate-concurrency"),
    ]);
    this.queue.setConcurrency(
      enabled ? (slider ?? 1) : MANUAL_CONCURRENCY,
    );
  }

  async start() {
    if (this.isEnabled) return;
    this.isEnabled = true;
    this.activeRule = await resolveActiveSiteRule();

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (
            entry.isIntersecting &&
            (entry.target instanceof HTMLImageElement || entry.target instanceof HTMLCanvasElement)
          ) {
            const img = entry.target;
            this.observer?.unobserve(img);
            if (this.translateFn) {
              this.queue.enqueue(img, this.translateFn);
            }
          }
        }
      },
      {
        root: null,
        rootMargin: "200px",
        threshold: 0,
      },
    );

    this.scanAndObserve();

    this.mutationObserver = new MutationObserver((mutations) => {
      if (!this.isEnabled) return;
      let shouldScan = false;
      for (const m of mutations) {
        if (m.addedNodes.length > 0) {
          shouldScan = true;
          break;
        }
      }
      if (shouldScan) {
        this.scanAndObserve();
      }
    });

    this.mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  stop() {
    this.isEnabled = false;
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
    }
    this.queue.clear();
    // Fresh WeakSet so a restart rescan re-observes dropped pages.
    // In-flight pipelines keep their registry slots and finish normally.
    this.observedImages = new WeakSet();
  }

  destroy() {
    this.stop();
    this.queue.destroy();
    if (this.unwatchStorage) {
      this.unwatchStorage();
      this.unwatchStorage = null;
    }
    if (this.unwatchConcurrency) {
      this.unwatchConcurrency();
      this.unwatchConcurrency = null;
    }
  }

  private isQualifyingImage(img: MangaTargetElement): boolean {
    if (this.activeRule?.imageSelector) {
      try {
        if (img.matches(this.activeRule.imageSelector)) return true;
      } catch {
        // Selector syntax error fallback
      }
    }

    // Generic fallback: images or canvases must be strictly > 500px in both dimensions
    const naturalW = "naturalWidth" in img ? img.naturalWidth : img.width;
    const naturalH = "naturalHeight" in img ? img.naturalHeight : img.height;
    const clientW = img.clientWidth || img.offsetWidth;
    const clientH = img.clientHeight || img.offsetHeight;

    if (naturalW > 0 && naturalH > 0) {
      return naturalW > 500 && naturalH > 500;
    }

    return clientW > 500 && clientH > 500;
  }

  private observeImage(img: MangaTargetElement) {
    if (this.observedImages.has(img)) return;
    const src = getElementSrc(img);
    if (!src) return;
    const k = Registry.srcKeyOf(src);
    if (Registry.isPending(k) || Registry.getStatus(k) === "done") return;
    // A page whose attempts are gone waits for the user, not for the next DOM
    // mutation to re-enqueue it (LMT-034).
    if (this.queue.hasFailed(img)) return;

    const isReady =
      img instanceof HTMLCanvasElement
        ? img.width > 0 && img.height > 0
        : img.complete && img.naturalWidth > 0;

    if (isReady) {
      if (this.isQualifyingImage(img)) {
        this.observedImages.add(img);
        this.observer?.observe(img);
      }
    } else if (img instanceof HTMLImageElement) {
      const onLoad = () => {
        img.removeEventListener("load", onLoad);
        if (!this.isEnabled) return;
        const kk = Registry.srcKeyOf(getElementSrc(img));
        if (Registry.isPending(kk) || Registry.getStatus(kk) === "done") return;
        if (this.queue.hasFailed(img)) return;
        if (this.isQualifyingImage(img)) {
          this.observedImages.add(img);
          this.observer?.observe(img);
        }
      };
      img.addEventListener("load", onLoad, { once: true });
    }
  }

  private scanAndObserve() {
    if (!this.isEnabled) return;

    if (this.activeRule?.imageSelector) {
      const root = this.activeRule.containerSelector
        ? document.querySelector(this.activeRule.containerSelector) ?? document
        : document;

      try {
        const matchingImgs = root.querySelectorAll<MangaTargetElement>(
          this.activeRule.imageSelector,
        );
        matchingImgs.forEach((img) => this.observeImage(img));
        if (matchingImgs.length > 0) return;
      } catch {
        // Fall back to generic scan if rule query fails
      }
    }

    // Fallback scan across all document images & canvases
    const allImages = document.querySelectorAll<MangaTargetElement>("img, canvas");
    allImages.forEach((img) => this.observeImage(img));
  }
}
