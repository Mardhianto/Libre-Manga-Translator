import type { MLCEngine } from "@mlc-ai/web-llm";
import { DefaultConfig, defaultLlmModelId, normalizeLlmModel } from "./configs";
import { createLlmEngine } from "./llm-engine";
import { buildSiteRulePrompts, buildTranslationPrompts } from "./prompts";
import { parseLlmJson, isTranslationValidationError, validateTranslationResult } from "./server/validator";

let globalEngine: MLCEngine | null = null;
let currentlyLoadedModel: string | null = null;

export async function translateLocal(
  ocrResults: string[],
  targetLang: string,
  sourceLang: string,
  seriesContext?: SeriesContext,
  model = defaultLlmModelId(),
  temperature = DefaultConfig.llmTemperature,
): Promise<TranslateResult> {
  const resolvedModel = normalizeLlmModel(model);
  if (!ocrResults || ocrResults.length === 0) {
    return { translations: [] };
  }

  const { systemPrompt, userPrompt, schema } = buildTranslationPrompts(
    ocrResults,
    targetLang,
    sourceLang,
    seriesContext,
  );

  const raw = await runLLMModel(
    systemPrompt,
    userPrompt,
    schema,
    resolvedModel,
    temperature,
  );

  try {
    return validateTranslationResult(raw, ocrResults.length, {
      sourceTexts: ocrResults,
      sourceLang,
      targetLang,
    });
  } catch (error) {
    if (!isTranslationValidationError(error)) throw error;

    console.warn(
      `[webllm] validation failed (${error.code}): ${error.message} — requesting correction`,
    );
    const corrected = await runLLMModel(
      systemPrompt,
      `${userPrompt}\n\nCORRECTION: ${error.message}\nReturn the full corrected JSON now.`,
      schema,
      resolvedModel,
      temperature,
    );
    return validateTranslationResult(corrected, ocrResults.length, {
      sourceTexts: ocrResults,
      sourceLang,
      targetLang,
    });
  }
}

export async function makeSiteRuleLocal(
  title: string,
  path: string,
  model = defaultLlmModelId(),
  temperature = DefaultConfig.llmTemperature,
): Promise<AIGeneratedRule> {
  const resolvedModel = normalizeLlmModel(model);
  const { systemPrompt, userPrompt, schema } = buildSiteRulePrompts(
    title,
    path,
  );

  const raw = await runLLMModel(
    systemPrompt,
    userPrompt,
    schema,
    resolvedModel,
    temperature,
  );
  return raw.parsed as AIGeneratedRule;
}

async function runLLMModel(
  systemPrompt: string,
  userPrompt: string,
  schema: object,
  model: string,
  temperature: number,
) {
  if (!globalEngine) {
    globalEngine = await createLlmEngine();
  }

  if (currentlyLoadedModel !== model) {
    await globalEngine.reload(model);
    currentlyLoadedModel = model;
  }

  const t0 = performance.now();
  const reply = await globalEngine.chatCompletion({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature,
    response_format: {
      type: "json_object",
      schema: JSON.stringify(schema),
    },
  });
  const totalMs = performance.now() - t0;

  const content = reply.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Local LLM returned empty response");
  }

  try {
    const parsed = parseLlmJson(content);
    return { parsed, llmPerf: extractWebLlmPerf(reply, totalMs) };
  } catch (error) {
    console.error("Failed to parse LLM output:", content);
    throw new Error(`Local LLM generated invalid JSON: ${(error as Error).message}`);
  }
}

/** Token stats from WebLLM usage (prefill/decode rates live in extra). */
function extractWebLlmPerf(
  reply: { usage?: { prompt_tokens?: number; completion_tokens?: number; extra?: { prefill_tokens_per_s?: number; decode_tokens_per_s?: number } } },
  totalMs: number,
): LlmPerf | undefined {
  const usage = reply?.usage;
  if (!usage) return undefined;
  const promptTps = usage.extra?.prefill_tokens_per_s;
  const genTps = usage.extra?.decode_tokens_per_s;
  return {
    ...(usage.prompt_tokens !== undefined
      ? { promptTokens: usage.prompt_tokens }
      : {}),
    ...(usage.completion_tokens !== undefined
      ? { completionTokens: usage.completion_tokens }
      : {}),
    ...(promptTps !== undefined ? { promptTps } : {}),
    ...(genTps !== undefined ? { genTps } : {}),
    totalMs,
  };
}
