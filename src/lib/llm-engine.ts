import type { AppConfig, MLCEngine, MLCEngineConfig } from "@mlc-ai/web-llm";
import { DefaultConfig } from "./configs";

// Dynamic-only: @mlc-ai/web-llm is a multi-MB prebundled file. A static
// import would bake it into shared initial chunks and break the
// 2MB-per-.js Firefox AMO limit. createLlmEngine loads it lazily, and
// import.meta.env.FIREFOX dead-branch-eliminates the chunk entirely from
// Firefox builds (which use wllama instead).
const loadWebLlm = () =>
  import.meta.env.FIREFOX
    ? Promise.reject(
        new Error("web-llm backend excluded from Firefox builds"),
      )
    : import("@mlc-ai/web-llm");

/**
 * Build the WebLLM AppConfig: prebuilt model list + per-model ChatConfig
 * overrides from DefaultConfig.llmModelOverrides (merged onto each
 * ModelRecord.overrides, applied on top of the model's downloaded
 * mlc-chat-config.json at reload time).
 */
async function buildLlmAppConfig(): Promise<AppConfig> {
  const { prebuiltAppConfig } = await loadWebLlm();
  return {
    ...prebuiltAppConfig,
    model_list: prebuiltAppConfig.model_list.map((rec) => {
      const patch = DefaultConfig.llmModelOverrides[rec.model_id];
      return patch ? { ...rec, overrides: { ...rec.overrides, ...patch } } : rec;
    }),
  };
}

/**
 * Single async constructor for local LLM engines — never `new MLCEngine(…)`
 * directly. Ensures per-model overrides always apply and the heavy vendor
 * chunk loads lazily.
 */
export { buildLlmAppConfig as llmAppConfig };
export async function createLlmEngine(
  config: Omit<MLCEngineConfig, "appConfig"> = {},
): Promise<MLCEngine> {
  const { MLCEngine } = await loadWebLlm();
  const appConfig = await buildLlmAppConfig();
  return new MLCEngine({ ...config, appConfig });
}
