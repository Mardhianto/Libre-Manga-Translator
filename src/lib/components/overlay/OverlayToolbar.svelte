<script lang="ts">
  import {
    Box,
    Trash2,
    Eraser,
    ArrowUpNarrowWide,
    Check,
    Undo,
    Redo,
    X,
    GripVertical,
    GripHorizontal,
    PilcrowLeft,
    PilcrowRight,
    BoxSelect,
    PenLine,
    Download,
    Image,
  } from "lucide-svelte";

  interface Props {
    mode: "refining" | "results";
    hasBboxes?: boolean;
    hasActiveBox?: boolean;
    canUndo?: boolean;
    canRedo?: boolean;
    showOriginal?: boolean;
    position?: { x: number; y: number };
    isDragActive?: boolean;
    isDraggingToolbar?: boolean;
    readingDirection?: "rtl" | "ltr";
    onDragStart?: (e: MouseEvent) => void;
    onAddBox?: () => void;
    onDeleteBox?: () => void;
    onClearAll?: () => void;
    onAutoSort?: () => void;
    onToggleReadingDirection?: () => void;
    onConfirm?: () => void;
    onUndo?: () => void;
    onRedo?: () => void;
    onClose?: () => void;
    onRefine?: () => void;
    onEditTranslations?: () => void;
    onExportJpg?: () => void;
    onToggleOriginal?: () => void;
  }

  let {
    mode,
    hasBboxes = false,
    hasActiveBox = false,
    canUndo = false,
    canRedo = false,
    showOriginal = false,
    position = { x: 0, y: 0 },
    isDragActive = false,
    isDraggingToolbar = false,
    readingDirection = "rtl",
    onDragStart,
    onAddBox,
    onDeleteBox,
    onClearAll,
    onAutoSort,
    onToggleReadingDirection,
    onConfirm,
    onUndo,
    onRedo,
    onClose,
    onRefine,
    onEditTranslations,
    onExportJpg,
    onToggleOriginal,
  }: Props = $props();

  function getInitialResultsOffset(): { x: number; y: number } {
    try {
      const saved = localStorage.getItem("lmt-results-offset");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed?.x === "number" && typeof parsed?.y === "number") {
          return { x: parsed.x, y: parsed.y };
        }
      }
    } catch {}
    return { x: 0, y: 0 };
  }

  let resultsOffset = $state(getInitialResultsOffset());
  let isDraggingResults = $state(false);
  let resultsDragStart: { mouseX: number; mouseY: number; initialX: number; initialY: number } | null = null;

  function handleResultsDragStart(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    isDraggingResults = true;
    resultsDragStart = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      initialX: resultsOffset.x,
      initialY: resultsOffset.y,
    };

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!resultsDragStart) return;
      const dx = moveEvent.clientX - resultsDragStart.mouseX;
      const dy = moveEvent.clientY - resultsDragStart.mouseY;
      resultsOffset = {
        x: resultsDragStart.initialX + dx,
        y: resultsDragStart.initialY + dy,
      };
    };

    const handleMouseUp = () => {
      isDraggingResults = false;
      resultsDragStart = null;
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      try {
        localStorage.setItem("lmt-results-offset", JSON.stringify(resultsOffset));
      } catch {}
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }

  function trapClick(fn?: () => void) {
    return (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      fn?.();
    };
  }

  function trapEvent(e: Event) {
    e.stopPropagation();
  }
</script>

{#if mode === "refining"}
  <div
    class="fixed z-60 flex items-center gap-2 select-none flex-col pointer-events-auto
           {isDragActive ? 'opacity-30 pointer-events-none' : ''}
           {isDraggingToolbar ? 'transition-none cursor-grabbing' : 'transition-all duration-150'}"
    style="left: {position.x}px; top: {position.y}px;"
    onmousedown={trapEvent}
    onpointerdown={trapEvent}
    onclick={(e) => {
      e.stopPropagation();
      e.preventDefault();
    }}
    role="presentation"
  >
    <!-- Main Tactical Toolbar -->
    <div
      class="relative flex items-center gap-1.5 p-1 rounded-[6px] border border-[var(--border-line)] bg-[var(--surface-panel)] backdrop-blur-md shadow-[0_12px_40px_rgba(0,0,0,0.7),0_0_16px_var(--accent-cyan-glow)]"
    >
      <!-- Main Toolbar Drag Handle -->
      <button
        type="button"
        onmousedown={onDragStart}
        title="Drag to move toolbar anywhere (可拖拽自由移动)"
        class="h-8 px-1.5 inline-flex items-center justify-center rounded-[3px] text-[var(--text-muted)] hover:text-[var(--accent-cyan)] hover:bg-[var(--surface-panel)] transition-colors cursor-grab active:cursor-grabbing border border-transparent hover:border-[var(--border-line)] shrink-0"
        aria-label="Drag toolbar"
      >
        <GripVertical size={14} />
      </button>

      <!-- Add Box -->
      <button
        type="button"
        onclick={trapClick(onAddBox)}
        class="h-8 px-2.5 inline-flex items-center justify-center gap-1.5 rounded-[4px] text-xs font-semibold whitespace-nowrap shrink-0 transition-all cursor-pointer
               bg-[var(--surface-panel)] text-[var(--text-primary)] border border-[var(--border-line)] hover:border-[var(--accent-cyan)] hover:text-[var(--accent-cyan)] hover:shadow-[0_0_10px_var(--accent-cyan-glow)]"
      >
        <Box size={14} class="text-[var(--accent-cyan)] shrink-0" />
        <span>Add Box</span>
      </button>

      <!-- Delete Box -->
      <button
        type="button"
        onclick={trapClick(onDeleteBox)}
        disabled={!hasActiveBox}
        class="h-8 px-2.5 inline-flex items-center justify-center gap-1.5 rounded-[4px] text-xs font-semibold whitespace-nowrap shrink-0 transition-all cursor-pointer
               border disabled:opacity-40 disabled:cursor-not-allowed
               {hasActiveBox
                 ? 'bg-[var(--accent-rose-soft)] text-[var(--accent-rose)] border-[var(--accent-rose)]/50 hover:bg-[var(--accent-rose)]/25 shadow-[0_0_8px_var(--accent-rose-glow)]'
                 : 'bg-[var(--surface-panel)] text-[var(--text-dim)] border-[var(--border-line)]'}"
      >
        <Trash2 size={14} class="shrink-0" />
        <span>Delete</span>
      </button>

      <!-- Clear All -->
      <button
        type="button"
        onclick={trapClick(onClearAll)}
        disabled={!hasBboxes}
        title="Clear all bounding boxes"
        class="h-8 px-2.5 inline-flex items-center justify-center gap-1.5 rounded-[4px] text-xs font-semibold whitespace-nowrap shrink-0 transition-all cursor-pointer
               bg-[var(--surface-panel)] text-[var(--text-muted)] border border-[var(--border-line)] hover:text-[var(--accent-rose)] hover:border-[var(--accent-rose)]/40 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Eraser size={14} class="shrink-0" />
        <span>Clear</span>
      </button>

      <!-- Auto Sort -->
      <button
        type="button"
        onclick={trapClick(onAutoSort)}
        disabled={!hasBboxes}
        title="Re-sort boxes in {readingDirection === 'rtl' ? 'right-to-left manga' : 'left-to-right comic/manhwa'} reading order"
        class="h-8 px-2.5 inline-flex items-center justify-center gap-1.5 rounded-[4px] text-xs font-semibold whitespace-nowrap shrink-0 transition-all cursor-pointer
               bg-[var(--surface-panel)] text-[var(--text-primary)] border border-[var(--border-line)] hover:border-[var(--accent-emerald)] hover:text-[var(--accent-emerald)] disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <ArrowUpNarrowWide size={14} class="text-[var(--accent-emerald)] shrink-0" />
        <span>Auto Sort</span>
      </button>

      <div class="w-px h-4.5 bg-[var(--border-line)] mx-0.5 shrink-0"></div>

      <!-- Confirm Action -->
      <button
        type="button"
        onclick={trapClick(onConfirm)}
        disabled={!hasBboxes}
        class="h-8 px-3 inline-flex items-center justify-center gap-1.5 rounded-[4px] text-xs font-bold whitespace-nowrap shrink-0 tracking-wide transition-all cursor-pointer
               bg-gradient-to-r from-cyan-400 to-[#00f0ff] text-[#05040b] shadow-[0_0_14px_var(--accent-cyan-glow)]
               hover:shadow-[0_0_22px_rgba(0,240,255,0.5)] hover:-translate-y-px active:translate-y-0 border border-[var(--accent-cyan)] disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
      >
        <Check size={14} class="shrink-0" />
        <span>Confirm</span>
      </button>

      <!-- Close -->
      <button
        type="button"
        onclick={trapClick(onClose)}
        title="Cancel and close"
        class="w-8 h-8 inline-flex items-center justify-center rounded-[4px] p-0 shrink-0 text-[var(--text-muted)] hover:text-[var(--accent-rose)] hover:bg-[var(--surface-panel)] transition-colors cursor-pointer border border-transparent hover:border-[var(--border-line)] ml-0.5"
      >
        <X size={15} class="shrink-0" />
      </button>
    </div>

    <!-- Undo / Redo Sub-Strip with Drag Handle -->
    <div
      class="flex items-center gap-1 p-1 rounded-[4px] border border-[var(--border-line)] bg-[var(--surface-panel)]  backdrop-blur-md shadow-md"
    >
      <!-- Drag Handle -->
      <button
        type="button"
        onmousedown={onDragStart}
        title="Drag to move toolbar"
        class="w-7 h-7 inline-flex items-center justify-center p-0 rounded-[3px] text-[var(--text-muted)] hover:text-[var(--accent-cyan)] hover:bg-[var(--surface-panel)] transition-colors cursor-move border border-transparent hover:border-[var(--border-line)]"
      >
        <GripVertical size={14} />
      </button>
      <div class="w-px h-4 bg-[var(--border-line)] shrink-0"></div>
      <button
        type="button"
        onclick={trapClick(onUndo)}
        disabled={!canUndo}
        title="Undo (Ctrl+Z)"
        class="w-7 h-7 inline-flex items-center justify-center p-0 rounded-[3px] text-[var(--text-muted)] hover:text-[var(--accent-cyan)] hover:bg-[var(--surface-panel)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer border border-transparent hover:border-[var(--border-line)]"
      >
        <Undo size={14} />
      </button>
      <button
        type="button"
        onclick={trapClick(onRedo)}
        disabled={!canRedo}
        title="Redo (Ctrl+Y)"
        class="w-7 h-7 inline-flex items-center justify-center p-0 rounded-[3px] text-[var(--text-muted)] hover:text-[var(--accent-cyan)] hover:bg-[var(--surface-panel)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer border border-transparent hover:border-[var(--border-line)]"
      >
        <Redo size={14} />
      </button>
      <div class="w-px h-4 bg-[var(--border-line)] shrink-0"></div>
      <!-- Reading Direction Toggle -->
      <button
        type="button"
        onclick={trapClick(onToggleReadingDirection)}
        title="{readingDirection === 'rtl' ? 'RTL mode (manga)' : 'LTR mode (comic/manhwa)'} - Click to switch"
        class="w-7 h-7 inline-flex items-center justify-center p-0 rounded-[3px] transition-colors cursor-pointer border
               {readingDirection === 'rtl'
                 ? 'text-[var(--accent-amber)] bg-[var(--surface-panel)] border-[var(--accent-amber)]/40 shadow-[0_0_6px_var(--accent-amber-glow)]'
                 : 'text-[var(--accent-cyan)] bg-[var(--surface-panel)] border-[var(--accent-cyan)]/40 shadow-[0_0_6px_var(--accent-cyan-glow)]'}"
      >
        {#if readingDirection === "rtl"}
          <PilcrowLeft size={14} />
        {:else}
          <PilcrowRight size={14} />
        {/if}
      </button>
    </div>
  </div>
{:else if mode === "results"}
  <!-- Floating Action Cluster on Results -->
  <div
    class="absolute left-2.5 bottom-2.5 flex flex-col gap-1 z-50 select-none pointer-events-auto {isDraggingResults ? 'transition-none cursor-grabbing' : 'transition-transform duration-150'}"
    style="transform: translate({resultsOffset.x}px, {resultsOffset.y}px);"
    onclick={(e) => {
      e.stopPropagation();
      e.preventDefault();
    }}
    onmousedown={trapEvent}
    onpointerdown={trapEvent}
    onkeydown={trapEvent}
    role="presentation"
  >
    <div class="flex flex-col gap-1 p-1 rounded-[6px] border border-[var(--border-line)] bg-[var(--surface-panel)] backdrop-blur-md shadow-[0_8px_30px_rgba(0,0,0,0.3),0_0_12px_var(--text-dim)]">
      <!-- Drag Handle -->
      <button
        type="button"
        onmousedown={handleResultsDragStart}
        title="Drag to move toolbar (可自由拖拽移动)"
        aria-label="Drag results toolbar"
        class="w-8 h-4 inline-flex items-center justify-center rounded-[3px] text-[var(--text-dim)] hover:text-[var(--accent-cyan)] cursor-grab active:cursor-grabbing transition-colors"
      >
        <GripHorizontal size={14} />
      </button>

      <!-- Refine Boxes -->
      <button
        type="button"
        onclick={trapClick(onRefine)}
        title="Refine Boxes (reopen editor)"
        class="w-8 h-8 inline-flex items-center justify-center rounded-[4px] p-0 shrink-0 text-[var(--text-muted)] hover:text-[var(--accent-amber)] hover:bg-[var(--surface-panel)] transition-colors cursor-pointer border border-transparent hover:border-[var(--border-line)]"
      >
        <BoxSelect size={16} />
      </button>

      <!-- Edit Translations -->
      <button
        type="button"
        onclick={trapClick(onEditTranslations)}
        title="Edit text translations"
        class="w-8 h-8 inline-flex items-center justify-center rounded-[4px] p-0 shrink-0 text-[var(--text-muted)] hover:text-[var(--accent-cyan)] hover:bg-[var(--surface-panel)] transition-colors cursor-pointer border border-transparent hover:border-[var(--border-line)]"
      >
        <PenLine size={16} />
      </button>

      <!-- Download JPG -->
      <button
        type="button"
        onclick={trapClick(onExportJpg)}
        title="Export full-res JPG"
        class="w-8 h-8 inline-flex items-center justify-center rounded-[4px] p-0 shrink-0 text-[var(--text-muted)] hover:text-[var(--accent-emerald)] hover:bg-[var(--surface-panel)] transition-colors cursor-pointer border border-transparent hover:border-[var(--border-line)]"
      >
        <Download size={16} />
      </button>

      <!-- Toggle Original / Translated -->
      <button
        type="button"
        onclick={trapClick(onToggleOriginal)}
        title={showOriginal ? "Show Translated Page" : "Show Original Scan"}
        class="w-8 h-8 inline-flex items-center justify-center rounded-[4px] p-0 shrink-0 transition-colors cursor-pointer border {showOriginal ? 'text-[var(--accent-amber)] bg-[var(--surface-panel)] border-[var(--accent-amber)]/40 shadow-[0_0_8px_var(--accent-amber-glow)]' : 'text-[var(--text-muted)] hover:text-[var(--accent-cyan)] hover:bg-[var(--surface-panel)] border-transparent hover:border-[var(--border-line)]'}"
      >
        <Image size={16} />
      </button>

      <div class="w-full h-px bg-[var(--border-line)] my-0.5"></div>

      <!-- Close Overlay -->
      <button
        type="button"
        onclick={trapClick(onClose)}
        title="Close translation overlay"
        class="w-8 h-8 inline-flex items-center justify-center rounded-[4px] p-0 shrink-0 text-[var(--text-dim)] hover:text-[var(--accent-rose)] hover:bg-[var(--surface-panel)] transition-colors cursor-pointer border border-transparent hover:border-[var(--border-line)]"
      >
        <X size={16} />
      </button>
    </div>
  </div>
{/if}
