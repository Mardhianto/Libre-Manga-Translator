import type { MLCEngine } from "@mlc-ai/web-llm";
import { DefaultConfig, normalizeLlmModel } from "./configs";
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
  model = DefaultConfig.llmModels[0].id,
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
  model = DefaultConfig.llmModels[0].id,
  temperature = DefaultConfig.llmTemperature,
): Promise<AIGeneratedRule> {
  const resolvedModel = normalizeLlmModel(model);
  const { systemPrompt, userPrompt, schema } = buildSiteRulePrompts(
    title,
    path,
  );

  return await runLLMModel(
    systemPrompt,
    userPrompt,
    schema,
    resolvedModel,
    temperature,
  );
}

async function runLLMModel(
  systemPrompt: string,
  userPrompt: string,
  schema: object,
  model: string,
  temperature: number,
) {
  if (!globalEngine) {
    globalEngine = createLlmEngine();
  }

  if (currentlyLoadedModel !== model) {
    await globalEngine.reload(model);
    currentlyLoadedModel = model;
  }

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

  const content = reply.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Local LLM returned empty response");
  }

  try {
    return parseLlmJson(content);
  } catch (error) {
    console.error("Failed to parse LLM output:", content);
    throw new Error(`Local LLM generated invalid JSON: ${(error as Error).message}`);
  }
}
