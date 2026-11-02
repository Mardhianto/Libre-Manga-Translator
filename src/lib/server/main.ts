import { DefaultConfig } from "../configs";
import { buildSiteRulePrompts, buildTranslationPrompts } from "../prompts";
import {
  buildLmStudioTextRequest,
  buildOpenAITextRequest,
  type ResponseFormatMode,
  type ServerConfig,
} from "./schemas";
import {
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

async function requestOnce(
  systemPrompt: string,
  userPrompt: string,
  config: ServerConfig,
  schema: object | undefined,
  schemaName: string,
  mode: ResponseFormatMode,
  retryCount = 0,
  signal?: AbortSignal,
): Promise<{ data: any; info: LlmRunInfo }> {
  // An aborted job must not open a socket at all: `throwIfAborted` rethrows the
  // caller's reason (a DOMException carrying the stage name), which is the text
  // the user should see rather than a generic network error.
  signal?.throwIfAborted();

  const endpoint =
    config.serverSchema === "lmstudio"
      ? DefaultConfig.serverEndpoints.lmstudio
      : DefaultConfig.serverEndpoints.openai;

  const baseUrl = config.serverHost.endsWith("/")
    ? config.serverHost
    : config.serverHost + "/";
  const url = `${baseUrl}${endpoint}`;

  const body =
    config.serverSchema === "lmstudio"
      ? buildLmStudioTextRequest(
          config.serverModel,
          systemPrompt,
          userPrompt,
          config.temperature,
          schema,
          mode,
          schemaName,
        )
      : buildOpenAITextRequest(
          config.serverModel,
          systemPrompt,
          userPrompt,
          config.temperature,
          schema,
          mode,
          schemaName,
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
    const content =
      config.serverSchema === "lmstudio"
        ? data?.output?.[0]?.content
        : data?.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("Empty response from server");
    }

    // Both schemas report a stop reason; OpenAI nests it per choice, LM Studio
    // puts it on the item. "length" is the truncation signal (LMT-032).
    const finishReason: string | undefined =
      config.serverSchema === "lmstudio"
        ? (data?.output?.[0]?.finish_reason ?? data?.stats?.finish_reason)
        : data?.choices?.[0]?.finish_reason;

    const info: LlmRunInfo = {
      rawResponse: clipRawResponse(content),
      finishReason:
        typeof finishReason === "string" ? finishReason : undefined,
      promptChars: promptChars(systemPrompt, userPrompt),
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

  let response = await callServer(systemPrompt, userPrompt, config, {
    schema,
    schemaName: "manga_translation",
    calls,
    signal,
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

export async function testServerConnection(config: ServerConfig) {
  const baseUrl = config.serverHost.endsWith("/")
    ? config.serverHost
    : config.serverHost + "/";
  const url = `${baseUrl}models`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.useServerApiKey && config.serverApiKey) {
    headers["Authorization"] = `Bearer ${config.serverApiKey}`;
  }

  try {
    const response = await fetch(url, { method: "GET", headers });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    const models: string[] =
      data?.data?.map((m: { id?: string }) => m?.id).filter(Boolean) ??
      (Array.isArray(data?.models) ? data.models : []);
    return { success: true, models };
  } catch (error) {
    return {
      success: false,
      error: (error as Error).message,
    };
  }
}
