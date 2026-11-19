import { describe, expect, it } from "bun:test";
import {
  PROMPT_VERSION,
  buildFingerprint,
  isCacheValid,
} from "../../src/lib/cache/page-cache";

describe("buildFingerprint", () => {
  it("builds a fingerprint with default fallbacks", () => {
    const fp = buildFingerprint({});
    expect(fp.sourceLang).toBe("Auto-Detect");
    expect(fp.targetLang).toBe("English");
    expect(fp.ocrEngine).toBe("paddle");
    expect(fp.promptVersion).toBe(PROMPT_VERSION);
  });

  it("selects the server model in api mode", () => {
    const fp = buildFingerprint({
      "sync:current-mode": "api",
      "local:server-model": "deepseek-r1",
      "sync:llm-model": "gemma-2b",
    });
    expect(fp.llmModel).toBe("deepseek-r1");
  });

  it("selects the gemini model in gemini mode", () => {
    const fp = buildFingerprint({
      "sync:current-mode": "gemini",
      "sync:gemini-model": "gemini-1.5-flash",
    });
    expect(fp.llmModel).toBe("gemini-1.5-flash");
  });

  it("selects the local llm model in webgpu mode", () => {
    const fp = buildFingerprint({
      "sync:current-mode": "webgpu",
      "sync:llm-model": "gemma-2b-it",
    });
    expect(fp.llmModel).toBe("gemma-2b-it");
  });
});

describe("isCacheValid", () => {
  const currentFp: PageCacheFingerprint = {
    sourceLang: "Japanese",
    targetLang: "Korean",
    ocrEngine: "paddle",
    ocrMinConfidence: 0.6,
    detectionModel: "manga-text-detector",
    llmModel: "qwen-2.5-7b",
    temperature: 0.7,
    promptVersion: 1,
  };

  const sampleCache: PageCache = {
    bboxes: [],
    translations: ["안녕하세요"],
    fingerprint: { ...currentFp },
  };

  it("considers null or undefined cache invalid", () => {
    expect(isCacheValid(null, currentFp)).toBe(false);
    expect(isCacheValid(undefined, currentFp)).toBe(false);
  });

  it("considers legacy cache without fingerprint invalid (miss)", () => {
    const legacy: PageCache = {
      bboxes: [],
      translations: ["Hello"],
    };
    expect(isCacheValid(legacy, currentFp)).toBe(false);
  });

  it("considers matching cache valid (hit)", () => {
    expect(isCacheValid(sampleCache, currentFp)).toBe(true);
  });

  it("preserves cleanedSrc in cache object", () => {
    const cacheWithCleaned: PageCache = {
      ...sampleCache,
      cleanedSrc: "data:image/png;base64,customCleaned",
    };
    expect(isCacheValid(cacheWithCleaned, currentFp)).toBe(true);
    expect(cacheWithCleaned.cleanedSrc).toBe("data:image/png;base64,customCleaned");
  });

  it("invalidates when source language changes", () => {
    const cache: PageCache = {
      ...sampleCache,
      fingerprint: { ...currentFp, sourceLang: "English" },
    };
    expect(isCacheValid(cache, currentFp)).toBe(false);
  });

  it("invalidates when target language changes", () => {
    const cache: PageCache = {
      ...sampleCache,
      fingerprint: { ...currentFp, targetLang: "Spanish" },
    };
    expect(isCacheValid(cache, currentFp)).toBe(false);
  });

  it("invalidates when OCR engine changes", () => {
    const cache: PageCache = {
      ...sampleCache,
      fingerprint: { ...currentFp, ocrEngine: "manga-ocr" },
    };
    expect(isCacheValid(cache, currentFp)).toBe(false);
  });

  it("invalidates when detection model changes", () => {
    const cache: PageCache = {
      ...sampleCache,
      fingerprint: { ...currentFp, detectionModel: "ctd" },
    };
    expect(isCacheValid(cache, currentFp)).toBe(false);
  });

  it("invalidates when LLM model changes", () => {
    const cache: PageCache = {
      ...sampleCache,
      fingerprint: { ...currentFp, llmModel: "gpt-4o" },
    };
    expect(isCacheValid(cache, currentFp)).toBe(false);
  });

  it("invalidates when temperature changes", () => {
    const cache: PageCache = {
      ...sampleCache,
      fingerprint: { ...currentFp, temperature: 0.2 },
    };
    expect(isCacheValid(cache, currentFp)).toBe(false);
  });

  it("invalidates when prompt version changes", () => {
    const cache: PageCache = {
      ...sampleCache,
      fingerprint: { ...currentFp, promptVersion: 999 },
    };
    expect(isCacheValid(cache, currentFp)).toBe(false);
  });
});

describe("clearPageCache", () => {
  it("removes page-cache keys from storage", async () => {
    const removed: string[] = [];
    const mockStorage = {
      snapshot: async () => ({
        "page-cache-en-1": {},
        "page-cache-ko-2": {},
        "other-setting": "value",
      }),
      removeItems: async (keys: string[]) => {
        removed.push(...keys);
      },
    };

    const { clearPageCache } = await import(
      "../../src/lib/cache/page-cache"
    );
    const result = await clearPageCache(mockStorage as any);
    expect(result.clearedCount).toBe(2);
    expect(removed).toEqual(["local:page-cache-en-1", "local:page-cache-ko-2"]);
  });
});
