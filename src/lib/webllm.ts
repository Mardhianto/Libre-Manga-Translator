import type { MLCEngine } from "@mlc-ai/web-llm";
import { DefaultConfig, normalizeLlmModel } from "./configs";
import { createLlmEngine } from "./llm-engine";
import { buildSiteRulePrompts, buildTranslationPrompts } from "./prompts";
import {
  attachDiagnostics,
  clipRawResponse,
  isTranslationValidationError,
  mergeRunInfo,
  parseLlmJson,
  promptChars,
  validateTranslationResult,
  type LlmRunInfo,
} from "./server/validator";

let globalEngine: MLCEngine | null = null;
let currentlyLoadedModel: string | null = null;

export async function translateLocal(
  ocrResults: string[],
  targetLang: string,
  sourceLang: string,
  seriesContext?: SeriesContext,
  model = DefaultConfig.llmModels[0].id,
  temperature = DefaultConfig.llmTemperature,
  /** Auto-Detect only: the script the OCR gate identified. */
  detectedLabel?: string | null,
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
    detectedLabel,
  );

  const calls: LlmRunInfo[] = [];
  let raw: any;
  try {
    const first = await runLLMModel(
      systemPrompt,
      userPrompt,
      schema,
      resolvedModel,
      temperature,
    );
    calls.push(first.info);
    raw = first.data;
  } catch (error) {
    throw attachDiagnostics(error, mergeRunInfo(calls));
  }

  try {
    return validateTranslationResult(raw, ocrResults.length, {
      sourceTexts: ocrResults,
      sourceLang,
      targetLang,
      run: mergeRunInfo(calls),
    });
  } catch (error) {
    if (!isTranslationValidationError(error)) throw error;

    console.warn(
      `[webllm] validation failed (${error.code}): ${error.message} — requesting correction`,
    );
    try {
      const corrected = await runLLMModel(
        systemPrompt,
        `${userPrompt}\n\nCORRECTION: ${error.message}\nReturn the full corrected JSON now.`,
        schema,
        resolvedModel,
        temperature,
      );
      calls.push(corrected.info);
      return validateTranslationResult(corrected.data, ocrResults.length, {
        sourceTexts: ocrResults,
        sourceLang,
        targetLang,
        run: mergeRunInfo(calls),
      });
    } catch (retryError) {
      throw attachDiagnostics(retryError, mergeRunInfo(calls));
    }
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

  const { data } = await runLLMModel(
    systemPrompt,
    userPrompt,
    schema,
    resolvedModel,
    temperature,
  );
  return data;
}

async function runLLMModel(
  systemPrompt: string,
  userPrompt: string,
  schema: object,
  model: string,
  temperature: number,
): Promise<{ data: any; info: LlmRunInfo }> {
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

  // WebLLM reports OpenAI-style `finish_reason`; "length" means the answer hit
  // `max_tokens` and was cut, which the Debug export must show (LMT-032).
  const info: LlmRunInfo = {
    rawResponse: clipRawResponse(content),
    finishReason: reply.choices[0]?.finish_reason,
    promptChars: promptChars(systemPrompt, userPrompt),
  };

  try {
    return { data: parseLlmJson(content), info };
  } catch (error) {
    console.error("Failed to parse LLM output:", content);
    // Keep the raw answer reachable: a parse failure is the one case where the
    // Debug export is the only way to see what the model actually wrote.
    throw attachDiagnostics(
      new Error(
        `Local LLM generated invalid JSON: ${(error as Error).message}`,
      ),
      info,
    );
  }
}
