export interface ServerConfig {
  serverHost: string;
  /**
   * `ollama` is the native `/api/chat` schema: the only one that can carry
   * `options.num_ctx` and `think`, both of which the OpenAI-compatible path
   * silently ignores (LMT-024).
   */
  serverSchema: "openai" | "lmstudio" | "ollama";
  serverModel: string;
  useServerApiKey: boolean;
  serverApiKey: string;
  temperature: number;
  /** Context window to request. `undefined` uses `DefaultConfig.serverNumCtx`. */
  numCtx?: number;
  /** Ask the model not to emit reasoning tokens. OpenAI path uses `reasoning_effort`. */
  disableThinking?: boolean;
}

export type ResponseFormatMode = "json_schema" | "json_object" | "none";

/**
 * How much answer budget the request may use. Supplied by the caller from
 * `resolveOutputCap(boxes)` so a 40-box page is not capped at the same 4096 as
 * a 3-box page (LMT-024).
 */
export interface OutputBudget {
  maxTokens: number;
}

function jsonSchemaFormat(schema: object, name: string) {
  return {
    type: "json_schema" as const,
    json_schema: {
      name,
      strict: true,
      schema,
    },
  };
}

export function buildOpenAITextRequest(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  temperature: number,
  schema?: object,
  mode: ResponseFormatMode = schema ? "json_schema" : "json_object",
  schemaName = "manga_translation",
  budget?: OutputBudget,
  /** Verified live: the only thinking lever `/v1` honours on Ollama. */
  disableThinking = false,
) {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature,
    max_tokens: budget?.maxTokens ?? 4096,
    stream: false,
  };

  if (disableThinking) {
    // Ollama 0.40 accepts this on /v1 and stops emitting `reasoning`;
    // `think`, `chat_template_kwargs` and `enable_thinking` are all ignored
    // there. Servers that reject the field are handled by a one-shot
    // capability fallback in `main.ts`.
    body.reasoning_effort = "none";
  }

  if (mode === "json_schema" && schema) {
    body.response_format = jsonSchemaFormat(schema, schemaName);
  } else if (mode === "json_object") {
    body.response_format = { type: "json_object" };
  }

  return body;
}

export function buildLmStudioTextRequest(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  temperature: number,
  schema?: object,
  mode: ResponseFormatMode = schema ? "json_schema" : "none",
  schemaName = "manga_translation",
  budget?: OutputBudget,
) {
  const body: Record<string, unknown> = {
    model,
    input: [{ type: "text", content: userPrompt }],
    system_prompt: systemPrompt,
    temperature,
    max_output_tokens: budget?.maxTokens ?? 4096,
    stream: false,
  };

  // The native /api/v1/chat endpoint does not document response_format. Send
  // it when a schema is available and let callServer fall back on 400/422.
  if (mode === "json_schema" && schema) {
    body.response_format = jsonSchemaFormat(schema, schemaName);
  } else if (mode === "json_object") {
    body.response_format = { type: "json_object" };
  }

  return body;
}

export interface OllamaChatRequestOptions {
  numCtx: number;
  /** Answer budget; maps to `options.num_predict`. */
  numPredict: number;
  temperature: number;
  disableThinking?: boolean;
}

/**
 * Native Ollama chat body (LMT-024).
 *
 * Differences from `/v1/chat/completions` that matter:
 * - `options.num_ctx` is honoured; on `/v1` it is dropped and the prompt is cut.
 * - `think: false` is honoured; on `/v1` reasoning tokens eat the answer cap.
 * - `format` takes the schema object directly, so no `response_format`
 *   wrapper and no format-chain fallback is needed in the common case.
 */
export function buildOllamaChatRequest(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  options: OllamaChatRequestOptions,
  schema?: object,
  mode: ResponseFormatMode = schema ? "json_schema" : "json_object",
) {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    stream: false,
    // Keeps the weights (and the KV cache) resident between pages instead of
    // paying a cold load on every translate.
    keep_alive: "5m",
    options: {
      temperature: options.temperature,
      num_ctx: options.numCtx,
      num_predict: options.numPredict,
    },
  };

  if (options.disableThinking !== false) {
    body.think = false;
  }

  if (mode === "json_schema" && schema) {
    body.format = schema;
  } else if (mode === "json_object") {
    body.format = "json";
  }

  return body;
}

/**
 * Endpoint path for a schema.
 *
 * `openai` and `lmstudio` are paths under the stored host (which already ends
 * in `/v1` or `/api/v1`). Ollama's native endpoint is absolute from the origin,
 * so it is resolved against the origin and the stored `/v1` suffix is dropped -
 * both `http://127.0.0.1:11434/v1` and `http://127.0.0.1:11434` reach
 * `/api/chat` (LMT-024).
 */
export function resolveChatEndpoint(
  host: string,
  schema: ServerConfig["serverSchema"],
): string {
  const trimmed = (host ?? "").trim().replace(/\/+$/, "");

  if (schema === "ollama") {
    const origin = trimmed.replace(/\/(?:v1|api)$/i, "");
    return `${origin}/api/chat`;
  }

  const path = schema === "lmstudio" ? "chat" : "chat/completions";
  return `${trimmed}/${path}`;
}
