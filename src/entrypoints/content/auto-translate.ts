import { resolveActiveSiteRule, type SiteRule } from "@/lib/adapters";
import { storage } from "#imports";
import * as Registry from "./translation-registry";
import { getElementSrc, type MangaTargetElement } from "@/lib/canvas";

export type TranslateFn = (img: MangaTargetElement) => Promise<void>;

export const MANUAL_CONCURRENCY = 3;

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

  constructor() {
    this.statusListener = (e: Event) => {
      const detail = (e as CustomEvent<{ src?: string; status?: string }>)
        .detail;
      if (!detail || !detail.src) return;
      if (detail.status !== "done" && detail.status !== "idle") return;
      const k = Registry.srcKeyOf(detail.src);
      if (detail.status === "idle") {
        // Failure/close/error → allow retry via pill or rescan.
        // Must run even when the slot was already released on `done`:
        // done keeps seenKeys (anti-requeue while overlay is open), and the
        // close path fires idle after inFlight was deleted — without this,
        // the pill's second click is silently dropped by seenKeys forever.
        this.seenKeys.delete(k);
      }
      if (!this.inFlight.has(k)) return;
      this.inFlight.delete(k);
      // done → keep seenKeys so finished pages never requeue.
      if (this.lastTranslateFn) this.drain(this.lastTranslateFn);
    };
    document.addEventListener("lmt:translation-status", this.statusListener);
  }

  destroy() {
    if (this.statusListener) {
      document.removeEventListener(
        "lmt:translation-status",
        this.statusListener,
      );
      this.statusListener = null;
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

  evict(img: MangaTargetElement) {
    const src = getElementSrc(img);
    if (!src) return;
    const k = Registry.srcKeyOf(src);
    this.seenKeys.delete(k);
    if (this.inFlight.delete(k) && this.lastTranslateFn) {
      this.drain(this.lastTranslateFn);
    }
  }

  enqueue(
    img: MangaTargetElement,
    translateFn: (img: MangaTargetElement) => Promise<void>,
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
    this.queue.push({ img, fn: translateFn });
    this.lastTranslateFn = translateFn;
    this.drain(translateFn);
  }

  private drain(translateFn: (img: MangaTargetElement) => Promise<void>) {
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

      this.inFlight.add(k);
      // Fire-and-forget: translateFn sets up its own overlay and async
      // flow. Failure or done signals through the registry event above.
      translateFn(targetImg)
        .then(() => {
          if (!Registry.isPending(k) && Registry.getStatus(k) !== "done") {
            this.inFlight.delete(k);
            this.seenKeys.delete(k);
            Registry.markIdle(src);
            if (this.lastTranslateFn) this.drain(this.lastTranslateFn);
          }
        })
        .catch((err) => {
          console.warn("LMT: auto-translate task failed:", err);
          this.inFlight.delete(k);
          this.seenKeys.delete(k);
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

  async init(translateFn: (img: MangaTargetElement) => Promise<void>) {
    this.translateFn = translateFn;

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
    if (this.translateFn) {
      this.queue.enqueue(img, this.translateFn);
    }
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
