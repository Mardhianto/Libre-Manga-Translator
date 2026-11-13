<script lang="ts">
  import { onMount } from "svelte";
  import { Check, Database, LoaderCircle, RefreshCw, Trash2 } from "lucide-svelte";
  import { clearPageCache } from "@/lib/cache/page-cache";
  import { storage } from "#imports";

  let cachedPageCount = $state<number>(0);
  let loading = $state(false);
  let clearing = $state(false);
  let showConfirm = $state(false);
  let clearSuccessMsg = $state<string | null>(null);

  async function countCachedPages() {
    loading = true;
    try {
      const data = await storage.snapshot("local");
      let count = 0;
      for (const k of Object.keys(data)) {
        if (k.startsWith("page-cache-") || k.startsWith("local:page-cache-")) {
          count++;
        }
      }
      cachedPageCount = count;
    } catch (err) {
      console.warn("Failed to count cached pages:", err);
    } finally {
      loading = false;
    }
  }

  async function handleClearCache() {
    clearing = true;
    showConfirm = false;
    try {
      const { clearedCount } = await clearPageCache();
      cachedPageCount = 0;
      clearSuccessMsg = `Cleared ${clearedCount} page${clearedCount === 1 ? "" : "s"}`;
      setTimeout(() => {
        clearSuccessMsg = null;
      }, 3000);
    } catch (err) {
      console.warn("Failed to clear page cache:", err);
    } finally {
      clearing = false;
    }
  }

  onMount(() => {
    countCachedPages();
  });
</script>

<div class="space-y-1.5">
  <div class="flex items-center justify-between ml-0.5">
    <span class="kicker">Page translation cache</span>
    <button
      onclick={countCachedPages}
      disabled={loading || clearing}
      title="Refresh cache count"
      class="p-1 text-[var(--text-dim)] hover:text-[var(--text-primary)] rounded cursor-pointer transition-colors"
    >
      <RefreshCw size={12} class={loading ? "animate-spin" : ""} />
    </button>
  </div>

  <div class="panel-card !p-2.5 space-y-2">
    <div class="flex items-center justify-between text-xs">
      <div class="flex items-center gap-1.5 font-medium text-[var(--text-muted)]">
        <Database size={13} class="text-[var(--text-dim)]" />
        <span class="text-[11px]">Saved Pages:</span>
        <span class="font-mono font-bold text-[var(--text-primary)] text-[11px]">
          {loading ? "…" : cachedPageCount}
        </span>
      </div>

      {#if clearSuccessMsg}
        <span class="inline-flex items-center gap-1 text-[11px] text-[var(--accent-emerald)] font-medium">
          <Check size={12} />
          {clearSuccessMsg}
        </span>
      {:else if cachedPageCount > 0}
        {#if showConfirm}
          <div class="flex items-center gap-1.5">
            <button
              onclick={handleClearCache}
              disabled={clearing}
              class="px-2 py-0.5 text-[10px] bg-rose-600 text-white font-semibold rounded-[2px] hover:bg-rose-500 cursor-pointer disabled:opacity-50"
            >
              {clearing ? "Clearing…" : "Confirm"}
            </button>
            <button
              onclick={() => (showConfirm = false)}
              class="px-1.5 py-0.5 text-[10px] text-[var(--text-dim)] hover:text-[var(--text-primary)] cursor-pointer"
            >
              Cancel
            </button>
          </div>
        {:else}
          <button
            onclick={() => (showConfirm = true)}
            class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] text-[var(--text-dim)] hover:text-rose-400 hover:bg-rose-500/10 rounded-[2px] border border-transparent hover:border-rose-500/20 transition-colors cursor-pointer"
          >
            <Trash2 size={11} />
            <span>Clear cache</span>
          </button>
        {/if}
      {/if}
    </div>

    <p class="text-[10px] text-[var(--text-muted)] leading-snug">
      Stores translated dialogue per page. Stale pages automatically re-translate when settings change.
    </p>
  </div>
</div>
