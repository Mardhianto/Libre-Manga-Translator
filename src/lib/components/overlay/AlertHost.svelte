<script lang="ts">
  import { TriangleAlert, CircleAlert, X, RotateCw } from "lucide-svelte";
  import {
    subscribeAlerts,
    dismissAlert,
    dismissNotice,
    dismissActiveAlert,
    isAlertOpen,
    type OverlayAlert,
    type OverlayNotice,
  } from "./alerts";

  let alert = $state<OverlayAlert | null>(null);
  let notices = $state<OverlayNotice[]>([]);

  let dismissBtn = $state<HTMLButtonElement | null>(null);
  const noticeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function clearNoticeTimers() {
    for (const timer of noticeTimers.values()) clearTimeout(timer);
    noticeTimers.clear();
  }

  function syncNotices(next: OverlayNotice[]) {
    // Arm a timer per new notice; disarm the ones that are gone.
    const live = new Set(next.map((n) => n.id));
    for (const [id, timer] of noticeTimers) {
      if (!live.has(id)) {
        clearTimeout(timer);
        noticeTimers.delete(id);
      }
    }
    for (const notice of next) {
      if (noticeTimers.has(notice.id) || notice.durationMs <= 0) continue;
      noticeTimers.set(
        notice.id,
        setTimeout(() => dismissNotice(notice.id), notice.durationMs),
      );
    }
    notices = next;
  }

  $effect(() => {
    const unsubscribe = subscribeAlerts((state) => {
      alert = state.alert;
      syncNotices(state.notices);
    });
    return () => {
      unsubscribe();
      clearNoticeTimers();
    };
  });

  // Focus the primary action so the dialog is dismissible from the keyboard
  // even when the page swallows clicks. `role="alertdialog"` moves no focus.
  $effect(() => {
    if (alert && dismissBtn) dismissBtn.focus({ preventScroll: true });
  });

  function accept() {
    const current = alert;
    if (!current) return;
    dismissAlert(current.id);
    current.onDismiss?.();
  }

  function retry() {
    const current = alert;
    if (!current) return;
    dismissAlert(current.id);
    current.onRetry?.();
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (!alert) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      accept();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      const target = e.target as HTMLElement | null;
      // Let Enter activate a focused button natively.
      if (target?.tagName === "BUTTON") return;
      e.stopPropagation();
      e.preventDefault();
      if (alert.transient && alert.onRetry) retry();
      else accept();
    }
  }

  $effect(() => {
    // Capture-phase rescue: a reader that stopPropagation()s keys in its own
    // handler would otherwise keep the dialog alive forever. The old
    // implementation only listened inside the overlay's event path, so a
    // window-level Escape never reached it.
    const onDocumentKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !isAlertOpen()) return;
      e.stopPropagation();
      e.preventDefault();
      dismissActiveAlert();
    };
    window.addEventListener("keydown", onDocumentKey, true);
    return () => window.removeEventListener("keydown", onDocumentKey, true);
  });
</script>

<!--
  Host element: fixed to the viewport and pointer-transparent. Because this
  lives in its own shadow root mounted on <body>, no page-owned stacking
  context can cover it (LMT-034).
-->
<div
  class="lmt-alert-host"
  role="presentation"
  onkeydown={handleKeyDown}
>
  {#if notices.length > 0}
    <div
      role="region"
      aria-label="Notifications"
      class="absolute bottom-4 right-4 flex flex-col items-end gap-2 max-w-[340px] pointer-events-none"
    >
      {#each notices as notice (notice.id)}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
          role="status"
          aria-live="polite"
          class="pointer-events-auto flex items-start gap-2 px-3 py-2 rounded-[6px] border shadow-[0_8px_24px_rgba(0,0,0,0.7)] text-xs backdrop-blur-md select-none
                 {notice.kind === 'success'
                   ? 'bg-[var(--surface-panel)]/95 border-[var(--accent-emerald)]/50 text-[var(--text-primary)]'
                   : notice.kind === 'warn'
                     ? 'bg-[var(--surface-panel)]/95 border-[var(--accent-amber)]/50 text-[var(--text-primary)]'
                     : notice.kind === 'error'
                       ? 'bg-[var(--surface-panel)]/95 border-[var(--accent-rose)]/50 text-[var(--text-primary)]'
                       : 'bg-[var(--surface-panel)]/95 border-[var(--border-line)] text-[var(--text-primary)]'}"
          onmousedown={(e) => e.stopPropagation()}
          onpointerdown={(e) => e.stopPropagation()}
        >
          <span class="flex-1 text-[11px] leading-relaxed break-words">{notice.message}</span>
          <button
            type="button"
            class="shrink-0 p-0.5 -mr-1 text-[var(--text-dim)] hover:text-[var(--text-primary)] cursor-pointer rounded focus:outline-none"
            title="Dismiss"
            aria-label="Dismiss notification"
            onclick={(e) => {
              e.stopPropagation();
              dismissNotice(notice.id);
            }}
          >
            <X size={12} />
          </button>
        </div>
      {/each}
    </div>
  {/if}

  {#if alert}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="absolute inset-0 flex items-center justify-center z-[2147483000] bg-black/60 backdrop-blur-sm pointer-events-auto select-text"
      role="presentation"
      onmousedown={(e) => {
        e.stopPropagation();
        // Backdrop click dismisses, matching the old behaviour — but it is no
        // longer the only way out.
        if (e.target === e.currentTarget) accept();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-live="assertive"
        tabindex="-1"
        class="lmt-alert-dialog flex flex-col items-center gap-3 bg-[var(--surface-panel)] border rounded-[6px] shadow-[0_8px_32px_rgba(0,0,0,0.8)] px-6 py-5 max-w-[85%] text-center
               {alert.kind === 'error' ? 'border-rose-500/50' : alert.kind === 'warn' ? 'border-amber-500/50' : 'border-[var(--border-line)]'}"
        onmousedown={(e) => e.stopPropagation()}
        onpointerdown={(e) => e.stopPropagation()}
        onkeydown={handleKeyDown}
      >
        {#if alert.kind === "error"}
          <TriangleAlert size={28} class="text-rose-400 shrink-0" />
        {:else if alert.kind === "warn"}
          <TriangleAlert size={28} class="text-amber-400 shrink-0" />
        {:else}
          <CircleAlert size={28} class="text-[var(--accent-cyan)] shrink-0" />
        {/if}

        <p class="text-xs font-mono text-[var(--text-primary)] leading-relaxed max-h-40 overflow-y-auto custom-scrollbar whitespace-pre-wrap">
          {alert.message}
        </p>

        <div class="flex items-center gap-2 mt-1">
          {#if alert.transient && alert.onRetry}
            <button
              type="button"
              class="inline-flex items-center gap-1.5 px-3 py-1 rounded-[3px] bg-[var(--accent-cyan)]/20 hover:bg-[var(--accent-cyan)]/30 text-[var(--accent-cyan)] text-xs font-mono border border-[var(--accent-cyan)]/40 cursor-pointer transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent-cyan)]"
              onclick={(e) => {
                e.stopPropagation();
                retry();
              }}
            >
              <RotateCw size={12} />
              <span>Retry</span>
            </button>
          {/if}

          <button
            bind:this={dismissBtn}
            type="button"
            class="px-3 py-1 rounded-[3px] bg-[var(--surface-panel-alt)] hover:bg-[var(--accent-rose)]/20 text-[var(--text-primary)] text-xs font-mono border border-[var(--border-line)] cursor-pointer transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent-cyan)]"
            onclick={(e) => {
              e.stopPropagation();
              accept();
            }}
          >
            {alert.dismissLabel ?? "Dismiss"}
          </button>
        </div>

        {#if alert.transient}
          <p class="text-[10px] text-[var(--text-dim)] font-mono">
            Temporary provider error — this is not a settings problem.
          </p>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  /*
    `position: fixed` + `inset: 0` + a very high z-index keeps the channel
    above every page overlay. `pointer-events: none` means an idle host can
    never swallow a page click; the dialog re-enables pointer events itself.
  */
  .lmt-alert-host {
    position: fixed;
    inset: 0;
    z-index: 2147483000;
    pointer-events: none;
  }
  .lmt-alert-dialog {
    pointer-events: auto;
    cursor: default;
  }
</style>
