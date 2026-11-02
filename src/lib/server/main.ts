import { DefaultConfig } from "../configs";
import { buildSiteRulePrompts, buildTranslationPrompts } from "../prompts";
import {
  buildLmStudioTextRequest,
  buildOpenAITextRequest,
  type ResponseFormatMode,
  type ServerConfig,
} from "./schemas";
import {
  isTranslationValidationError,
  parseLlmJson,
  validateTranslationResult,
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
}

interface ServerResponse {
  data: any;
  format: ResponseFormatMode;
}

const FORMAT_CHAINS: Record<ServerConfig["serverSchema"], ResponseFormatMode[]> = {
  openai: ["json_schema", "json_object"],
  lmstudio: ["json_schema", "json_object", "none"],
};

async function requestOnce(
  systemPrompt: string,
  userPrompt: string,
  config: ServerConfig,
  schema: object | undefined,
  schemaName: string,
  mode: ResponseFormatMode,
  retryCount = 0,
): Promise<any> {
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

    return parseLlmJson(content);
  } catch (err) {
    const status = (err as Error & { status?: number }).status;
    const isClientError = status !== undefined && status >= 400 && status < 500;

    if (!isClientError && retryCount < DefaultConfig.serverMaxRetries) {
      await new Promise((r) =>
        setTimeout(r, DefaultConfig.serverRetryDelayMs * (retryCount + 1)),
      );
      return requestOnce(
        systemPrompt,
        userPrompt,
        config,
        schema,
        schemaName,
        mode,
        retryCount + 1,
      );
    }

    throw err;
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
      const data = await requestOnce(
        systemPrompt,
        prompt,
        config,
        options.schema,
        schemaName,
        mode,
      );
      if (i > 0) {
        console.warn(`[server] response_format fallback in use: ${mode}`);
      }
      return { data, format: mode };
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

      throw err;
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
): Promise<TranslateResult> {
  if (!ocrResults || ocrResults.length === 0) {
    return { translations: [] };
  }

  const { systemPrompt, userPrompt, schema } = buildTranslationPrompts(
    ocrResults,
    targetLang,
    sourceLang,
    seriesContext,
  );

  let response = await callServer(systemPrompt, userPrompt, config, {
    schema,
    schemaName: "manga_translation",
  });

  try {
    return validateTranslationResult(response.data, ocrResults.length, {
      sourceTexts: ocrResults,
      sourceLang,
      targetLang,
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
    });

    return validateTranslationResult(response.data, ocrResults.length, {
      sourceTexts: ocrResults,
      sourceLang,
      targetLang,
    });
  }
}

export async function makeSiteRuleWithServer(
  title: string,
  path: string,
  config: ServerConfig,
): Promise<AIGeneratedRule> {
  const { systemPrompt, userPrompt, schema } = buildSiteRulePrompts(title, path);
  const response = await callServer(systemPrompt, userPrompt, config, {
    schema,
    schemaName: "site_rule",
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
