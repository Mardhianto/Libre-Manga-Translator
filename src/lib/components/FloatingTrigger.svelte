<script lang="ts">
  import { onMount } from "svelte";
  import { Sparkles, LoaderCircle, GripVertical } from "lucide-svelte";
  import { isPending as isRegistryPending } from "@/entrypoints/content/translation-registry";
  import { getElementSrc, type MangaTargetElement } from "@/lib/canvas";
  import type { PillPosition } from "@/lib/adapters";

  let {
    onTranslate,
    getOverlayMode,
    getOverlayProgress,
    isSameSource,
    readerContainerSelector = null,
    pillPosition,
  }: {
    onTranslate?: (img: MangaTargetElement) => void;
    getOverlayMode?: (img: MangaTargetElement) => "idle" | "translating" | "translated";
    getOverlayProgress?: (img: MangaTargetElement) => string;
    isSameSource?: (img: MangaTargetElement, src: string) => boolean;
    // Site-rule reader container (when the active rule declares one) —
    // candidates inside it are treated as pages at a lower size bar.
    readerContainerSelector?: string | null;
    // Where to anchor the pill on each image (site-rule override)
    pillPosition?: PillPosition;
  } = $props();

  let x = $state(0);
  let y = $state(0);
  let visible = $state(false);
  let status = $state<"idle" | "translating" | "translated">("idle");
  let progressText = $state("Detecting text…");
  let targetImg = $state<MangaTargetElement | null>(null);
  // Pipeline-active image shown without hover (manual click optimistic or
  // auto-queue). Hover takes over while hovering; pointer-leave snaps back.
  let autoImg = $state<MangaTargetElement | null>(null);
  let hoverImg = $state<MangaTargetElement | null>(null);

  let dragOffset = $state<{ x: number; y: number } | null>(null);
  let isDraggingTrigger = $state(false);
  let triggerDragStart: { mouseX: number; mouseY: number; initialX: number; initialY: number } | null = null;

  try {
    const saved = localStorage.getItem("lmt-trigger-pos");
    if (saved) {
      const parsed = JSON.parse(saved);
      if (typeof parsed?.x === "number" && typeof parsed?.y === "number") {
        dragOffset = {
          x: Math.max(8, Math.min(window.innerWidth - 120, parsed.x)),
          y: Math.max(8, Math.min(window.innerHeight - 48, parsed.y)),
        };
      }
    }
  } catch {}

  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  function cancelHide() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }
  function isInViewport(el: Element) {
    const r = el.getBoundingClientRect();
    return (
      r.bottom > 4 &&
      r.top < window.innerHeight - 4 &&
      r.right > 4 &&
      r.left < window.innerWidth - 4
    );
  }

  function scheduleHide() {
    cancelHide();
    if (status === "translating") return;
    hideTimer = setTimeout(() => {
      // Keep a translating pill pinned only while its image is attached and
      // actually on screen; scrolling it away must not leave the pill
      // stranded over the rest of the reader UI.
      if (
        status === "translating" &&
        targetImg &&
        document.body.contains(targetImg) &&
        isInViewport(targetImg)
      ) {
        return;
      }
      visible = false;
      targetImg = null;
    }, 250);
  }

  function meetsThreshold(el: MangaTargetElement) {
    const renderedW = el.offsetWidth || el.clientWidth;
    const renderedH = el.offsetHeight || el.clientHeight;
    const naturalW = "naturalWidth" in el ? el.naturalWidth : el.width;
    const naturalH = "naturalHeight" in el ? el.naturalHeight : el.height;
    return (
      (renderedW >= 260 && renderedH >= 260) ||
      (naturalW >= 260 && naturalH >= 260)
    );
  }

  // Custom-element hosts owned by this extension. Hovers landing inside our
  // own UI must never re-map or schedule hides from the document listener.
  const OWN_UI_SELECTOR =
    "lmt-root, lmt-overlay, lmt-sidebar, lmt-floating-trigger";

  const INTERACTIVE_SELECTOR =
    "a[href], button, [role='button'], [role='link'], summary, nav, header";

  // Indirect hover mapping (descendant / beneath-cursor matching) must only
  // resolve to page-like targets. Navigation chrome — episode cards, banners,
  // thumbnails inside links — clears a raw pixel threshold easily via natural
  // size, so require real on-screen page mass, and reject anything contained
  // in interactive elements.
  function isPageLike(el: MangaTargetElement) {
    const w = el.offsetWidth || el.clientWidth;
    const h = el.offsetHeight || el.clientHeight;
    // Thumbnails and icons: never indirect-map to images narrower than 350px,
    // regardless of occupancy (covers 280-320px range often seen in nav cards).
    if (w < 350 || h < 280) return false;
    if (el.closest(INTERACTIVE_SELECTOR)) return false;
    if (readerContainerSelector) {
      try {
        if (el.closest(readerContainerSelector)) return w >= 180 && h >= 180;
      } catch {
        // invalid selector from a custom rule — fall through to geometry
      }
    }
    const vpArea = (window.innerWidth || 1) * (window.innerHeight || 1);
    return (w * h) / vpArea >= 0.12;
  }

  // For the descendant path: the matched image must fill most of the hovered
  // element. Cards place a thumbnail beside text; real tap-overlay wrappers
  // contain (almost) nothing but the page itself.
  function fillsWrapper(child: Element, hovered: HTMLElement) {
    const c = child.getBoundingClientRect();
    const p = hovered.getBoundingClientRect();
    if (p.width <= 0 || p.height <= 0) return true;
    return (c.width * c.height) / (p.width * p.height) >= 0.6;
  }

  function srcMatches(el: MangaTargetElement, src: string) {
    return isSameSource?.(el, src) ?? getElementSrc(el) === src;
  }

  function queryMode(img: MangaTargetElement) {
    return getOverlayMode?.(img) ?? "idle";
  }

  // Adopt the queried overlay mode, except never downgrade an optimistic
  // "translating" while the registry still holds the image pending — the
  // overlay mounts ~1s after click, and re-querying that gap used to flash
  // the pill back to Translate (then hide on pointer-out).
  function adoptMode(img: MangaTargetElement) {
    const q = queryMode(img);
    const src = getElementSrc(img);
    if (q === "translating") {
      status = q;
      progressText = getOverlayProgress?.(img) ?? "Translating…";
    } else if (status !== "translating" || !src || !isRegistryPending(src)) {
      status = q;
    }
    return q;
  }

  function handleDragStart(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    isDraggingTrigger = true;
    triggerDragStart = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      initialX: x,
      initialY: y,
    };

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!triggerDragStart) return;
      const dx = moveEvent.clientX - triggerDragStart.mouseX;
      const dy = moveEvent.clientY - triggerDragStart.mouseY;
      x = Math.max(8, Math.min(window.innerWidth - 140, triggerDragStart.initialX + dx));
      y = Math.max(8, Math.min(window.innerHeight - 48, triggerDragStart.initialY + dy));
      dragOffset = { x, y };
    };

    const handleMouseUp = () => {
      isDraggingTrigger = false;
      triggerDragStart = null;
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      if (dragOffset) {
        try {
          localStorage.setItem("lmt-trigger-pos", JSON.stringify(dragOffset));
        } catch {}
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }

  function showFor(img: MangaTargetElement, auto: boolean) {
    cancelHide();
    targetImg = img;
    if (auto) autoImg = img;
    // Clear manual drag offset when the pill switches to a different image
    // (hovering/auto-queue) — pill should snap to the new image's position.
    // Dragging the pill itself sets isDraggingTrigger=true, so this won't
    // interfere with active drags.
    if (!isDraggingTrigger) dragOffset = null;
    updatePosition();
    visible = true;
    if (adoptMode(img) === "translated") {
      if (auto) autoImg = null;
      scheduleHide();
    }
  }

  // Settle the pill after a terminal-ish signal for the current target.
  // Keeps optimistic "translating" while the registry claim is still pending.
  function settleTarget() {
    if (!targetImg) return;
    if (!document.body.contains(targetImg)) {
      targetImg = null;
      if (autoImg && !document.body.contains(autoImg)) autoImg = null;
      visible = false;
      return;
    }
    const wasAuto = autoImg === targetImg;
    adoptMode(targetImg);
    if (status === "idle" || status === "translated") {
      if (wasAuto) autoImg = null;
      scheduleHide();
    }
  }

  function findImgForSrc(src: string): MangaTargetElement | null {
    const imgs = document.querySelectorAll<MangaTargetElement>("img, canvas");
    for (const img of imgs) {
      if (
        (img instanceof HTMLImageElement || img instanceof HTMLCanvasElement) &&
        document.body.contains(img) &&
        meetsThreshold(img) &&
        srcMatches(img, src)
      ) {
        return img;
      }
    }
    return null;
  }

  function isActive(img: MangaTargetElement) {
    if (!document.body.contains(img)) return false;
    if (queryMode(img) === "translating") return true;
    try {
      const src = getElementSrc(img);
      return src ? isRegistryPending(src) : false;
    } catch {
      return false;
    }
  }

  function pinFromModeEvent(e: Event) {
    const target = e.target;
    if (!(target instanceof HTMLElement) || typeof target.querySelector !== "function") {
      return null;
    }
    const el = target.querySelector<MangaTargetElement>("img, canvas");
    if (
      !el ||
      !(el instanceof HTMLImageElement || el instanceof HTMLCanvasElement) ||
      !document.body.contains(el) ||
      !meetsThreshold(el)
    ) {
      return null;
    }
    return el;
  }

  function updatePosition() {
    if (visible && targetImg && document.body.contains(targetImg)) {
      if (dragOffset) {
        x = dragOffset.x;
        y = dragOffset.y;
        return;
      }
      const rect = targetImg.getBoundingClientRect();
      const buttonHeight = 36;
      const margin = 16;
      const pos = pillPosition ?? "top-left";

      switch (pos) {
        case "top-left":
          x = Math.max(16, rect.left + margin);
          y = Math.max(20, rect.top + margin);
          break;
        case "top":
          x = Math.max(16, rect.left + rect.width / 2 - 60);
          y = Math.max(20, rect.top + margin);
          break;
        case "top-right":
          x = Math.max(16, Math.min(window.innerWidth - 140, rect.right - 140));
          y = Math.max(20, rect.top + margin);
          break;
        case "left":
          x = Math.max(16, rect.left + margin);
          y = Math.max(20, rect.top + rect.height / 2 - buttonHeight / 2);
          break;
        case "right":
          x = Math.max(16, Math.min(window.innerWidth - 140, rect.right - 140));
          y = Math.max(20, rect.top + rect.height / 2 - buttonHeight / 2);
          break;
        case "bottom":
          x = Math.max(16, rect.left + rect.width / 2 - 60);
          y = Math.max(
            20,
            Math.min(rect.bottom - buttonHeight - margin, window.innerHeight - buttonHeight - margin)
          );
          break;
        case "bottom-right":
          x = Math.max(16, Math.min(window.innerWidth - 140, rect.right - 140));
          y = Math.max(
            20,
            Math.min(rect.bottom - buttonHeight - margin, window.innerHeight - buttonHeight - margin)
          );
          break;
        case "bottom-left":
        default:
          x = Math.max(16, rect.left + margin);
          y = Math.max(
            20,
            Math.min(rect.bottom - buttonHeight - margin, window.innerHeight - buttonHeight - margin)
          );
          break;
      }
    }
  }

  function isMangaElement(el: unknown): el is MangaTargetElement {
    return el instanceof HTMLImageElement || el instanceof HTMLCanvasElement;
  }

  onMount(() => {
    function handleMouseOver(e: MouseEvent) {
      const target = e.target;
      let el: MangaTargetElement | null = null;
      if (isMangaElement(target) && meetsThreshold(target)) {
        // Direct hover on a page image — always honored, no page-like gate
        // (small zoomed-out pages and linked reader images must still work).
        el = target;
      } else if (
        target instanceof HTMLElement &&
        !target.closest(OWN_UI_SELECTOR)
      ) {
        for (const child of target.querySelectorAll<MangaTargetElement>(
          "canvas, img",
        )) {
          if (
            meetsThreshold(child) &&
            isPageLike(child) &&
            fillsWrapper(child, target)
          ) {
            el = child;
            break;
          }
        }
        if (!el) {
          // Transparent tap overlays: inspect underlying elements
          const hits = document.elementsFromPoint(e.clientX, e.clientY);
          for (const hit of hits) {
            if (isMangaElement(hit) && meetsThreshold(hit) && isPageLike(hit)) {
              el = hit;
              break;
            }
          }
        }
      }

      if (!el || !document.body.contains(el)) {
        // Un-mappable hover (nav cards, text, chrome). A pill established via
        // descendant/underlying mapping never gets a mouseout from the mapped
        // image itself, so schedule the hide here instead of stranding it.
        if (
          targetImg &&
          targetImg !== autoImg &&
          hoverImg &&
          !(target instanceof Element && target.closest(OWN_UI_SELECTOR))
        ) {
          hoverImg = null;
          scheduleHide();
        }
        return;
      }
      hoverImg = el;
      cancelHide();
      if (targetImg !== el) {
        showFor(el, false);
      } else {
        // Hovering the retained target after a scroll-hide: bring it back.
        visible = true;
        adoptMode(el);
      }
    }

    function handleMouseOut(e: MouseEvent) {
      if (!isMangaElement(e.target)) return;
      if (e.target === hoverImg) hoverImg = null;
      if (e.target !== targetImg) return;
      // Pinned pipeline image stays visible without hover.
      if (targetImg === autoImg) return;
      // Snap back to the pipeline-active image instead of hiding.
      if (autoImg && isActive(autoImg)) {
        showFor(autoImg, true);
        return;
      }
      scheduleHide();
    }

    // Browsers don't reliably fire mouseout when a scrolled element slides
    // out from under a stationary cursor, so scroll/resize manages pill
    // visibility directly. Off-screen images hide the pill (keeping
    // targetImg/autoImg and the translating pin so scrolling back restores
    // it); in-view images only re-show it when the pill is still owned —
    // hovered or pipeline-pinned — never for stale indirect mappings.
    function handleScroll() {
      if (!targetImg) return;
      if (!document.body.contains(targetImg)) {
        visible = false;
        targetImg = null;
        return;
      }
      if (isInViewport(targetImg)) {
        if (hoverImg === targetImg || autoImg === targetImg) {
          visible = true;
          updatePosition();
        }
      } else {
        visible = false;
        if (targetImg !== autoImg && hoverImg !== targetImg) targetImg = null;
      }
    }

    function handleModeChange(e: Event) {
      const detail = (e as CustomEvent<{ mode?: string }>).detail;
      if (targetImg) {
        // Foreign overlay chatter must not clobber our target: settleTarget
        // only downgrades when the registry no longer holds it pending.
        settleTarget();
      }
      if (detail?.mode === "loading") {
        const img = pinFromModeEvent(e);
        if (img && img !== autoImg) autoImg = img;
        if (img && !hoverImg && (!targetImg || !isActive(targetImg))) {
          showFor(img, true);
        }
      }
    }

    function handleProgress(e: Event) {
      if (targetImg) {
        const customEvent = e as CustomEvent<{ message?: string }>;
        if (customEvent.detail?.message) {
          progressText = customEvent.detail.message;
        }
      }
    }

    function handleTranslationStatus(e: Event) {
      const detail = (e as CustomEvent<{ src?: string; status?: string }>).detail;
      if (!detail?.src || !detail?.status) return;

      if (detail.status === "pending") {
        const img =
          targetImg && srcMatches(targetImg, detail.src)
            ? targetImg
            : findImgForSrc(detail.src);
        if (!img) return;
        autoImg = img;
        // Stay on the hovered image; pointer-leave snaps back to autoImg.
        if (hoverImg && hoverImg !== img) return;
        if (targetImg !== img) showFor(img, true);
        // No overlay yet → keep generic progress, but show translating.
        if (queryMode(img) === "translating") adoptMode(img);
        else status = "translating";
        return;
      }

      if (detail.status !== "idle" && detail.status !== "done") return;
      // Safety net for queue-dropped / early-return no-ops that never emit
      // lmt:mode-change: fall back to the queried mode — but only for OUR
      // image. Unrelated images' events used to reset the optimistic
      // "translating" set on click (the flash). The registry-pending guard
      // inside settleTarget covers the pre-mount gap.
      if (targetImg && srcMatches(targetImg, detail.src)) settleTarget();
      // Clear the pin for our own image too: `handleMouseOut` refuses to hide
      // while `targetImg === autoImg`, so a never-cleared pin here left the
      // pill stuck in Translate state after a finished translation.
      if (autoImg && srcMatches(autoImg, detail.src)) {
        autoImg = null;
      }
    }

    document.addEventListener("mouseover", handleMouseOver, { passive: true });
    document.addEventListener("mouseout", handleMouseOut, { passive: true });
    window.addEventListener("resize", handleScroll, { passive: true });
    // Capture on document: `scroll` does not bubble, and many readers (Sunday
    // Webry included) scroll an inner container — window-only listeners never
    // fired for those, so the pill stayed pinned off-screen.
    document.addEventListener("scroll", handleScroll, { passive: true, capture: true });
    document.addEventListener("lmt:mode-change", handleModeChange, { passive: true });
    document.addEventListener("lmt:progress", handleProgress, { passive: true });
    document.addEventListener("lmt:translation-status", handleTranslationStatus, { passive: true });

    return () => {
      document.removeEventListener("mouseover", handleMouseOver);
      document.removeEventListener("mouseout", handleMouseOut);
      window.removeEventListener("resize", handleScroll);
      document.removeEventListener("scroll", handleScroll, true);
      document.removeEventListener("lmt:mode-change", handleModeChange);
      document.removeEventListener("lmt:progress", handleProgress);
      document.removeEventListener("lmt:translation-status", handleTranslationStatus);
      cancelHide();
    };
  });

  function handleTriggerClick(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (status === "idle" && targetImg && document.body.contains(targetImg)) {
      status = "translating";
      progressText = "Detecting text…";
      autoImg = targetImg;
      onTranslate?.(targetImg);
    }
  }

</script>

{#if visible && status !== "translated"}
  <!-- Pinned Floating Container -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    role="presentation"
    class="lmt-floating-root fixed z-[999999] pointer-events-auto select-none transition-opacity duration-200 {isDraggingTrigger ? 'cursor-grabbing' : ''}"
    style="top: {Math.max(8, y)}px; left: {Math.max(8, x)}px;"
    onmouseenter={cancelHide}
    onmouseleave={scheduleHide}
    onmousedown={(e) => e.stopPropagation()}
    onpointerdown={(e) => e.stopPropagation()}
    onclick={(e) => {
      e.stopPropagation();
      e.preventDefault();
    }}
  >
    <div class="flex items-center rounded-lg bg-[var(--surface-panel)] border border-[var(--border-line)] shadow-lg overflow-hidden">
      <!-- Drag Handle -->
      <button
        type="button"
        onmousedown={handleDragStart}
        class="pl-1.5 pr-0.5 py-1 text-[var(--text-muted)] hover:text-[var(--accent-cyan)] cursor-grab active:cursor-grabbing flex items-center transition-colors border-r border-[var(--border-line)]/50"
        title="Drag to move button (可拖拽自由移动)"
        aria-label="Drag to move"
      >
        <GripVertical size={13} />
      </button>

      <!-- Main Trigger Button -->
      <button
        type="button"
        onclick={handleTriggerClick}
        class="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold tracking-wide transition-all cursor-pointer {status === 'translating' ? 'text-[var(--accent-cyan)] cursor-wait' : 'text-[var(--text-primary)] hover:text-[var(--accent-amber)] hover:shadow-[0_0_12px_var(--accent-amber-glow)]'}"
        title={status === 'translating' ? progressText : 'Translate manga image'}
      >
        {#if status === "translating"}
          <LoaderCircle size={13} class="animate-spin text-[var(--accent-cyan)]" />
          <span class="text-[11px] animate-pulse">{progressText}</span>
        {:else}
          <Sparkles size={13} class="text-[var(--accent-amber)]" />
          <span class="text-[11px]">Translate</span>
        {/if}
      </button>
    </div>
  </div>
{/if}

<style>
  .lmt-floating-root {
    font-family: 'JetBrains Mono', monospace, -apple-system, sans-serif;
  }
</style>
