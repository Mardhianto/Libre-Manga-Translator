<script lang="ts">
  import { DefaultConfig, resolveLangGroup } from "@/lib/configs";
  import { env } from "@/lib/env";
  import { probeArtifactsCached } from "@/lib/utils";
  import { getSiteRule } from "@/lib/adapters";
  import { resolveFontStack } from "@/lib/canvas";
  import * as Registry from "@/entrypoints/content/translation-registry";
  import {
    OverlayToolbar,
    EditorToolbar,
    InpaintCanvasEditor,
    BubbleEditor,
    Toasts,
  } from "@/lib/components/overlay";
  import { showAlert, dismissAlert, pushNotice } from "@/lib/components/overlay/alerts";
  import type { OverlayToast, ToastKind } from "@/lib/components/overlay/toasts";
  import type { InpaintPatch } from "@/lib/components/overlay/InpaintCanvasEditor.svelte";
  import type { EditorLayer, InpaintTool } from "@/lib/components/overlay/EditorToolbar.svelte";

  interface Props {
    targetImageRect: DOMRect;
    scaleX: number;
    scaleY: number;
    originalSrc: string;
    rawImageUrl?: string;
    wrapper: HTMLElement;
    getTranslationCache: () => Promise<
      | {
          bboxes: Bbox[];
          translatedSrc: string;
          translations: Translations;
          sourceTexts?: string[];
          cleanedSrc?: string;
        }
      | undefined
    >;
    requestBubbleDetection: () => Promise<Bbox[] | { error: string }>;
    requestTextTranslation: (
      bboxes: Bbox[],
      isManuallySorted: boolean,
      opts?: {
        gateForce?: boolean;
        transient?: boolean;
        rawText?: string;
      },
    ) => Promise<
      | {
          translations: Translations;
          sourceTexts?: string[];
          context?: { summary: string; dictionary: string };
          diagnostics?: TranslationDiagnostics;
          gateSkip?: (GateReason | null)[];
          gate?: DebugEntry["gate"];
          /** Box indices the recognizer failed or half-read (Phase B). */
          ocrFailures?: number[];
        }
      | { error: string; transient?: boolean }
    >;
    renderTranslations: (
      translations: Translations,
      bboxes: Bbox[],
      cleanedBaseUrl?: string,
    ) => Promise<string>;
    exportCanvasToJpeg: (canvas: HTMLCanvasElement, quality?: number, filename?: string) => void;
    onClose: () => void;
    onBackToRefine?: () => void;
    getCleanedSrc?: (bboxes?: Bbox[]) => Promise<string>;
    applyInpaintPatches?: (
      baseCleanedSrc: string,
      addedPatches: Bbox[],
      removedPatches: Bbox[],
    ) => Promise<string>;
  }

  let {
    targetImageRect,
    scaleX,
    scaleY,
    originalSrc,
    rawImageUrl,
    wrapper,
    getTranslationCache,
    requestBubbleDetection,
    requestTextTranslation,
    renderTranslations,
    exportCanvasToJpeg,
    onClose,
    onBackToRefine,
    getCleanedSrc,
    applyInpaintPatches,
  }: Props = $props();

  const rawDisplaySrc = $derived(rawImageUrl || originalSrc);

  function getInitialToolbarPosition(): { x: number; y: number } {
    // Live image display rect (the wrapper is glued to the image), so a
    // reset after re-layout or scroll lands on the image, not its mount-time
    // snapshot.
    const liveRect = wrapper.getBoundingClientRect();
    const imageRect =
      liveRect.width > 0 && liveRect.height > 0 ? liveRect : targetImageRect;
    try {
      const saved = localStorage.getItem("lmt-toolbar-pos");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed?.x === "number" && typeof parsed?.y === "number") {
          return {
            x: Math.max(16, Math.min(window.innerWidth - 380, parsed.x)),
            y: Math.max(80, Math.min(window.innerHeight - 90, parsed.y)),
          };
        }
      }
    } catch {}

    // Default to Bottom-Left of the target manga/viewport
    const defaultX = Math.max(16, Math.min(window.innerWidth - 380, imageRect.left + 20));
    const defaultY = Math.min(
      window.innerHeight - 95,
      Math.max(80, imageRect.bottom - 95)
    );
    return { x: defaultX, y: defaultY };
  }

  /**
   * Clamp a dragged refining-toolbar position so it stays inside the image
   * display; when the toolbar cannot fit inside it at all, hold the default
   * position instead.
   */
  function clampToolbarInsideDisplay(next: { x: number; y: number }): { x: number; y: number } {
    const rect = toolbarDragStart?.rect;
    const display = wrapper.getBoundingClientRect();
    if (!rect || display.width <= 0 || display.height <= 0) return next;
    const pad = 8;
    const minX = display.left + pad;
    const maxX = display.right - pad - rect.width;
    const minY = display.top + pad;
    const maxY = display.bottom - pad - rect.height;
    if (maxX < minX || maxY < minY) return getInitialToolbarPosition();
    return {
      x: Math.max(minX, Math.min(maxX, next.x)),
      y: Math.max(minY, Math.min(maxY, next.y)),
    };
  }

  /**
   * Render-time fallback for the refining toolbar: if it rendered outside the
   * image display (stale saved position, re-layout, scroll), return it to the
   * default position and refresh the stored value.
   */
  function resetToolbarPosition() {
    const def = getInitialToolbarPosition();
    if (toolbarPosition.x === def.x && toolbarPosition.y === def.y) return;
    toolbarPosition = def;
    try {
      localStorage.setItem("lmt-toolbar-pos", JSON.stringify(def));
    } catch {}
  }

  let toolbarPosition = $state(getInitialToolbarPosition());
  let toolbarDragStart = $state<{
    startX: number;
    startY: number;
    initialX: number;
    initialY: number;
    rect: DOMRect | null;
  } | null>(null);
  let readingDirection = $state<"rtl" | "ltr">("rtl");
  let mode = $state<"loading" | "refining" | "results" | "editing">("loading");
  let activeEditorLayer = $state<EditorLayer>("inpainted");
  let activeInpaintTool = $state<InpaintTool>("none");
  let inpaintPatches = $state<InpaintPatch[]>([]);
  let cleanedUrl = $state("");
  let isApplyingInpaint = $state(false);
  let fontStack = $state("'Segoe UI', sans-serif");
  let bboxes = $state<Bbox[]>([]);
  let isManuallySorted = $state(false);
  let translatedUrl = $state("");
  let showOriginal = $state(false);
  let translations = $state<Translations>([]);
  let sourceTexts = $state<string[]>([]);
  /**
   * Boxes the recognizer failed or half-read on the last page run. They are
   * the boxes whose bubble shows nothing and, before this, could not be
   * retried without re-running the whole page.
   */
  let ocrFailures = $state<number[]>([]);
  /** True when translation settings changed while this overlay was open. */
  let isStale = $state(false);
  let editDrafts = $state<Translations>([]);
  let previousImageUrl = $state("");
  let activeIndex = $state<number | null>(null);
  let dragInfo = $state<{
    index: number;
    handle: string;
    startX: number;
    startY: number;
    initialBox: Bbox;
  } | null>(null);
  let history = $state<Bbox[][]>([]);
  let historyIndex = $state(-1);
  let loadingMsg = $state("Detecting text…");
  let errorMsg = $state("");
  let errorTimer: ReturnType<typeof setTimeout>;
  let alertId = $state<string | null>(null);
  /**
   * True while this page is being translated by the automatic queue. In that
   * mode the reader is scrolling past pages, so a blocking dialog per failure
   * is a wall of unclickable modals; failures become toasts instead
   * (LMT-034). A manual run still deserves a dialog the user must acknowledge.
   */
  let autoMode = $state(false);

  // A dismissed/closing overlay must not leave its dialog behind: the alert
  // host outlives this component, so its Retry/Dismiss callbacks would fire
  // against destroyed state (LMT-034).
  $effect(() => {
    return () => {
      if (alertId) dismissAlert(alertId);
    };
  });

  function generateBoxId(): string {
    return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  const MAX_RETRANSLATE_QUEUE = 5;
  let retranslatingBoxIds = $state<
    Record<string, { label: string; draftAtRequest: string; mode: "ocr" | "raw" }>
  >({});
  let toasts = $state<OverlayToast[]>([]);
  const toastTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function dismissToast(id: string) {
    const timer = toastTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      toastTimers.delete(id);
    }
    toasts = toasts.filter((t) => t.id !== id);
  }

  function addToast(message: string, kind: ToastKind = "info") {
    const existing = toasts.find((t) => t.message === message);
    const id = existing ? existing.id : generateBoxId();

    const duration =
      kind === "error"
        ? 6000
        : kind === "warn"
          ? 4500
          : 3500;

    const oldTimer = toastTimers.get(id);
    if (oldTimer) clearTimeout(oldTimer);

    const newTimer = setTimeout(() => dismissToast(id), duration);
    toastTimers.set(id, newTimer);

    if (existing) {
      toasts = toasts.map((t) => (t.id === id ? { ...t, kind } : t));
    } else {
      const updated = [...toasts, { id, kind, message }];
      if (updated.length > 4) {
        const dropped = updated.shift()!;
        const dt = toastTimers.get(dropped.id);
        if (dt) {
          clearTimeout(dt);
          toastTimers.delete(dropped.id);
        }
      }
      toasts = updated;
    }
  }

  function isRetranslatingBox(index: number): boolean {
    const id = bboxes[index]?.id;
    return !!(id && retranslatingBoxIds[id]);
  }

  async function handleRetranslateBox(index: number, skipOcr: boolean) {
    const box = bboxes[index];
    if (!box || !box.id) return;
    const boxId = box.id;

    if (retranslatingBoxIds[boxId]) {
      addToast(`Box #${index + 1} is already being retranslated.`, "warn");
      return;
    }

    if (Object.keys(retranslatingBoxIds).length >= MAX_RETRANSLATE_QUEUE) {
      addToast("Retranslation queue is full (5/5). Please wait for a free slot.", "warn");
      return;
    }

    const sourceText = sourceTexts[index] ?? "";
    if (skipOcr && !sourceText.trim()) {
      addToast(`Box #${index + 1} has no captured text to translate.`, "warn");
      return;
    }

    const draftAtRequest = editDrafts[index] ?? "";
    const label = `Box #${index + 1}`;
    const retransMode = skipOcr ? "raw" : "ocr";

    retranslatingBoxIds = {
      ...retranslatingBoxIds,
      [boxId]: { label, draftAtRequest, mode: retransMode },
    };

    try {
      const boxSnapshot = $state.snapshot(box);
      const result = await requestTextTranslation(
        [boxSnapshot],
        isManuallySorted,
        {
          gateForce: true,
          transient: true,
          rawText: skipOcr ? sourceText : undefined,
        },
      );

      if (mode !== "editing") {
        addToast(`${label} retranslated, but editor was closed.`, "info");
        return;
      }

      const targetIndex = bboxes.findIndex((b) => b.id === boxId);
      if (targetIndex === -1) {
        addToast(`${label} was deleted — retranslation discarded.`, "warn");
        return;
      }

      if (typeof result === "object" && "error" in result) {
        addToast(`Retranslation failed: ${result.error}`, "error");
        return;
      }

      if (result.diagnostics?.untranslated?.includes(0)) {
        addToast(
          `${label}: the model echoed the source instead of translating — not applied.`,
          "warn",
        );
        return;
      }

      const newText = result.translations?.[0];
      if (newText === undefined || newText === null) {
        addToast(`Nothing readable in ${label}.`, "warn");
        return;
      }

      if (editDrafts[targetIndex] !== draftAtRequest) {
        addToast(
          `${label} draft was modified — retranslation discarded to protect edits.`,
          "info",
        );
        return;
      }

      editDrafts = editDrafts.map((d, k) => (k === targetIndex ? newText : d));

      if (!skipOcr && result.sourceTexts?.[0]) {
        sourceTexts = sourceTexts.map((s, k) =>
          k === targetIndex ? result.sourceTexts![0] : s,
        );
      }

      // A successful OCR re-read clears the failure marker for this box.
      if (!skipOcr) {
        ocrFailures = ocrFailures.filter((k) => k !== targetIndex);
      }

      const successMsg = skipOcr
        ? `Box #${targetIndex + 1} retranslated from captured text. Press Apply to save.`
        : `Box #${targetIndex + 1} retranslated (OCR re-read). Press Apply to save.`;
      addToast(successMsg, "success");
    } catch (err) {
      addToast(`Retranslation error: ${(err as Error).message}`, "error");
    } finally {
      const next = { ...retranslatingBoxIds };
      delete next[boxId];
      retranslatingBoxIds = next;
    }
  }


  // Live geometry: mount props go stale when readers re-layout on page
  // change (the translated copy then renders smaller/offset). The content
  // script keeps the wrapper glued to the live image and pushes fresh
  // values via `lmt:geometry-change` on the wrapper.
  // svelte-ignore state_referenced_locally: initial snapshot is intended.
  let liveScaleX = $state(scaleX);
  // svelte-ignore state_referenced_locally: initial snapshot is intended.
  let liveScaleY = $state(scaleY);
  // svelte-ignore state_referenced_locally: initial snapshot is intended.
  let liveRect = $state({ width: targetImageRect.width, height: targetImageRect.height });

  // Set true to restore the legacy 5s auto-dismiss of error dialogs.
  const ERROR_AUTOCLOSE = false;

  // Load reading direction from localStorage on mount
  $effect(() => {
    const stored = localStorage.getItem("lmt-reading-direction");
    if (stored === "rtl" || stored === "ltr") readingDirection = stored;
  });

  // Persist reading direction to localStorage on change
  $effect(() => {
    localStorage.setItem("lmt-reading-direction", readingDirection);
  });

  /**
   * Report a failure to the user.
   *
   * Manual runs get the document-level dialog: the user asked for this page and
   * is looking at it, so the error must stay until acknowledged. Automatic runs
   * get a toast, because the reader is scrolling and a modal per failed page is
   * unclickable noise; the queue caps the retries and pauses after a streak
   * (LMT-034).
   *
   * `onRetry` is only wired when the failure is genuinely transient
   * (429/5xx/network); a bad API key must not offer a button that cannot work.
   */
  function showError(
    msg: string,
    opts?: {
      transient?: boolean;
      onRetry?: () => void;
      /**
       * `false` for a non-failure advisory ("no text bubbles here"): it must
       * not spend the auto queue's retry budget or count towards pausing.
       */
      report?: boolean;
    },
  ) {
    clearTimeout(errorTimer);
    errorMsg = msg;

    // Tell the queue a page failed, whether or not a dialog is shown, so the
    // retry budget is spent and a provider outage pauses the run.
    if (opts?.report !== false) {
      document.dispatchEvent(
        new CustomEvent("lmt:translation-failure", {
          detail: { src: originalSrc, message: msg },
        }),
      );
    }

    if (autoMode) {
      // A toast, not a dialog: the queue's attempt budget and the pause rule
      // are the real safety net here, and they live in auto-translate.ts.
      // Close the overlay too — an auto run the user did not start must not
      // leave a spinner or an empty editor pinned over the page.
      errorMsg = "";
      pushNotice(msg, opts?.transient ? "warn" : "error", 7000);
      // Deferred: the caller is still unwinding its own error path.
      setTimeout(() => onClose(), 0);
      return;
    }

    alertId = `alert-${crypto.randomUUID?.() ?? Date.now()}`;
    showAlert({
      id: alertId,
      message: msg,
      kind: "error",
      transient: opts?.transient ?? false,
      onRetry: opts?.onRetry,
      onDismiss: handleErrorDismiss,
    });
    if (ERROR_AUTOCLOSE) {
      errorTimer = setTimeout(() => {
        dismissAlert(alertId ?? undefined);
        errorMsg = "";
      }, 5000);
    }
  }

  function clearError() {
    clearTimeout(errorTimer);
    if (alertId) dismissAlert(alertId);
    alertId = null;
    errorMsg = "";
  }

  async function handleErrorDismiss() {
    clearError();
    const skip =
      await storage.getItem<boolean>("sync:skip-bbox-refining");
    if (skip ?? false) {
      onClose();
      return;
    }
    // Detection failed before any boxes existed (mode still "loading"):
    // drop to refining so the user can draw boxes manually.
    mode = "refining";
    Registry.markIdle(originalSrc);
  }

  /** Run a failed translate again from the alert's Retry button. */
  function retryTranslation() {
    clearError();
    if (!bboxes.length) {
      mode = "refining";
      Registry.markIdle(originalSrc);
      return;
    }
    void executeTranslation();
  }

function applyBboxesSort(direction: "rtl" | "ltr" = "rtl") {
    if (bboxes.length === 0) return;

    let totalHeight = 0;
    bboxes.forEach((box) => {
      totalHeight += box.y2 - box.y1;
    });
    const avgHeight = totalHeight / bboxes.length;

    const originalBboxes = bboxes.slice();

    // Calculate Center coordinates and sort strictly top-to-bottom to prepare for grouping
    const boxesWithCenters = bboxes.map(box => ({
      box,
      centerY: (box.y1 + box.y2) / 2,
      centerX: (box.x1 + box.x2) / 2
    })).sort((a, b) => a.centerY - b.centerY);

    // Agglomerative Clustering: Group into distinct Horizontal Bands (Panels)
    const bands: typeof boxesWithCenters[] = [];
    let currentBand = [boxesWithCenters[0]];
    let currentBandAvgY = boxesWithCenters[0].centerY;

    // 80% of average bubble height is a highly reliable threshold to detect panel gutters
    const yTolerance = avgHeight * 0.8;

    for (let i = 1; i < boxesWithCenters.length; i++) {
      const item = boxesWithCenters[i];
      if (item.centerY - currentBandAvgY < yTolerance) {
        currentBand.push(item);
        currentBandAvgY = currentBand.reduce((sum, curr) => sum + curr.centerY, 0) / currentBand.length;
      } else {
        bands.push(currentBand);
        currentBand = [item];
        currentBandAvgY = item.centerY;
      }
    }
    bands.push(currentBand);

    // Sort inside each panel using reading flow:
    // RTL (Manga): Top-Right to Bottom-Left
    // LTR (Western/Manhwa): Top-Left to Bottom-Right
    const result: typeof bboxes = [];
    const weightY = 2.0;

    bands.forEach((band) => {
      band.sort((a, b) => {
        if (direction === "ltr") {
          const scoreA = -a.centerX - (a.centerY * weightY);
          const scoreB = -b.centerX - (b.centerY * weightY);
          return scoreB - scoreA;
        } else {
          const scoreA = a.centerX - (a.centerY * weightY);
          const scoreB = b.centerX - (b.centerY * weightY);
          return scoreB - scoreA;
        }
      });

      result.push(...band.map(item => item.box));
    });

    bboxes = result;

    // Verify if order actually changed to prevent unnecessary history states
    const isChanged = !originalBboxes.every(
      (box, i) => box.x1 === bboxes[i].x1 && box.y1 === bboxes[i].y1
    );

    if (isChanged) saveHistory();
    activeIndex = null;
  }

  function saveHistory() {
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push($state.snapshot(bboxes));
    history = newHistory;
    historyIndex = history.length - 1;
  }

  function undo() {
    if (historyIndex > 0) {
      historyIndex--;
      bboxes = $state.snapshot(history[historyIndex]);
      activeIndex = null;
    }
  }

  function redo() {
    if (historyIndex < history.length - 1) {
      historyIndex++;
      bboxes = $state.snapshot(history[historyIndex]);
      activeIndex = null;
    }
  }

  async function executeTranslation() {
    isStale = false;
    mode = "loading";
    applyBboxesSort();

    // If the expected rec pack isn't cached, say so: otherwise a first-run
    // model download looks like a hang. (Auto-Detect pre-checks latin; the
    // gate may still resolve another script mid-translate — that pack's
    // identity lands in the debug entry via gate.group.)
    try {
      const [srcLang, engine] = await Promise.all([
        storage.getItem<string>("sync:source-lang"),
        storage.getItem<string>("sync:ocr-engine"),
      ]);
      const engineId = engine ?? DefaultConfig.ocrEngine;
      if (engineId !== "gemini" && typeof caches !== "undefined") {
        let langGroup = "";
        let missing = false;
        // Routed through background: Overlay runs in page content context
        // whose CacheStorage partition is invisible to the extension
        // partition where the wizard/popup download.
        if (engineId === "paddle") {
          const { group } = resolveLangGroup(
            srcLang ?? DefaultConfig.sourceLang,
          );
          const [recCached, dictCached] = await probeArtifactsCached([
            { repo: DefaultConfig.ocrRepo, path: DefaultConfig.ocrModelPath(group) },
            { repo: DefaultConfig.ocrRepo, path: DefaultConfig.ocrDictPath(group) },
          ]);
          langGroup = group;
          missing = !recCached || !dictCached;
        } else if (engineId === "ppocrv6-manga") {
          const [cached] = await probeArtifactsCached([
            { repo: env.ppocrv6MangaRepo, path: "ppocr-rec-v6-small-manga.onnx" },
          ]);
          missing = !cached;
        } else if (engineId === "manga-ocr") {
          const [encCached, decCached] = await probeArtifactsCached([
            { repo: DefaultConfig.mangaOcrRepo, path: "encoder_model.onnx" },
            { repo: DefaultConfig.mangaOcrRepo, path: "decoder_model.onnx" },
          ]);
          missing = !encCached || !decCached;
        } else if (engineId === "pororo") {
          const [recCached] = await probeArtifactsCached([
            { repo: env.pororoModelRepo, path: "brainocr.onnx" },
          ]);
          missing = !recCached;
        }
        if (missing) {
          loadingMsg =
            engineId === "pororo"
              ? "Downloading Pororo OCR…"
              : langGroup === ""
                ? "Downloading model…"
                : `Downloading ${langGroup}…`;
        }
      }
    } catch {
      // Cache probe failed — keep the generic message.
    }

    loadingMsg = "Translating text…";

    const result = await requestTextTranslation(
      $state.snapshot(bboxes),
      isManuallySorted,
    );
    if (typeof result === "object" && "error" in result) {
      mode = "refining";
      // A provider hiccup deserves a Retry button; a wrong key or a bad model
      // name does not (LMT-034).
      const transient = result.transient === true;
      showError(result.error, {
        transient,
        onRetry: transient ? retryTranslation : undefined,
      });
      Registry.markIdle(originalSrc);
      return;
    }

    translations = result.translations ?? [];
    sourceTexts = result.sourceTexts ?? [];
    ocrFailures = result.ocrFailures ?? [];

    const echoed = result.diagnostics?.untranslated?.length ?? 0;
    if (echoed > 0) {
      addToast(
        `${echoed} box${echoed === 1 ? "" : "es"} echoed the source and ${
          echoed === 1 ? "was" : "were"
        } left untranslated.`,
        "warn",
      );
    }

    if (ocrFailures.length > 0) {
      addToast(
        `${ocrFailures.length} bubble${ocrFailures.length === 1 ? "" : "s"} could not be read ` +
          `(OCR). Use "Retry OCR" on the marked bubble${ocrFailures.length === 1 ? "" : "s"}.`,
        "warn",
      );
    }

    // The script gate records which regions it held back; those boxes get a
    // dashed mark and a per-box override, their originals stay untouched.
    bboxes.forEach((b, i) => {
      b.gateSkip = result.gateSkip?.[i] ?? undefined;
    });

    mode = "loading";
    loadingMsg = "Rendering…";
    try {
      translatedUrl = await renderTranslations(
        $state.snapshot(translations),
        $state.snapshot(bboxes),
      );
    } catch (err) {
      mode = "refining";
      showError((err as Error).message);
      Registry.markIdle(originalSrc);
      return;
    }
    mode = "results";
    Registry.markDone(originalSrc);
  }

  async function handleConfirm() {
    if (mode !== "refining") return;
    return executeTranslation();
  }

  let snapshotCleanedUrl = "";
  async function openEditPanel() {
    if (mode !== "results") return;
    editDrafts = translations.slice();
    try {
      fontStack = await resolveFontStack();
    } catch {
      // keep fallback
    }
    if (!cleanedUrl && getCleanedSrc) {
      try {
        cleanedUrl = await getCleanedSrc(bboxes);
      } catch (err) {
        console.warn("LMT: Could not fetch cleaned background image", err);
      }
    }
    snapshotCleanedUrl = cleanedUrl;
    activeEditorLayer = "inpainted";
    activeInpaintTool = "none";
    inpaintPatches = [];
    mode = "editing";
    if (bboxes.length > 0 && activeIndex === null) {
      activeIndex = 0;
    }
  }

  async function applyPendingInpaintPatches(): Promise<string | undefined> {
    if (inpaintPatches.length === 0 || !applyInpaintPatches) return cleanedUrl;
    isApplyingInpaint = true;
    const added = inpaintPatches
      .filter((p) => p.type === "add-inpaint")
      .map((p) => ({ x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2, confidence: 1 }));
    const removed = inpaintPatches
      .filter((p) => p.type === "restore-raw")
      .map((p) => ({ x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2, confidence: 1 }));
    try {
      cleanedUrl = await applyInpaintPatches(cleanedUrl || rawDisplaySrc, added, removed);
      inpaintPatches = [];
      return cleanedUrl;
    } catch (err) {
      // A manual edit failure is not a page-translation failure: reporting it
      // would spend the auto queue's retry budget for this page (LMT-034).
      showError("Failed to apply inpaint patches: " + (err as Error).message, {
        report: false,
      });
      return undefined;
    } finally {
      isApplyingInpaint = false;
    }
  }

  async function applyEditorChanges() {
    // 1. If inpaint patches exist, apply them to the cleaned canvas
    if (inpaintPatches.length > 0) {
      await applyPendingInpaintPatches();
    }

    // 2. Commit text edits & repaint
    translations = editDrafts.slice();
    mode = "loading";
    loadingMsg = "Rendering…";
    try {
      translatedUrl = await renderTranslations(
        $state.snapshot(translations),
        $state.snapshot(bboxes),
        cleanedUrl || undefined,
      );
      snapshotCleanedUrl = cleanedUrl;
      mode = "results";
    } catch (err) {
      mode = "editing";
      // A render failure in the editor is a local canvas problem, not a page
      // translation attempt: do not charge it to the auto queue (LMT-034).
      showError((err as Error).message, { report: false });
    }
  }

  function cancelEditorChanges() {
    editDrafts = translations.slice();
    inpaintPatches = [];
    activeInpaintTool = "none";
    cleanedUrl = snapshotCleanedUrl;
    mode = "results";
  }

  // Gate override escape hatch: the gate is only allowed to be strict because
  // every false positive can be undone with one click (leaving text is
  // recoverable, painting over it is not, so the override runs the same region
  // with the gate bypassed).
  let forcingIndex = $state<number | null>(null);
  async function forceTranslateBox(i: number) {
    if (mode !== "results" || forcingIndex !== null) return;
    forcingIndex = i;
    const box = $state.snapshot(bboxes[i]);
    const result = await requestTextTranslation([box], true, {
      gateForce: true,
      transient: true,
    });
    forcingIndex = null;
    if (typeof result === "object" && "error" in result) {
      // `transient: true` here means "don't log this attempt": the per-box
      // retry shares the page's failure surface, not the debug log.
      showError(result.error, { report: false });
      return;
    }
    const text = result.translations?.[0];
    if (!text) {
      showError("Nothing readable in that box", { report: false });
      return;
    }
    bboxes[i].gateSkip = undefined;
    translations = translations.map((t, k) => (k === i ? text : t));
    if (result.sourceTexts?.[0]) {
      sourceTexts = sourceTexts.map((s, k) =>
        k === i ? result.sourceTexts![0] : s,
      );
    }
    try {
      translatedUrl = await renderTranslations(
        $state.snapshot(translations),
        $state.snapshot(bboxes),
        cleanedUrl || undefined,
      );
    } catch (err) {
      showError((err as Error).message, { report: false });
    }
  }

  async function saveJpg() {
    let targetUrl = translatedUrl;
    let layerType = "result";
    if (mode === "editing") {
      if (activeEditorLayer === "raw") {
        targetUrl = rawDisplaySrc;
        layerType = "raw";
      } else if (activeEditorLayer === "cleaned") {
        targetUrl = cleanedUrl || rawDisplaySrc;
        layerType = "cleaned";
      } else {
        targetUrl = translatedUrl;
        layerType = "result";
      }
    } else if (showOriginal) {
      targetUrl = rawDisplaySrc;
      layerType = "raw";
    }

    let siteSlug = "manga";
    try {
      const rule = await getSiteRule();
      if (rule?.ruleId && rule.ruleId !== "generic") {
        siteSlug = rule.ruleId;
      } else {
        siteSlug = window.location.hostname.replace(/^www\./, "").split(".")[0] || "manga";
      }
    } catch {
      siteSlug = "manga";
    }

    const filename = `lmt-${siteSlug}-${layerType}-${Date.now()}.jpg`;

    const imageEl = new window.Image();
    imageEl.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = imageEl.naturalWidth;
      canvas.height = imageEl.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(imageEl, 0, 0);
      exportCanvasToJpeg(canvas, 0.85, filename);
    };
    imageEl.src = targetUrl;
  }

  function handleBackToRefine() {
    if (mode === "results") {
      previousImageUrl = translatedUrl;
      isManuallySorted = false;
      onBackToRefine?.();
      mode = "refining";
      Registry.markIdle(originalSrc);
    }
  }

  function deleteActiveBox() {
    if (activeIndex !== null) {
      bboxes = bboxes.filter((_, i) => i !== activeIndex);
      translations = translations.filter((_, i) => i !== activeIndex);
      editDrafts = editDrafts.filter((_, i) => i !== activeIndex);
      sourceTexts = sourceTexts.filter((_, i) => i !== activeIndex);
      isManuallySorted = true;
      saveHistory();
      activeIndex = null;
    }
  }

  function clearAllBoxes() {
    if (bboxes.length === 0) return;
    bboxes = [];
    isManuallySorted = true;
    saveHistory();
    activeIndex = null;
  }

  function addBox() {
    const natW = liveRect.width / (liveScaleX || 1);
    const natH = liveRect.height / (liveScaleY || 1);
    const boxW = Math.min(200, natW * 0.4);
    const boxH = Math.min(200, natH * 0.2);
    const startX = (natW - boxW) / 2;
    const startY = (natH - boxH) / 2;

    bboxes = [
      ...bboxes,
      {
        id: generateBoxId(),
        x1: startX,
        y1: startY,
        x2: startX + boxW,
        y2: startY + boxH,
        confidence: 1,
      },
    ];
    translations = [...translations, ""];
    editDrafts = [...editDrafts, ""];
    sourceTexts = [...sourceTexts, ""];
    isManuallySorted = true;
    saveHistory();
    activeIndex = bboxes.length - 1;
  }

  function handleDragStart(index: number, handle: string) {
    return (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();

      dragInfo = {
        index,
        handle,
        startX: e.clientX,
        startY: e.clientY,
        initialBox: { ...bboxes[index] },
      };
    };
  }

  // Prevent any mouse/pointer/drag interaction inside the overlay from
  // bubbling to the host page. Manga readers bind these on the image/wrapper
  // (click-next-page, drag-to-scroll), so without this trap every click or
  // drag on the overlay flips the page or scrolls the reader.
  // Only stopPropagation: preventDefault would suppress the compatibility
  // mousedown that handleDragStart relies on, and would block focus on the
  // edit-panel textareas.
  function isolateHostEvents(e: Event) {
    e.stopPropagation();
  }

  // Keyboard events: stop all keyboard propagation so web manga readers
  // (e.g. MangaFire, Comix) do not intercept typing or overlay shortcuts
  // (such as 'h' for help dialog, 'a'/'d' for chapter flips, 'w'/'s' for scroll).
  function isolateHostKeyboard(e: KeyboardEvent) {
    e.stopPropagation();
  }

  function shouldPreventHostClick(_e: MouseEvent): boolean {
    // Always prevent host link activation / page flips for anything inside
    // the overlay. The overlay contains no native <a href> links, and
    // preventDefault() on click does NOT block textarea focus or text
    // selection (those depend on mousedown/pointerdown defaults, which we
    // deliberately leave intact in isolateHostEvents). Exempting inputs here
    // used to let textarea clicks navigate host <a> wrappers in editing mode.
    void _e;
    return true;
  }

  // Click needs preventDefault too: some readers wrap the img
  // in a native <a href="next-page">, and our overlay mounts inside that
  // anchor. stopPropagation alone does NOT cancel native link navigation -
  // only preventDefault() does. Box drag, textarea focus, and our own button
  // onclick all fire on mousedown/target phase, so preventing click's default
  // action inside the overlay is safe and doesn't interfere with them.
  function isolateHostClick(e: MouseEvent) {
    e.stopPropagation();
    if (shouldPreventHostClick(e)) {
      e.preventDefault();
    }
  }

  onMount(async () => {
    // Read the mode before detection: a failure during detection must already
    // know whether a blocking dialog is appropriate (LMT-034).
    const [skipRefining, autoTranslate, currentMode] = await Promise.all([
      storage.getItem<boolean>("sync:skip-bbox-refining"),
      storage.getItem<boolean>("sync:auto-translate"),
      storage.getItem<string>("sync:current-mode"),
    ]);
    autoMode = autoTranslate ?? false;

    const initialCache = await getTranslationCache();

    const rawBboxes = initialCache
      ? initialCache.bboxes
      : await requestBubbleDetection();

    if (!Array.isArray(rawBboxes)) {
      showError(rawBboxes?.error);
      Registry.markIdle(originalSrc);
      // Legacy autoclose preserved behind flag (see ERROR_AUTOCLOSE above).
      if (ERROR_AUTOCLOSE) {
        setTimeout(() => onClose(), 5000); // closes after error fades
      }
      return;
    }

    if (rawBboxes.length === 0) {
      // Not a provider failure: an empty page is a normal outcome, so it must
      // not spend the auto queue's retry budget.
      showError("No text bubbles detected - add boxes manually", {
        report: false,
      });
    }

    // Filter out invalid/phantom boxes (NaN coords, zero or negative area)
    // so user is never stuck with unclickable invisible boxes.
    // NOTE: Auto-padding (+10px) was removed as detection region-build (+7/+8px)
    // and inpaint/ocr pipelines already add sufficient internal margins.
    // If you need to restore padding per-box, use:
    //   x1: Math.max(0, box.x1 - 4), y1: Math.max(0, box.y1 - 4),
    //   x2: box.x2 + 4, y2: box.y2 + 4
    // Adjust the constant as needed; original was +10px.
    bboxes = rawBboxes
      .filter(
        (b) =>
          Number.isFinite(b.x1) &&
          Number.isFinite(b.y1) &&
          Number.isFinite(b.x2) &&
          Number.isFinite(b.y2) &&
          b.x2 > b.x1 &&
          b.y2 > b.y1,
      )
      .map((b) => ({ ...b, id: b.id ?? generateBoxId() }));

    applyBboxesSort();
    if (initialCache) {
      mode = "results";
      translatedUrl = initialCache.translatedSrc ?? "";
      translations = initialCache.translations ?? [];
      sourceTexts = initialCache.sourceTexts ?? [];
      cleanedUrl = initialCache.cleanedSrc ?? "";
      Registry.markDone(originalSrc);
    } else {
      // Gemini transcribes and translates the whole page itself, answering one
      // item per numbered box, so manual box review adds a click without changing
      // what is uploaded. Zero boxes still opens the editor — there is nothing to
      // number, and an unnumbered page gives the model no region to answer for.
      const skipStage = skipRefining || autoTranslate || currentMode === "gemini";
      if (skipStage && bboxes.length > 0) {
        await executeTranslation();
      } else {
        mode = "refining";
        Registry.markIdle(originalSrc);
      }
    }
  });

  const handleKeyDown = (e: KeyboardEvent) => {
    // Check if the target is inside this overlay / wrapper
    const path = (e.composedPath?.() || []) as HTMLElement[];
    const isInsideOverlay = path.some(
      (el) => el.id === "lmt-overlay" || el === wrapper,
    );
    // If user is typing in sidebar, popup, or another element on the page, don't hijack keys!
    if (!isInsideOverlay) return;

    // Use composedPath() to inspect the actual target across Shadow DOM boundaries
    const target = (path[0] || e.target) as HTMLElement | null;
    const isEditing =
      target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT");

    if (isEditing) {
      // If user hits Escape while typing, cancel the editing mode
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        if (mode === "editing") cancelEditorChanges();
        return;
      }
      // If user hits Ctrl+Enter while typing, apply changes
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.stopPropagation();
        e.preventDefault();
        if (mode === "editing") applyEditorChanges();
        return;
      }
      // Never hijack or preventDefault typing inside edit panel textareas,
      // but always stop propagation so host reader shortcuts (e.g. 'h', 'a'/'d', 'w'/'s') never fire
      e.stopPropagation();
      return;
    }

    // Escape closes error modal first, then cancels editing, then deselects box, then closes overlay
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      if (errorMsg) {
        // The dialog is dismissible from its own host too; going through the
        // shared alert id keeps both surfaces in sync (LMT-034).
        if (alertId) dismissAlert(alertId);
        void handleErrorDismiss();
      } else if (mode === "editing") {
        cancelEditorChanges();
      } else if (activeIndex !== null) {
        activeIndex = null;
      } else {
        onClose();
      }
      return;
    }

    // Box editing shortcuts apply in refining and editing mode
    if (mode !== "refining" && mode !== "editing") {
      e.stopPropagation();
      return;
    }

    // Delete active box if user hits Delete or Backspace
    if (
      (e.key === "Delete" || e.key === "Backspace") &&
      activeIndex !== null
    ) {
      e.stopPropagation();
      e.preventDefault();
      deleteActiveBox();
      return;
    }

    // Undo if user click ctrl + z
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.stopPropagation();
      e.preventDefault();
      // redo if the shift key being push
      if (e.shiftKey) redo();
      else undo();
      return;
    }

    // Undo if user click ctrl + y
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      e.stopPropagation();
      e.preventDefault();
      redo();
      return;
    }

    // Stop any other keydown on the overlay from bubbling to the reader
    e.stopPropagation();
    e.preventDefault();
  };

  $effect(() => {
    const handleClick = (event: MouseEvent) => {
      const path = (event.composedPath?.() || []) as HTMLElement[];
      const isInsideOverlay = path.some(
        (el) => el.id === "lmt-overlay" || el === wrapper,
      );
      // NEVER intercept or cancel clicks outside this overlay
      if (!isInsideOverlay) return;

      const isBoxOrHandle = path.some(
        (el) =>
          el.classList?.contains("lmt-box") ||
          el.classList?.contains("handle") ||
          el.getAttribute?.("role") === "toolbar" ||
          el.tagName === "BUTTON" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "INPUT",
      );

      if (!isBoxOrHandle) {
        activeIndex = null;
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      // Stop these from bubbling to page-level drag listeners while a box
      // drag/resize is in flight (reader sites track mousemove to page-flip).
      e.stopPropagation();
      e.preventDefault();

      requestAnimationFrame(() => {
        // Toolbar drag — clamped to the image display bounds
        if (toolbarDragStart) {
          const dx = e.clientX - toolbarDragStart.startX;
          const dy = e.clientY - toolbarDragStart.startY;
          toolbarPosition = clampToolbarInsideDisplay({
            x: toolbarDragStart.initialX + dx,
            y: toolbarDragStart.initialY + dy,
          });
          return;
        }

        if (!dragInfo) return;
        const { index, handle, startX, startY, initialBox } = dragInfo;

        // Calculate how much the mouse has moved in "natural" pixels
        const dx = (e.clientX - startX) / liveScaleX;
        const dy = (e.clientY - startY) / liveScaleY;

        // Handle Moving the whole box
        if (handle === "move") {
          const w = initialBox.x2 - initialBox.x1;
          const h = initialBox.y2 - initialBox.y1;
          bboxes[index].x1 = initialBox.x1 + dx;
          bboxes[index].y1 = initialBox.y1 + dy;
          bboxes[index].x2 = bboxes[index].x1 + w;
          bboxes[index].y2 = bboxes[index].y1 + h;
        } else {
          // Handle Resizing
          if (handle.includes("t")) bboxes[index].y1 = initialBox.y1 + dy;
          if (handle.includes("b")) bboxes[index].y2 = initialBox.y2 + dy;
          if (handle.includes("l")) bboxes[index].x1 = initialBox.x1 + dx;
          if (handle.includes("r")) bboxes[index].x2 = initialBox.x2 + dx;
        }
      });
    };

    const handleMouseUp = (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();

      if (dragInfo) {
        const box = bboxes[dragInfo.index];
        const initialBox = dragInfo.initialBox;

        // Normalize coordinates so x1/y1 is always the top-left
        if (box.x1 > box.x2) [box.x1, box.x2] = [box.x2, box.x1];
        if (box.y1 > box.y2) [box.y1, box.y2] = [box.y2, box.y1];

        // Calculate how far the box actually changed to ignore accidental micro-drags
        const dx1 = Math.abs(box.x1 - initialBox.x1);
        const dy1 = Math.abs(box.y1 - initialBox.y1);
        const dx2 = Math.abs(box.x2 - initialBox.x2);
        const dy2 = Math.abs(box.y2 - initialBox.y2);
        const moveThreshold = 2;

        if (
          dx1 > moveThreshold ||
          dy1 > moveThreshold ||
          dx2 > moveThreshold ||
          dy2 > moveThreshold
        ) {
          isManuallySorted = true;
          saveHistory();
        }
      }
      if (toolbarDragStart) {
        try {
          localStorage.setItem("lmt-toolbar-pos", JSON.stringify(toolbarPosition));
        } catch {}
      }
      dragInfo = null;
      toolbarDragStart = null;
    };

    if (dragInfo || toolbarDragStart) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    }
    if (mode === "refining" || mode === "editing")
      window.addEventListener("click", handleClick);
    window.addEventListener("keydown", handleKeyDown);
    const handleOpenEdit = () => {
      if (mode === "results") openEditPanel();
    };
    const handleToggleOriginal = () => {
      if (mode === "results") showOriginal = !showOriginal;
    };
    const handleExport = () => {
      if (mode === "results" || mode === "editing") saveJpg();
    };
    const handleGeometryChange = (e: Event) => {
      const d = (
        e as CustomEvent<{
          scaleX?: number;
          scaleY?: number;
          width?: number;
          height?: number;
        }>
      ).detail;
      if (!d) return;
      if (Number.isFinite(d.scaleX) && (d.scaleX as number) > 0) {
        liveScaleX = d.scaleX as number;
      }
      if (Number.isFinite(d.scaleY) && (d.scaleY as number) > 0) {
        liveScaleY = d.scaleY as number;
      }
      if (
        Number.isFinite(d.width) &&
        Number.isFinite(d.height) &&
        (d.width as number) > 0 &&
        (d.height as number) > 0
      ) {
        liveRect = { width: d.width as number, height: d.height as number };
      }
    };

    const handleSettingsChanged = () => {
      isStale = true;
      addToast(
        "Settings changed since translation was made. Use Re-translate to apply.",
        "info",
      );
    };

    wrapper.addEventListener("lmt:back-to-refine", handleBackToRefine);
    wrapper.addEventListener("lmt:open-edit", handleOpenEdit);
    wrapper.addEventListener("lmt:toggle-original", handleToggleOriginal);
    wrapper.addEventListener("lmt:export-jpeg", handleExport);
    wrapper.addEventListener("lmt:geometry-change", handleGeometryChange);
    wrapper.addEventListener("lmt:settings-changed", handleSettingsChanged);

    return () => {
      if (mode === "refining" || mode === "editing")
        window.removeEventListener("click", handleClick);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      wrapper.removeEventListener("lmt:back-to-refine", handleBackToRefine);
      wrapper.removeEventListener("lmt:open-edit", handleOpenEdit);
      wrapper.removeEventListener("lmt:toggle-original", handleToggleOriginal);
      wrapper.removeEventListener("lmt:export-jpeg", handleExport);
      wrapper.removeEventListener("lmt:geometry-change", handleGeometryChange);
      wrapper.removeEventListener("lmt:settings-changed", handleSettingsChanged);
    };
  });

  let isWrapperHovered = $state(false);

  $effect(() => {
    if (!wrapper) return;
    const onEnter = () => {
      isWrapperHovered = true;
    };
    const onLeave = () => {
      isWrapperHovered = false;
    };
    wrapper.addEventListener("mouseenter", onEnter);
    wrapper.addEventListener("mouseleave", onLeave);
    return () => {
      wrapper.removeEventListener("mouseenter", onEnter);
      wrapper.removeEventListener("mouseleave", onLeave);
    };
  });

  $effect(() => {
    if (wrapper) {
      wrapper.setAttribute("data-lmt-mode", mode);
      wrapper.setAttribute("data-lmt-progress", loadingMsg);
      // Only the wrapper we own gets a z-index (LMT-034). Writing it onto
      // `wrapper.parentElement` turned a page-owned layout node into a
      // stacking context: on MangaOne that reordered the spread and let a
      // neighbouring page's transparent tap layer cover this overlay's UI.
      // A parent z-index was also never restored, so one refining pass left
      // the page permanently restyled.
      const isInteractive = mode === "refining" || mode === "editing";
      wrapper.style.zIndex = isInteractive ? (isWrapperHovered ? "60" : "50") : "";
      wrapper.dispatchEvent(
        new CustomEvent("lmt:mode-change", { detail: { mode }, bubbles: true }),
      );
      wrapper.dispatchEvent(
        new CustomEvent("lmt:progress", { detail: { message: loadingMsg }, bubbles: true }),
      );
    }
  });

  const maskPath = $derived.by(() => {
    if (!bboxes.length || liveRect.width <= 0 || liveRect.height <= 0) return "none";

    const width = liveRect.width;
    const height = liveRect.height;

    // Start with a path that covers the entire image (clockwise)
    let pathString = `M 0 0 h ${width} v ${height} h -${width} z `;

    // Add each box as a sub-path (counter-clockwise or same direction with evenodd)
    const boxPaths = bboxes
      .map((box) => {
        const x = box.x1 * liveScaleX;
        const y = box.y1 * liveScaleY;
        const w = (box.x2 - box.x1) * liveScaleX;
        const h = (box.y2 - box.y1) * liveScaleY;
        return `M ${x} ${y} h ${w} v ${h} h -${w} z`;
      })
      .join(" ");

    return `path(evenodd, "${pathString} ${boxPaths}")`;
  });
</script>

<div
    id="lmt-overlay"
    role="presentation"
    tabindex="-1"
    class="absolute top-0 left-0 overflow-hidden {mode === 'loading' || mode === 'results' ? 'pointer-events-none' : 'pointer-events-auto'} group z-50 w-full h-full outline-none"
    onmousedown={isolateHostEvents}
    onpointerdown={isolateHostEvents}
    onpointerup={isolateHostEvents}
    ontouchstart={isolateHostEvents}
    ontouchend={isolateHostEvents}
    ontouchmove={isolateHostEvents}
    oncontextmenu={isolateHostEvents}
    ondblclick={isolateHostEvents}
    ondragstart={isolateHostEvents}
    onwheel={isolateHostEvents}
    onkeydown={handleKeyDown}
    onkeyup={isolateHostKeyboard}
    onkeypress={isolateHostKeyboard}
    onclickcapture={(e) => {
      if (mode !== "loading" && shouldPreventHostClick(e)) {
        e.preventDefault();
      }
    }}
    onclick={isolateHostClick}
  >
  {#if mode === "refining"}
    <OverlayToolbar
      mode="refining"
      hasBboxes={bboxes.length > 0}
      hasActiveBox={activeIndex !== null}
      canUndo={historyIndex > 0}
      canRedo={historyIndex < history.length - 1}
      position={toolbarPosition}
      isDragActive={dragInfo !== null}
      isDraggingToolbar={toolbarDragStart !== null}
      {readingDirection}
      onDragStart={(e) => {
        const root = (e.currentTarget as HTMLElement | null)?.closest(
          "[data-lmt-toolbar]",
        );
        toolbarDragStart = {
          startX: e.clientX,
          startY: e.clientY,
          initialX: toolbarPosition.x,
          initialY: toolbarPosition.y,
          rect: root instanceof HTMLElement ? root.getBoundingClientRect() : null,
        };
      }}
      onAddBox={addBox}
      onDeleteBox={deleteActiveBox}
      onClearAll={clearAllBoxes}
      onAutoSort={() => applyBboxesSort(readingDirection)}
      onToggleReadingDirection={() => (readingDirection = readingDirection === "rtl" ? "ltr" : "rtl")}
      onConfirm={handleConfirm}
      onUndo={undo}
      onRedo={redo}
      onResetPosition={resetToolbarPosition}
      onClose={() => {
        if (previousImageUrl) {
          translatedUrl = previousImageUrl;
          previousImageUrl = "";
          mode = "results";
        } else onClose();
      }}
    />

    <BubbleEditor
      {bboxes}
      scaleX={liveScaleX}
      scaleY={liveScaleY}
      {activeIndex}
      {maskPath}
      onSelectBox={(i) => (activeIndex = i)}
      onDragStart={handleDragStart}
    />
  {/if}

  {#if mode === "results"}
    <img
      src={showOriginal ? rawDisplaySrc : translatedUrl}
      alt={showOriginal ? "Original Img" : "Translated Img"}
      class="w-full h-full object-contain select-none pointer-events-none"
    />
    {#if !showOriginal}
      {#each bboxes as box, i}
        {#if box.gateSkip && !translations[i]}
          <div
            class="absolute border-2 border-dashed border-amber-500/90 rounded-sm pointer-events-none z-30"
            style:left="{box.x1 * liveScaleX}px"
            style:top="{box.y1 * liveScaleY}px"
            style:width="{(box.x2 - box.x1) * liveScaleX}px"
            style:height="{(box.y2 - box.y1) * liveScaleY}px"
          >
            <button
              type="button"
              onclick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                forceTranslateBox(i);
              }}
              onmousedown={(e) => e.stopPropagation()}
              onpointerdown={(e) => e.stopPropagation()}
              disabled={forcingIndex !== null}
              title={box.gateSkip === "not-japanese"
                ? "The language gate read this as a different script"
                : "The language gate could not read this confidently"}
              class="pointer-events-auto absolute bottom-1 left-1/2 -translate-x-1/2 bg-amber-500/95 hover:bg-amber-400 disabled:opacity-60 text-black text-xs font-semibold px-2 py-0.5 rounded shadow whitespace-nowrap cursor-pointer transition-colors"
            >
              {forcingIndex === i ? "Translating..." : "Translate anyway"}
            </button>
          </div>
        {/if}
        {#if ocrFailures.includes(i) && !translations[i]}
          <div
            class="absolute border-2 border-dashed border-rose-500/90 rounded-sm pointer-events-none z-30"
            style:left="{box.x1 * liveScaleX}px"
            style:top="{box.y1 * liveScaleY}px"
            style:width="{(box.x2 - box.x1) * liveScaleX}px"
            style:height="{(box.y2 - box.y1) * liveScaleY}px"
          >
            <button
              type="button"
              onclick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                void handleRetranslateBox(i, false);
              }}
              onmousedown={(e) => e.stopPropagation()}
              onpointerdown={(e) => e.stopPropagation()}
              disabled={isRetranslatingBox(i)}
              title="The OCR engine could not read this bubble. Retry re-runs recognition on the same box."
              class="pointer-events-auto absolute bottom-1 left-1/2 -translate-x-1/2 bg-rose-500/95 hover:bg-rose-400 disabled:opacity-60 text-white text-xs font-semibold px-2 py-0.5 rounded shadow whitespace-nowrap cursor-pointer transition-colors"
            >
              {isRetranslatingBox(i) ? "Retrying..." : "Retry OCR"}
            </button>
          </div>
        {/if}
        {#if box.inpaintDeclined && (!box.gateSkip || translations[i])}
          <div
            class="absolute border-2 border-dotted border-rose-500/80 rounded-sm pointer-events-none z-30"
            style:left="{box.x1 * liveScaleX}px"
            style:top="{box.y1 * liveScaleY}px"
            style:width="{(box.x2 - box.x1) * liveScaleX}px"
            style:height="{(box.y2 - box.y1) * liveScaleY}px"
            title="Inpainting declined: background could not be cleaned cleanly. Original paper retained."
          >
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
              role="presentation"
              class="pointer-events-auto absolute -top-4 right-0 bg-rose-500/90 text-white text-[9px] font-mono px-1 rounded shadow"
              title="Inpainting declined: all ladder rungs failed quality checks"
              onmousedown={(e) => e.stopPropagation()}
              onpointerdown={(e) => e.stopPropagation()}
              onclick={(e) => {
                e.stopPropagation();
                e.preventDefault();
              }}
            >
              Declined
            </div>
          </div>
        {/if}
      {/each}
    {/if}

    <OverlayToolbar
      mode="results"
      {showOriginal}
      {isStale}
      onRetranslate={executeTranslation}
      onRefine={handleBackToRefine}
      onEditTranslations={openEditPanel}
      onExportJpg={saveJpg}
      onToggleOriginal={() => (showOriginal = !showOriginal)}
      onClose={onClose}
    />
  {/if}

  {#if mode === "editing"}
    <!-- Layer image rendering based on activeEditorLayer -->
    <img
      src={activeEditorLayer === "raw" ? rawDisplaySrc : (cleanedUrl || translatedUrl)}
      alt="Manga Scan Layer"
      class="w-full h-full object-contain select-none pointer-events-none"
    />

    <!-- Cleaned Scan: Inpaint Patch Surface (Add/Remove inpaint areas) -->
    {#if activeEditorLayer === "cleaned"}
      <InpaintCanvasEditor
        activeTool={activeInpaintTool}
        scaleX={liveScaleX}
        scaleY={liveScaleY}
        patches={inpaintPatches}
        onAddPatch={(patch) => (inpaintPatches = [...inpaintPatches, patch])}
        onRemovePatch={(id) => (inpaintPatches = inpaintPatches.filter((p) => p.id !== id))}
      />
    {/if}

    <!-- Inpainted / Result Scan: Interactive Bbox Text Editor -->
    {#if activeEditorLayer === "inpainted"}
      <BubbleEditor
        mode="editing"
        {bboxes}
        translations={editDrafts}
        {sourceTexts}
        scaleX={liveScaleX}
        scaleY={liveScaleY}
        {activeIndex}
        {fontStack}
        onSelectBox={(i) => (activeIndex = i)}
        onDragStart={handleDragStart}
        onUpdateTranslation={(i, text) => {
          editDrafts[i] = text;
        }}
        onUpdateStyle={(i, style) => {
          bboxes[i] = { ...bboxes[i], style };
        }}
        {isRetranslatingBox}
        onRetranslateBox={handleRetranslateBox}
      />
    {/if}

    <!-- Floating Right Vertical Toolbar -->
    <EditorToolbar
      activeLayer={activeEditorLayer}
      activeInpaintTool={activeInpaintTool}
      hasActiveBox={activeIndex !== null}
      pendingPatchCount={inpaintPatches.length}
      isApplying={isApplyingInpaint}
      onSelectLayer={async (layer) => {
        if (activeEditorLayer === "cleaned" && layer !== "cleaned" && inpaintPatches.length > 0) {
          await applyPendingInpaintPatches();
        }
        activeEditorLayer = layer;
        if (layer !== "cleaned") activeInpaintTool = "none";
      }}
      onSelectInpaintTool={(tool) => (activeInpaintTool = tool)}
      onAddBox={addBox}
      onDeleteBox={deleteActiveBox}
      onDownload={saveJpg}
      onApply={applyEditorChanges}
      onCancel={cancelEditorChanges}
    />
  {/if}

  <Toasts {toasts} onDismiss={dismissToast} />
</div>

<style>
  button {
    appearance: none;
    outline: none;
  }
</style>
