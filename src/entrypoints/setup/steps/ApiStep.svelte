<script lang="ts">
  import { Check, Eye, EyeOff, ChevronRight, ChevronDown, ChevronUp } from "lucide-svelte";
  import apiModeNotes from "../apiModeNotes.json";

  let {
    serverHost = $bindable(""),
    serverSchema = $bindable("openai"),
    serverModel = $bindable(""),
    useServerApiKey = $bindable(false),
    serverApiKey = $bindable(""),
    onBack,
    onNext,
  }: {
    serverHost?: string;
    serverSchema?: string;
    serverModel?: string;
    useServerApiKey?: boolean;
    serverApiKey?: string;
    onBack: () => void;
    onNext: () => void;
  } = $props();

  const API_RUNNERS = [
    {
      id: "ollama",
      name: "Ollama",
      defaultHost: "http://localhost:11434/v1",
      defaultSchema: "openai",
      defaultModel: "llama3.2",
      requiresApiKey: false,
      noteKey: "ollama",
    },
    {
      id: "lmstudio",
      name: "LM Studio",
      defaultHost: "http://localhost:1234/api/v1",
      defaultSchema: "lmstudio",
      defaultModel: "",
      requiresApiKey: false,
      noteKey: "lmstudio",
    },
    {
      id: "jan",
      name: "JAN",
      defaultHost: "http://localhost:1337",
      defaultSchema: "openai",
      defaultModel: "",
      requiresApiKey: false,
      noteKey: "jan",
    },
    {
      id: "unsloth",
      name: "Unsloth Desktop",
      defaultHost: "http://localhost:8888",
      defaultSchema: "openai",
      defaultModel: "",
      requiresApiKey: false,
      noteKey: "unsloth",
    },
    {
      id: "llamacpp",
      name: "llama.cpp",
      defaultHost: "http://localhost:8080/v1",
      defaultSchema: "openai",
      defaultModel: "",
      requiresApiKey: true,
      noteKey: "llamacpp",
    },
    {
      id: "koboldcpp",
      name: "KoboldCpp",
      defaultHost: "http://localhost:5001/v1",
      defaultSchema: "openai",
      defaultModel: "",
      requiresApiKey: false,
      noteKey: "koboldcpp",
    },
    {
      id: "localai",
      name: "LocalAI",
      defaultHost: "http://localhost:8080",
      defaultSchema: "openai",
      defaultModel: "",
      requiresApiKey: false,
      noteKey: "localai",
    },
    {
      id: "cherrystudio",
      name: "Cherry Studio",
      defaultHost: "http://localhost:8000",
      defaultSchema: "openai",
      defaultModel: "",
      requiresApiKey: true,
      noteKey: "cherrystudio",
    },
    {
      id: "custom",
      name: "Custom / Other",
      defaultHost: "",
      defaultSchema: "openai",
      defaultModel: "",
      requiresApiKey: false,
      noteKey: null,
    },
  ] as const;

  let showKey = $state(false);
  let selectedRunner = $state("ollama");
  let showNote = $state(false);

  function handleRunnerChange() {
    const runner = API_RUNNERS.find((r) => r.id === selectedRunner);
    if (!runner) return;

    serverHost = runner.defaultHost;
    serverSchema = runner.defaultSchema;
    serverModel = runner.defaultModel;
    useServerApiKey = runner.requiresApiKey;
    if (!runner.requiresApiKey) {
      serverApiKey = "";
    }
    showNote = false;
  }

  let currentNote = $derived(() => {
    const runner = API_RUNNERS.find((r) => r.id === selectedRunner);
    if (!runner?.noteKey) return null;
    return apiModeNotes[runner.noteKey as keyof typeof apiModeNotes] || null;
  });

  function parseMarkdown(md: string): string {
    const lines = md.split("\n");
    let html = "";
    let inList = false;
    let inCodeBlock = false;
    let codeLines: string[] = [];

    for (const line of lines) {
      // Code block detection
      if (line.trim().startsWith("```")) {
        if (inCodeBlock) {
          html += `<pre class="bg-[var(--surface-panel)] border border-[var(--border-faint)] rounded-lg p-2.5 overflow-x-auto text-[11px] font-mono my-2"><code>${codeLines.join("\n")}</code></pre>`;
          codeLines = [];
          inCodeBlock = false;
        } else {
          if (inList) {
            html += "</ul>";
            inList = false;
          }
          inCodeBlock = true;
        }
        continue;
      }

      if (inCodeBlock) {
        codeLines.push(line.replace(/</g, "&lt;").replace(/>/g, "&gt;"));
        continue;
      }

      if (/^-{3,}$/.test(line.trim())) {
        if (inList) {
          html += "</ul>";
          inList = false;
        }
        html += '<hr class="border-[var(--border-faint)] my-3" />';
        continue;
      }
      if (line.startsWith("# ")) {
        if (inList) {
          html += "</ul>";
          inList = false;
        }
        html += `<h1 class="text-sm font-display font-bold mb-2 text-[var(--text-primary)]">${fmt(line.slice(2))}</h1>`;
        continue;
      }
      if (line.startsWith("## ")) {
        if (inList) {
          html += "</ul>";
          inList = false;
        }
        html += `<h2 class="text-xs font-display font-semibold mt-3 mb-1.5 text-[var(--text-primary)]">${fmt(line.slice(3))}</h2>`;
        continue;
      }
      if (line.startsWith("### ")) {
        if (inList) {
          html += "</ul>";
          inList = false;
        }
        html += `<h3 class="text-[11px] font-display font-semibold mt-2 mb-1 text-[var(--text-muted)]">${fmt(line.slice(4))}</h3>`;
        continue;
      }
      if (line.startsWith("> ")) {
        if (inList) {
          html += "</ul>";
          inList = false;
        }
        html += `<blockquote class="border-l-2 border-[var(--accent-cyan)] pl-2.5 my-2 py-0.5 text-xs italic text-[var(--text-dim)] bg-[var(--bg-void)] rounded-r">${fmt(line.slice(2))}</blockquote>`;
        continue;
      }
      if (/^\d+\./.test(line.trim())) {
        if (inList) {
          html += "</ul>";
          inList = false;
        }
        if (!html.includes('<ol class="list-decimal')) {
          html += '<ol class="list-decimal list-inside space-y-1 my-1.5">';
        }
        html += `<li class="text-xs text-[var(--text-muted)] leading-relaxed">${fmt(line.trim().replace(/^\d+\.\s*/, ""))}</li>`;
        continue;
      }
      if (line.startsWith("- ")) {
        if (!inList) {
          html += '<ul class="list-disc list-inside space-y-1 my-1.5">';
          inList = true;
        }
        html += `<li class="text-xs text-[var(--text-muted)] leading-relaxed">${fmt(line.slice(2))}</li>`;
        continue;
      }
      if (!line.trim()) {
        if (inList) {
          html += "</ul>";
          inList = false;
        }
        continue;
      }
      if (inList) {
        html += "</ul>";
        inList = false;
      }
      html += `<p class="text-xs leading-relaxed text-[var(--text-muted)] mb-2">${fmt(line)}</p>`;
    }
    if (inList) html += "</ul>";
    return html;
  }

  function fmt(text: string): string {
    return text
      .replace(
        /\*\*(.+?)\*\*/g,
        '<strong class="font-semibold text-[var(--text-primary)]">$1</strong>',
      )
      .replace(
        /`(.+?)`/g,
        '<code class="text-[10px] font-mono bg-[var(--surface-panel)] text-[var(--accent-cyan)] px-1.5 py-0.5 rounded border border-[var(--border-faint)]">$1</code>',
      )
      .replace(
        /\[(.+?)\]\((.+?)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-[var(--accent-cyan)] hover:underline font-medium">$1</a>',
      );
  }
</script>

<div class="space-y-4">
  <div>
    <h2 class="text-base font-display font-bold text-[var(--text-primary)]">
      API Mode Server
    </h2>
    <p class="text-xs text-[var(--text-muted)] mt-0.5">
      Connect to local LLM servers like Ollama, LM Studio, JAN, or any OpenAI-compatible API.
    </p>
  </div>

  <!-- Runner Preset -->
  <div class="space-y-1.5">
    <label for="setup-runner" class="kicker text-[11px]">
      Select Runner
    </label>
    <select
      id="setup-runner"
      bind:value={selectedRunner}
      onchange={handleRunnerChange}
      class="w-full bg-[var(--bg-void)] border border-[var(--border-line)] rounded-xl p-2.5 text-xs outline-none cursor-pointer text-[var(--text-primary)]"
    >
      {#each API_RUNNERS as runner}
        <option value={runner.id}>{runner.name}</option>
      {/each}
    </select>
  </div>

  <!-- Setup Instructions (Collapsible) -->
  {#if currentNote()}
    {@const note = currentNote()}
    <div class="space-y-1.5">
      <button
        type="button"
        onclick={() => (showNote = !showNote)}
        class="w-full flex items-center justify-between p-2.5 bg-[var(--surface-panel-alt)] border border-[var(--border-faint)] rounded-xl text-xs text-[var(--text-primary)] hover:border-[var(--border-line)] transition-colors cursor-pointer"
      >
        <span class="font-medium">Setup Instructions</span>
        {#if showNote}
          <ChevronUp size={14} class="text-[var(--text-muted)]" />
        {:else}
          <ChevronDown size={14} class="text-[var(--text-muted)]" />
        {/if}
      </button>

      {#if showNote && note}
        <div class="relative">
          <div
            class="h-[280px] overflow-y-auto rounded-xl bg-[var(--bg-void)] border border-[var(--border-faint)] p-3 custom-scrollbar scroll-smooth"
          >
            <div class="font-semibold text-[var(--accent-cyan)] mb-2">
              {note.title}
            </div>
            <div class="prose-clean">
              {@html parseMarkdown(note.content)}
            </div>
          </div>
          <!-- Fade hint at bottom -->
          <div
            class="absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-[var(--bg-void)] to-transparent pointer-events-none rounded-b-xl"
          ></div>
        </div>
      {/if}
    </div>
  {/if}

  <div class="space-y-3">
    <div class="space-y-1">
      <label
        for="setup-server-host"
        class="kicker text-[11px]"
      >
        Server Endpoint URL
      </label>
      <input
        id="setup-server-host"
        type="text"
        bind:value={serverHost}
        placeholder="http://127.0.0.1:11434/v1"
        class="w-full bg-[var(--bg-void)] border border-[var(--border-line)] rounded-xl p-2.5 text-xs focus:border-[var(--accent-cyan)] outline-none transition-all font-mono text-[var(--text-primary)]"
      />
    </div>

    <div class="grid grid-cols-2 gap-2.5">
      <div class="space-y-1">
        <label
          for="setup-server-schema"
          class="kicker text-[11px]"
        >
          API Schema
        </label>
        <select
          id="setup-server-schema"
          bind:value={serverSchema}
          class="w-full bg-[var(--bg-void)] border border-[var(--border-line)] rounded-xl p-2 text-xs outline-none cursor-pointer text-[var(--text-primary)]"
        >
          <option value="openai">OpenAI-compatible</option>
          <option value="lmstudio">LM Studio</option>
        </select>
      </div>
      <div class="space-y-1">
        <label
          for="setup-server-model"
          class="kicker text-[11px]"
        >
          Model Identifier
        </label>
        <input
          id="setup-server-model"
          type="text"
          bind:value={serverModel}
          placeholder="e.g. qwen3.5:4b"
          class="w-full bg-[var(--bg-void)] border border-[var(--border-line)] rounded-xl p-2 text-xs focus:border-[var(--accent-cyan)] outline-none transition-all text-[var(--text-primary)] font-mono"
        />
      </div>
    </div>

    <!-- API Key Toggle -->
    <div class="space-y-2 pt-1">
      <label class="flex items-center gap-2.5 cursor-pointer group select-none">
        <div class="relative flex items-center shrink-0">
          <input
            type="checkbox"
            bind:checked={useServerApiKey}
            class="peer sr-only"
          />
          <div
            class="h-4 w-4 rounded-[4px] border border-[var(--border-line)] bg-[var(--bg-void)] peer-checked:bg-[var(--accent-cyan)] peer-checked:border-[var(--accent-cyan)] transition-all flex items-center justify-center"
          >
            <Check
              size={11}
              class="text-[#05040b] scale-0 peer-checked:scale-100 transition-transform stroke-[3]"
            />
          </div>
        </div>
        <span
          class="text-xs font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-cyan)] transition-colors"
        >
          Require Bearer API key
        </span>
      </label>

      {#if useServerApiKey}
        <div class="relative">
          <input
            type={showKey ? "text" : "password"}
            bind:value={serverApiKey}
            placeholder="Bearer API key"
            class="w-full bg-[var(--bg-void)] border border-[var(--border-line)] rounded-xl p-2.5 pr-10 text-xs font-mono focus:border-[var(--accent-cyan)] outline-none transition-all text-[var(--text-primary)]"
          />
          <button
            type="button"
            onclick={() => (showKey = !showKey)}
            class="absolute inset-y-0 right-0 flex items-center pr-3 text-[var(--text-dim)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
            aria-label={showKey ? "Hide key" : "Show key"}
          >
            {#if showKey}
              <EyeOff size={14} />
            {:else}
              <Eye size={14} />
            {/if}
          </button>
        </div>
      {/if}
    </div>
  </div>

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
      disabled={!serverHost.trim() || !serverModel.trim()}
      class="btn-primary flex-1 text-xs !py-2.5 font-bold cursor-pointer disabled:bg-none disabled:bg-[var(--surface-panel-alt)] disabled:border-[var(--border-line)] disabled:text-[var(--text-dim)] disabled:opacity-60 disabled:shadow-none disabled:cursor-not-allowed"
    >
      Continue
      <ChevronRight size={14} />
    </button>
  </div>
</div>
