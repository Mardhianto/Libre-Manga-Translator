import { DefaultConfig } from "../configs";
import { buildSiteRulePrompts, buildTranslationPrompts } from "../prompts";
import {
  buildLmStudioTextRequest,
  buildOllamaChatRequest,
  buildOpenAITextRequest,
  resolveChatEndpoint,
  type ResponseFormatMode,
  type ServerConfig,
} from "./schemas";
import {
  budgetVerdict,
  estimateTokens,
  resolveNumCtx,
  resolveOutputCap,
  type BudgetVerdict,
} from "./prompt-budget";import {
  attachDiagnostics,
  clipRawResponse,
  isTranslationValidationError,
  mergeRunInfo,
  parseLlmJson,
  promptChars,
  validateTranslationResult,
  type LlmRunInfo,
} from "./validator";

export type { ServerConfig } from "./schemas";

export { parseLlmJson };

interface CallServerOptions {
  schema?: object;
  schemaName?: string;
  /** Reuse the format that already worked instead of retrying a rejected one. */
  startMode?: ResponseFormatMode;
  /** Appended to the user prompt for the single correction round-trip. */
  correction?: string;
  /** Accumulates one entry per HTTP round-trip (LMT-032). */
  calls?: LlmRunInfo[];
  /** Cancels the in-flight request when the job deadline passes (LMT-010). */
  signal?: AbortSignal;
  /** Answer budget from `resolveOutputCap(boxes)` (LMT-024). */
  maxTokens?: number;
  /** Context window to request; native Ollama only. */
  numCtx?: number;
}

interface ServerResponse {
  data: any;
  format: ResponseFormatMode;
  /** Raw answer + stop reason for the call that produced `data`. */
  info: LlmRunInfo;
}

const FORMAT_CHAINS: Record<ServerConfig["serverSchema"], ResponseFormatMode[]> = {
  openai: ["json_schema", "json_object"],
  lmstudio: ["json_schema", "json_object", "none"],
  // Native `format` takes the schema object directly; the fallbacks cover
  // servers whose grammar compiler rejects it (LMT-024).
  ollama: ["json_schema", "json_object", "none"],
};

/**
 * Marks a failure a second attempt cannot fix.
 *
 * A malformed or cut-off answer is a property of the request/answer pair: the
 * same prompt against the same `max_tokens` reproduces it. Retrying it burns a
 * second inference and hides the truncation the Debug export is meant to show
 * (LMT-027).
 */
function markNonRetryable<T>(error: T): T {
  if (error && typeof error === "object") {
    (error as { lmtNoRetry?: boolean }).lmtNoRetry = true;
  }
  return error;
}

function isNonRetryable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { lmtNoRetry?: unknown }).lmtNoRetry === true;
}

/**
 * Local copy of `utils.isAbortError`: importing `utils` here would drag ONNX
 * Runtime into the service-worker bundle for one string check.
 */
function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ((error as { name?: unknown }).name === "AbortError") return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /abort/i.test(message);
}

/**
 * Only transport failures and transient server states deserve another attempt.
 * 4xx means the request itself is wrong (auth, model name, unsupported
 * response_format), 429 is rate limiting, and 5xx is the server's problem.
 */
function isRetryableRequestError(error: unknown): boolean {
  if (isNonRetryable(error)) return false;
  if (isAbortError(error)) return false;
  const status = (error as Error & { status?: number } | undefined)?.status;
  if (status === undefined) return true; // fetch threw: network/DNS/socket
  return status === 429 || status >= 500;
}

/** Sleep that gives up immediately when the job is cancelled. */
function delayUnlessAborted(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Request-side knobs that survive format/capability fallbacks. */
interface RequestScope {
  /** Answer budget; becomes `num_predict` / `max_tokens`. */
  maxTokens: number;
  /** Context window; native Ollama only (the OpenAI path cannot set it). */
  numCtx: number;
  /** Whether to ask the provider to skip reasoning tokens. */
  disableThinking: boolean;
  /** Prompt-size verdict, stamped onto every answered round-trip (LMT-024). */
  verdict?: BudgetVerdict;
  /** One-shot fallback state: a field the server rejected with a 400. */
  dropThink?: boolean;
  dropReasoningEffort?: boolean;
}

/** Does an error body look like "this server does not know that field"? */
function mentionsField(error: unknown, field: RegExp): boolean {
  const message = (error as { message?: unknown } | undefined)?.message;
  return typeof message === "string" && field.test(message);
}

async function requestOnce(
  systemPrompt: string,
  userPrompt: string,
  config: ServerConfig,
  schema: object | undefined,
  schemaName: string,
  mode: ResponseFormatMode,
  scope: RequestScope,
  retryCount = 0,
  signal?: AbortSignal,
): Promise<{ data: any; info: LlmRunInfo }> {
  // An aborted job must not open a socket at all: `throwIfAborted` rethrows the
  // caller's reason (a DOMException carrying the stage name), which is the text
  // the user should see rather than a generic network error.
  signal?.throwIfAborted();

  const url = resolveChatEndpoint(config.serverHost, config.serverSchema);

  const budget = { maxTokens: scope.maxTokens };
  const body =
    config.serverSchema === "ollama"
      ? buildOllamaChatRequest(
          config.serverModel,
          systemPrompt,
          userPrompt,
          {
            numCtx: scope.numCtx,
            numPredict: scope.maxTokens,
            temperature: config.temperature,
            // A model without a thinking template rejects `think`, so the
            // rejected-400 fallback clears it per request.
            disableThinking: !scope.dropThink,
          },
          schema,
          mode,
        )
      : config.serverSchema === "lmstudio"
        ? buildLmStudioTextRequest(
            config.serverModel,
            systemPrompt,
            userPrompt,
            config.temperature,
            schema,
            mode,
            schemaName,
            budget,
          )
        : buildOpenAITextRequest(
            config.serverModel,
            systemPrompt,
            userPrompt,
            config.temperature,
            schema,
            mode,
            schemaName,
            budget,
            scope.disableThinking && !scope.dropReasoningEffort,
          );

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.useServerApiKey && config.serverApiKey) {
    headers["Authorization"] = `Bearer ${config.serverApiKey}`;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const err = new Error(
        `API ${response.status}: ${(await response.text()).substring(0, 500)}`,
      ) as Error & { status?: number };
      err.status = response.status;
      throw err;
    }

    const data = await response.json();

    // Three schemas, three shapes. Native Ollama reports the answer under
    // `message` and its own token counts (LMT-024); the other two keep their
    // existing paths untouched.
    const native = config.serverSchema === "ollama";
    const content = native
      ? data?.message?.content
      : config.serverSchema === "lmstudio"
        ? data?.output?.[0]?.content
        : data?.choices?.[0]?.message?.content;

    if (!content) {
      // A thinking model on the OpenAI path returns `reasoning` and an empty
      // `content`. Naming that explicitly beats "Empty response".
      const reasoning = data?.choices?.[0]?.message?.reasoning;
      if (typeof reasoning === "string" && reasoning.length > 0) {
        throw markNonRetryable(
          new Error(
            "Server returned reasoning text but no answer — the model is thinking, and its reasoning used the whole token budget. Use the Ollama (native) schema with thinking off.",
          ),
        );
      }
      throw new Error("Empty response from server");
    }

    // Both schemas report a stop reason; OpenAI nests it per choice, LM Studio
    // puts it on the item. "length" is the truncation signal (LMT-032).
    const finishReason: string | undefined = native
      ? data?.done_reason
      : config.serverSchema === "lmstudio"
        ? (data?.output?.[0]?.finish_reason ?? data?.stats?.finish_reason)
        : data?.choices?.[0]?.finish_reason;

    const info: LlmRunInfo = {
      rawResponse: clipRawResponse(content),
      finishReason:
        typeof finishReason === "string" ? finishReason : undefined,
      promptChars: promptChars(systemPrompt, userPrompt),
      promptTokens: estimateTokens(systemPrompt, userPrompt),
      // Ground truth from the server: the number the estimate is measured
      // against. Absent on OpenAI/LM Studio.
      promptEvalCount:
        typeof data?.prompt_eval_count === "number"
          ? data.prompt_eval_count
          : undefined,
      numCtx: native ? scope.numCtx : undefined,
      thinkingDisabled: native
        ? !scope.dropThink
        : scope.disableThinking && !scope.dropReasoningEffort,
      ...(scope.verdict ? { budgetLevel: scope.verdict.level, budgetWarning: scope.verdict.message } : {}),
    };

    try {
      return { data: parseLlmJson(content), info };
    } catch (parseError) {
      // Keep the raw cut-off/malformed answer on the error: if this attempt is
      // the one that finally fails, that text is the entire diagnosis. Marking
      // it non-retryable stops the identical request being sent twice.
      throw markNonRetryable(attachDiagnostics(parseError, info));
    }
  } catch (err) {
    // A field the server does not understand is not a bad request on our side:
    // drop it once and try again before falling back to another format.
    if (
      (err as { status?: number }).status === 400 &&
      !isNonRetryable(err) &&
      !isAbortError(err)
    ) {
      if (
        !scope.dropThink &&
        config.serverSchema === "ollama" &&
        mentionsField(err, /think/i)
      ) {
        console.warn("[server] server rejected `think` — resending without it");
        return requestOnce(
          systemPrompt,
          userPrompt,
          config,
          schema,
          schemaName,
          mode,
          { ...scope, dropThink: true },
          retryCount,
          signal,
        );
      }
      if (
        !scope.dropReasoningEffort &&
        scope.disableThinking &&
        config.serverSchema === "openai" &&
        mentionsField(err, /reasoning_effort|reasoning\.effort/i)
      ) {
        console.warn(
          "[server] server rejected `reasoning_effort` — resending without it",
        );
        return requestOnce(
          systemPrompt,
          userPrompt,
          config,
          schema,
          schemaName,
          mode,
          { ...scope, dropReasoningEffort: true },
          retryCount,
          signal,
        );
      }
    }

    if (
      !isRetryableRequestError(err) ||
      retryCount >= DefaultConfig.serverMaxRetries
    ) {
      throw err;
    }

    const waited = await delayUnlessAborted(
      DefaultConfig.serverRetryDelayMs * (retryCount + 1),
      signal,
    );
    if (!waited) throw err;

    return requestOnce(
      systemPrompt,
      userPrompt,
      config,
      schema,
      schemaName,
      mode,
      scope,
      retryCount + 1,
      signal,
    );
  }
}

/**
 * POST one prompt and degrade the response format only when the server rejects
 * the format itself (400/422). Transport errors keep their own retry, and
 * auth/not-found/rate-limit errors never trigger a silent downgrade.
 */
async function callServer(
  systemPrompt: string,
  userPrompt: string,
  config: ServerConfig,
  options: CallServerOptions = {},
): Promise<ServerResponse> {
  const chain = options.schema
    ? FORMAT_CHAINS[config.serverSchema]
    : config.serverSchema === "ollama"
      ? (["none"] as ResponseFormatMode[])
      : config.serverSchema === "lmstudio"
        ? (["none"] as ResponseFormatMode[])
        : (["json_object"] as ResponseFormatMode[]);

  const startIndex = options.startMode
    ? Math.max(0, chain.indexOf(options.startMode))
    : 0;
  const modes = chain.slice(startIndex);
  const prompt = options.correction
    ? `${userPrompt}\n\nCORRECTION: ${options.correction}\nReturn the full corrected JSON now.`
    : userPrompt;
  const schemaName = options.schemaName ?? "manga_translation";

  // Size the request before it is sent (LMT-024). The correction prompt is
  // longer than the page prompt, so it is measured separately rather than
  // inheriting the first call's numbers.
  const promptTokens = estimateTokens(systemPrompt, prompt);
  const outputCap =
    options.maxTokens ?? DefaultConfig.serverMaxOutputTokens;
  const numCtx = resolveNumCtx({
    promptTokens,
    outputCap,
    // `resolveNumCtx` grows past the request when the page needs it, so the
    // configured default is a floor, never a ceiling that truncates.
    requested: options.numCtx ?? config.numCtx ?? DefaultConfig.serverNumCtx,
  });
  const verdict = budgetVerdict({ promptTokens, outputCap, numCtx });
  if (verdict.level !== "ok") {
    console.warn(`[server] prompt budget: ${verdict.message}`);
  }

  const scope: RequestScope = {
    maxTokens: outputCap,
    numCtx,
    disableThinking: config.disableThinking === true,
    verdict,
  };

  let lastError: unknown;

  for (let i = 0; i < modes.length; i++) {
    const mode = modes[i];
    try {
      const { data, info } = await requestOnce(
        systemPrompt,
        prompt,
        config,
        options.schema,
        schemaName,
        mode,
        scope,
        0,
        options.signal,
      );
      // Count only answered round-trips: a 400 format rejection spent no
      // inference, so counting it as a call would overstate page cost.
      options.calls?.push(info);
      if (i > 0) {
        console.warn(`[server] response_format fallback in use: ${mode}`);
      }
      return { data, format: mode, info };
    } catch (err) {
      const status = (err as Error & { status?: number }).status;
      const canFallback =
        (status === 400 || status === 422) && i < modes.length - 1;

      if (canFallback) {
        console.warn(
          `[server] response_format ${mode} rejected (HTTP ${status}) — retrying with ${modes[i + 1]}`,
        );
        lastError = err;
        continue;
      }

      // Surface the diagnostics a caller already accumulated (LMT-032): a
      // failure must still explain what the model was sent and returned.
      throw options.calls?.length
        ? attachDiagnostics(err, mergeRunInfo(options.calls))
        : err;
    }
  }

  throw lastError;
}

export async function translateWithServer(
  ocrResults: string[],
  targetLang: string,
  sourceLang: string,
  seriesContext: SeriesContext | undefined,
  config: ServerConfig,
  /** Auto-Detect only: the script the OCR gate identified (LMT-030). */
  detectedLabel?: string | null,
  /** Cancels the in-flight request at the job deadline (LMT-010). */
  signal?: AbortSignal,
): Promise<TranslateResult> {
  if (!ocrResults || ocrResults.length === 0) {
    return { translations: [] };
  }

  signal?.throwIfAborted();

  const { systemPrompt, userPrompt, schema } = buildTranslationPrompts(
    ocrResults,
    targetLang,
    sourceLang,
    seriesContext,
    detectedLabel,
  );

  // One list for the whole page: a format fallback and the correction round
  // both cost a round-trip and must show up in `llmCalls` (LMT-032).
  const calls: LlmRunInfo[] = [];

  // Answer budget scales with the page (LMT-024): a constant 4096 was spent
  // before the JSON reached box 40.
  const maxTokens = resolveOutputCap(ocrResults.length);

  let response = await callServer(systemPrompt, userPrompt, config, {
    schema,
    schemaName: "manga_translation",
    calls,
    signal,
    maxTokens,
  });

  try {
    return validateTranslationResult(response.data, ocrResults.length, {
      sourceTexts: ocrResults,
      sourceLang,
      targetLang,
      run: mergeRunInfo(calls),
    });
  } catch (error) {
    if (!isTranslationValidationError(error)) throw error;

    console.warn(
      `[server] validation failed (${error.code}): ${error.message} — requesting correction`,
    );

    response = await callServer(systemPrompt, userPrompt, config, {
      schema,
      schemaName: "manga_translation",
      startMode: response.format,
      correction: error.message,
      calls,
      signal,
      maxTokens,
    });

    return validateTranslationResult(response.data, ocrResults.length, {
      sourceTexts: ocrResults,
      sourceLang,
      targetLang,
      run: mergeRunInfo(calls),
    });
  }
}

export async function makeSiteRuleWithServer(
  title: string,
  path: string,
  config: ServerConfig,
  signal?: AbortSignal,
): Promise<AIGeneratedRule> {
  const { systemPrompt, userPrompt, schema } = buildSiteRulePrompts(title, path);
  const response = await callServer(systemPrompt, userPrompt, config, {
    schema,
    schemaName: "site_rule",
    signal,
  });
  return response.data;
}

export interface ServerProbeResult {
  success: boolean;
  models?: string[];
  error?: string;
  /**
   * Which server actually answered. `ollama` means a native `/api/version`
   * responded, so the caller can offer the schema upgrade that fixes prompt
   * truncation (LMT-024).
   */
  provider?: "ollama" | "openai-compatible";
  /** True when the config still uses the truncating OpenAI path on Ollama. */
  suggestNativeOllama?: boolean;
}

/** Origin of a stored host, dropping `/v1` or `/api` suffixes. */
function originOf(host: string): string {
  return (host ?? "").trim().replace(/\/+$/, "").replace(/\/(?:v1|api)$/i, "");
}

async function fetchOllamaTags(origin: string): Promise<string[] | null> {
  try {
    const response = await fetch(`${origin}/api/tags`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) return null;
    const data = await response.json();
    const models = Array.isArray(data?.models)
      ? data.models
          .map((m: { name?: string; model?: string }) => m?.name ?? m?.model)
          .filter((id: unknown): id is string => typeof id === "string")
      : [];
    return models;
  } catch {
    return null;
  }
}

export async function testServerConnection(
  config: ServerConfig,
): Promise<ServerProbeResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.useServerApiKey && config.serverApiKey) {
    headers["Authorization"] = `Bearer ${config.serverApiKey}`;
  }

  // Native schema: probe the same API family the translate call will use, so a
  // green test means the real endpoint answered (LMT-024).
  if (config.serverSchema === "ollama") {
    const models = await fetchOllamaTags(originOf(config.serverHost));
    if (models === null) {
      return {
        success: false,
        error:
          "No Ollama server answered at /api/tags. Check that `ollama serve` is running and OLLAMA_ORIGINS allows this extension.",
        provider: "ollama",
      };
    }
    if (
      config.serverModel &&
      models.length > 0 &&
      !models.some(
        (name) =>
          name === config.serverModel ||
          name.split(":")[0] === config.serverModel.split(":")[0],
      )
    ) {
      // Not fatal: Ollama pulls on first use in some setups, and a remote
      // server may expose a name this list does not show.
      return {
        success: true,
        models,
        provider: "ollama",
        error: `Connected, but "${config.serverModel}" was not in /api/tags.`,
      };
    }
    return { success: true, models, provider: "ollama" };
  }

  const baseUrl = config.serverHost.endsWith("/")
    ? config.serverHost
    : config.serverHost + "/";
  const url = `${baseUrl}models`;

  try {
    const response = await fetch(url, { method: "GET", headers });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    const models: string[] =
      data?.data?.map((m: { id?: string }) => m?.id).filter(Boolean) ??
      (Array.isArray(data?.models) ? data.models : []);

    // Detection runs on the same host: `/api/tags` is Ollama-only and costs one
    // local request. Seeing it while the config still uses `openai` is exactly
    // the silent-truncation case, so report it instead of staying quiet.
    const nativeModels = await fetchOllamaTags(originOf(config.serverHost));
    if (nativeModels !== null && nativeModels.length > 0) {
      return {
        success: true,
        models: models.length > 0 ? models : nativeModels,
        provider: "ollama",
        suggestNativeOllama: true,
      };
    }

    return { success: true, models, provider: "openai-compatible" };
  } catch (error) {
    return {
      success: false,
      error: (error as Error).message,
    };
  }
}
