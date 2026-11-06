<script lang="ts">
  import { fly } from "svelte/transition";
  import { onMount } from "svelte";
  import {
    Download,
    LoaderCircle,
    CircleCheck,
    CircleAlert,
    ChevronRight,
    Square,
  } from "lucide-svelte";
  import { DefaultConfig } from "@/lib/configs";
  import { createLlmEngine } from "@/lib/llm-engine";
  import { checkWebGPUFeature } from "@/lib/hardware";
  import type { MLCEngine } from "@mlc-ai/web-llm";
  import { isAbortError, probeLlmsCached } from "@/lib/utils";

  let {
    selectedLlmModel = $bindable(DefaultConfig.llmModels[0].id),
    onBack,
    onNext,
  }: {
    selectedLlmModel?: string;
    onBack: () => void;
    onNext: () => void;
  } = $props();

  let llmDownloading = $state(false);
  let llmProgress = $state(0);
  let llmProgressText = $state("Preparing...");
  let llmDone = $state(false);
  let llmError = $state<string | null>(null);
  let llmEngine: MLCEngine | null = null;
  let cachedLlms = $state<string[]>([]);

  /**
   * null = not probed / unknown → show everything.
   * false = adapter lacks `shader-f16` → WebLLM's `reload()` would throw
   * `ShaderF16SupportError` after the download, so the row is disabled.
   */
  let hasShaderF16 = $state<boolean | null>(null);

  function blockedByFeature(modelId: string): boolean {
    if (hasShaderF16 !== false) return false;
    return DefaultConfig.llmModels.some(
      (m) => m.id === modelId && m.requiresFeature === "shader-f16",
    );
  }
  
  // Variable to track if we've checked cleaning (for effect dependency)
  let isCleaning = $state(false);

  // Check which models are actually cached
  async function checkCacheStatus() {
    try {
      const modelIds = DefaultConfig.llmModels.map((m) => m.id);
      const verified = await probeLlmsCached(modelIds);
      cachedLlms = verified;
      // If current selection is cached but not showing as done, mark it as done
      if (cachedLlms.includes(selectedLlmModel) && !llmDone) {
        llmDone = true;
        llmError = null;
      }
    } catch {
      // Probe unavailable, keep existing cache state
    }
  }

  // Watch for model selection changes and update UI accordingly
  $effect(() => {
    if (!llmDownloading && !isCleaning) {
      // When model selection changes, check if it's cached
      if (cachedLlms.includes(selectedLlmModel)) {
        llmDone = true;
        llmError = null;
      } else {
        llmDone = false;
        llmError = null;
      }
    }
  });
  
  // Check cache status on mount
  onMount(() => {
    void checkCacheStatus();
    // Feature gate for shader-f16 models: unknown → keep every row enabled.
    void checkWebGPUFeature("shader-f16").then((ok) => {
      hasShaderF16 = ok;
    });
  });

  async function startLlmDownload() {
    if (llmDownloading) return;
    
    // If already cached, just mark as done and show success
    if (cachedLlms.includes(selectedLlmModel)) {
      llmDone = true;
      llmError = null;
      return;
    }
    
    llmDownloading = true;
    llmDone = false;
    llmError = null;
    llmProgress = 0;
    llmProgressText = "Initializing...";
    try {
      llmEngine = createLlmEngine({
        initProgressCallback: (p) => {
          llmProgress = Math.round((p.progress ?? 0) * 100);
          llmProgressText = p.text ?? "";
        },
      });
      await llmEngine.reload(selectedLlmModel);
      llmDone = true;
      
      const items = await storage.getItems(["local:cached-llms"]);
      const cached = (items[0].value as string[]) || [];
      await storage.setItems([
        ...(!cached.includes(selectedLlmModel)
          ? [{ key: "local:cached-llms" as const, value: [...cached, selectedLlmModel] }]
          : []),
        { key: "sync:llm-model" as const, value: selectedLlmModel },
      ]);
      
      // Update local cache state immediately
      if (!cached.includes(selectedLlmModel)) {
        cachedLlms = [...cached, selectedLlmModel];
      }
    } catch (err: any) {
      // Stop (engine.unload aborts reload) is user intent — not a failure.
      if (isAbortError(err)) {
        llmProgressText = "Download stopped.";
        return;
      }
      llmError =
        err?.message ??
        "Download failed. Please check your connection and try again.";
    } finally {
      llmDownloading = false;
      llmEngine = null;
    }
  }

  async function stopLlmDownload() {
    if (!llmDownloading) return;
    llmProgressText = "Stopping download...";
    try {
      await llmEngine?.unload();
    } catch {
      // unload abort surfaces as reload rejection — swallowed above
    }
  }
</script>

<div class="space-y-4">
  <div>
    <h2 class="text-base font-display font-bold text-[var(--text-primary)]">
      Local Language Model
    </h2>
    <p class="text-xs text-[var(--text-muted)] mt-0.5">
      Download on-device LLM weights for offline translation.
    </p>
  </div>

  <!-- Model selection grid -->
  <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
    {#each DefaultConfig.llmModels as model}
      {@const blocked = blockedByFeature(model.id)}
      {@const shownSize = model.weightMb >= 1024
        ? `~${(model.weightMb / 1024).toFixed(1)} GB`
        : `~${model.weightMb} MB`}
      <button
        type="button"
        onclick={() => (selectedLlmModel = model.id)}
        disabled={llmDownloading || blocked}
        title={blocked ? "This GPU lacks the shader-f16 WebGPU extension" : undefined}
        class="p-3.5 rounded-xl border text-left cursor-pointer transition-all disabled:opacity-50 disabled:cursor-not-allowed bg-[var(--bg-void)]
          {selectedLlmModel === model.id
          ? 'border-[var(--accent-amber)] shadow-[0_0_14px_var(--accent-amber-glow)]'
          : 'border-[var(--border-line)] hover:border-[var(--border-line)]/80'}"
      >
        <div class="flex items-center justify-between mb-1">
          <p
            class="text-xs font-display font-bold {selectedLlmModel === model.id
              ? 'text-[var(--accent-amber)]'
              : 'text-[var(--text-primary)]'}"
          >
            {model.label}
          </p>
          <span class="badge-cyber is-amber text-[10px] !py-0.5 !px-1.5 font-mono">
            {model.vram} VRAM
          </span>
        </div>
        <p
          class="text-[11px] leading-snug {selectedLlmModel === model.id
            ? 'text-[var(--text-primary)]'
            : 'text-[var(--text-muted)]'}"
        >
          {model.desc}
        </p>
        <p class="text-[10px] text-[var(--text-dim)] font-mono mt-1">
          {shownSize} download{blocked ? " · GPU lacks shader-f16" : ""}
        </p>
      </button>
    {/each}
  </div>

  {#if !llmDone}
    <button
      type="button"
      onclick={startLlmDownload}
      disabled={llmDownloading}
      class="w-full btn-primary !py-2.5 text-xs font-bold transition-all flex items-center justify-center gap-2 cursor-pointer"
    >
      {#if llmDownloading}
        <LoaderCircle size={15} class="animate-spin" />
        Downloading Weights...
      {:else}
        <Download size={15} />
        Download Model Weights
      {/if}
    </button>

    {#if llmDownloading}
      <div
        in:fly={{ y: 6, duration: 200 }}
        class="space-y-1.5 p-3 rounded-xl bg-[var(--bg-void)] border border-[var(--border-line)]"
      >
        <div class="flex items-center justify-between text-xs">
          <span class="text-[var(--text-muted)]">Downloading</span>
          <span class="font-mono text-[var(--accent-cyan)] font-bold">{llmProgress}%</span>
        </div>
        <div
          class="h-1.5 bg-[var(--surface-panel)] rounded-full overflow-hidden border border-[var(--border-faint)]"
        >
          <div
            class="h-full bg-[var(--accent-cyan)] shadow-[0_0_8px_var(--accent-cyan-glow)] rounded-full transition-all duration-300"
            style="width: {llmProgress}%"
          ></div>
        </div>
        <p class="text-[11px] text-[var(--text-dim)] truncate font-mono">
          {llmProgressText}
        </p>
        <button
          type="button"
          onclick={stopLlmDownload}
          title="Stop download (completed shards stay cached and resume on next start)"
          class="w-full btn-ghost !py-1.5 text-xs cursor-pointer flex items-center justify-center gap-1.5"
        >
          <Square size={13} />
          Stop Download
        </button>
      </div>
    {/if}
  {:else}
    <div
      in:fly={{ y: 6, duration: 200 }}
      class="flex items-center gap-2.5 p-3 bg-[var(--bg-void)] border border-[var(--accent-emerald)]/40 rounded-xl"
    >
      <CircleCheck size={16} class="text-[var(--accent-emerald)] shrink-0" />
      <p class="text-xs font-medium text-[var(--accent-emerald)]">
        Model weights downloaded and ready for offline use.
      </p>
    </div>
  {/if}

  {#if llmError}
    <div
      class="flex items-start gap-2 p-3 bg-[var(--bg-void)] border border-[var(--accent-rose)]/40 rounded-xl text-[var(--accent-rose)]"
    >
      <CircleAlert size={14} class="shrink-0 mt-0.5" />
      <p class="text-xs leading-snug">{llmError}</p>
    </div>
  {/if}

  <!-- Navigation -->
  <div class="flex items-center gap-2.5 pt-2 border-t border-[var(--border-faint)]">
    <button
      type="button"
      onclick={onBack}
      class="btn-ghost flex-1 text-xs !py-2.5 cursor-pointer"
    >
      Back
    </button>
    <button
      type="button"
      onclick={onNext}
      disabled={!llmDone}
      class="btn-primary flex-1 text-xs !py-2.5 font-bold cursor-pointer disabled:bg-none disabled:bg-[var(--surface-panel-alt)] disabled:border-[var(--border-line)] disabled:text-[var(--text-dim)] disabled:opacity-60 disabled:shadow-none disabled:cursor-not-allowed"
    >
      Continue
      <ChevronRight size={14} />
    </button>
  </div>
</div>
