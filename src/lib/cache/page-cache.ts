import { DefaultConfig, normalizeDetectionModel } from "../configs";
import { PROMPT_VERSION } from "../prompts";

export { PROMPT_VERSION };

/** Ambient storage provided by WXT runtime. */
declare const storage: any;

/**
 * Builds a deterministic fingerprint of the translation pipeline settings.
 * If any of these change, a previously cached translation is considered stale
 * and the page must be re-translated.
 */
export function buildFingerprint(
  cfg: Record<string, any>,
): PageCacheFingerprint {
  const currentMode = cfg["sync:current-mode"] ?? DefaultConfig.currentMode;
  const llmModel =
    currentMode === "api"
      ? (cfg["local:server-model"] ?? DefaultConfig.serverModel)
      : currentMode === "gemini"
        ? (cfg["sync:gemini-model"] ?? DefaultConfig.geminiModels[4].id)
        : (cfg["sync:llm-model"] ?? DefaultConfig.llmModels[0].id);

  return {
    sourceLang: cfg["sync:source-lang"] ?? DefaultConfig.sourceLang,
    targetLang: cfg["sync:target-lang"] ?? DefaultConfig.targetLang,
    ocrEngine: cfg["sync:ocr-engine"] ?? DefaultConfig.ocrEngine,
    ocrMinConfidence:
      typeof cfg["sync:ocr-min-confidence"] === "number"
        ? cfg["sync:ocr-min-confidence"]
        : DefaultConfig.ocrMinConfidence,
    detectionModel: normalizeDetectionModel(
      cfg["sync:detection-model"] ?? DefaultConfig.detectionModels[0].id,
    ),
    llmModel: String(llmModel ?? ""),
    temperature:
      typeof cfg["sync:llm-temperature"] === "number"
        ? cfg["sync:llm-temperature"]
        : DefaultConfig.llmTemperature,
    promptVersion: PROMPT_VERSION,
  };
}

/**
 * Reads all relevant settings from storage and constructs the current fingerprint.
 */
export async function readCurrentFingerprint(
  storageInstance = typeof storage !== "undefined" ? storage : undefined,
): Promise<PageCacheFingerprint> {
  if (!storageInstance) {
    return buildFingerprint({});
  }
  const items = await storageInstance.getItems([
    "sync:current-mode",
    "sync:source-lang",
    "sync:target-lang",
    "sync:ocr-engine",
    "sync:ocr-min-confidence",
    "sync:detection-model",
    "sync:llm-model",
    "sync:llm-temperature",
    "local:server-model",
    "sync:gemini-model",
  ]);
  const cfg = Object.fromEntries(items.map((i: any) => [i.key, i.value]));
  return buildFingerprint(cfg);
}

/**
 * Returns true if the cached entry has a valid fingerprint that matches
 * the current settings.
 *
 * An entry with a missing fingerprint (legacy cache from older versions)
 * is considered a cache miss so that it safely gets updated.
 */
export function isCacheValid(
  cache: PageCache | null | undefined,
  current: PageCacheFingerprint,
): cache is PageCache {
  if (!cache || !cache.fingerprint) return false;
  const fp = cache.fingerprint;
  return (
    fp.sourceLang === current.sourceLang &&
    fp.targetLang === current.targetLang &&
    fp.ocrEngine === current.ocrEngine &&
    fp.ocrMinConfidence === current.ocrMinConfidence &&
    fp.detectionModel === current.detectionModel &&
    fp.llmModel === current.llmModel &&
    fp.temperature === current.temperature &&
    fp.promptVersion === current.promptVersion
  );
}

/**
 * Deletes all stored page translation caches from local storage.
 */
export async function clearPageCache(
  storageInstance = typeof storage !== "undefined" ? storage : undefined,
): Promise<{ clearedCount: number }> {
  if (!storageInstance) return { clearedCount: 0 };
  try {
    const data = await storageInstance.snapshot("local");
    const keysToRemove: string[] = [];
    for (const key of Object.keys(data)) {
      if (key.startsWith("page-cache-") || key.startsWith("local:page-cache-")) {
        keysToRemove.push(key.startsWith("local:") ? key : `local:${key}`);
      }
    }
    if (keysToRemove.length > 0) {
      await storageInstance.removeItems(keysToRemove as any);
    }
    return { clearedCount: keysToRemove.length };
  } catch (err) {
    console.warn("LMT: failed to clear page cache:", err);
    return { clearedCount: 0 };
  }
}
