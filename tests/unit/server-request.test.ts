import { afterEach, describe, expect, it } from "bun:test";
import { buildTranslationPrompts } from "../../src/lib/prompts";
import {
  buildLmStudioTextRequest,
  buildOpenAITextRequest,
  type ServerConfig,
} from "../../src/lib/server/schemas";
import {
  makeSiteRuleWithServer,
  translateWithServer,
} from "../../src/lib/server/main";
import { TranslationValidationError } from "../../src/lib/server/validator";

const openaiConfig: ServerConfig = {
  serverHost: "http://localhost:8033/v1",
  serverSchema: "openai",
  serverModel: "tiny-aya-fire-q4_k_m",
  useServerApiKey: false,
  serverApiKey: "",
  temperature: 0.3,
};

const lmstudioConfig: ServerConfig = {
  ...openaiConfig,
  serverSchema: "lmstudio",
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function openAIResponse(content: unknown) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function lmStudioResponse(content: unknown) {
  return new Response(
    JSON.stringify({ output: [{ content: JSON.stringify(content) }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("request bodies carry the strict schema", () => {
  const { schema } = buildTranslationPrompts(
    ["one", "two", "three"],
    "English",
    "Japanese",
  );

  it("builds a schema object with exact item bounds", () => {
    expect(typeof schema).toBe("object");
    const translations = (schema as any).properties.translations;
    expect(translations.minItems).toBe(3);
    expect(translations.maxItems).toBe(3);
    expect((schema as any).additionalProperties).toBe(false);
    expect((schema as any).properties.context.additionalProperties).toBe(false);
  });

  it("sends json_schema in the OpenAI body", () => {
    const body = buildOpenAITextRequest(
      "model",
      "system",
      "user",
      0.3,
      schema,
      "json_schema",
    ) as any;

    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema.properties.translations.minItems).toBe(3);
    expect(body.response_format.json_schema.schema.properties.translations.maxItems).toBe(3);
  });

  it("sends json_object when requested", () => {
    const body = buildOpenAITextRequest(
      "model",
      "system",
      "user",
      0.3,
      schema,
      "json_object",
    ) as any;
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("keeps the LM Studio native body shape while adding the format", () => {
    const body = buildLmStudioTextRequest(
      "model",
      "system",
      "user",
      0.3,
      schema,
      "json_schema",
    ) as any;

    expect(body.input).toEqual([{ type: "text", content: "user" }]);
    expect(body.system_prompt).toBe("system");
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.strict).toBe(true);
  });
});

describe("callServer response_format fallback", () => {
  it("retries a rejected OpenAI json_schema once as json_object", async () => {
    const calls: any[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      if (calls.length === 1) return new Response("nope", { status: 400 });
      return openAIResponse({ translations: ["A"] });
    }) as unknown as typeof fetch;

    const result = await translateWithServer(
      ["こんにちは"],
      "English",
      "Japanese",
      undefined,
      openaiConfig,
    );

    expect(result.translations).toEqual(["A"]);
    expect(calls).toHaveLength(2);
    expect(calls[0].response_format.type).toBe("json_schema");
    expect(calls[1].response_format).toEqual({ type: "json_object" });
  });

  it("walks LM Studio through json_object to no response_format", async () => {
    const calls: any[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      if (calls.length === 1) return new Response("nope", { status: 400 });
      if (calls.length === 2) return new Response("nope", { status: 422 });
      return lmStudioResponse({ translations: ["A"] });
    }) as unknown as typeof fetch;

    const result = await translateWithServer(
      ["こんにちは"],
      "English",
      "Japanese",
      undefined,
      lmstudioConfig,
    );

    expect(result.translations).toEqual(["A"]);
    expect(calls).toHaveLength(3);
    expect(calls[0].response_format.type).toBe("json_schema");
    expect(calls[1].response_format).toEqual({ type: "json_object" });
    expect(calls[2].response_format).toBeUndefined();
  });

  it("does not downgrade on auth errors", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("unauthorized", { status: 401 });
    }) as unknown as typeof fetch;

    await expect(
      translateWithServer(
        ["こんにちは"],
        "English",
        "Japanese",
        undefined,
        openaiConfig,
      ),
    ).rejects.toThrow("API 401");
    expect(calls).toBe(1);
  });
});

describe("validation correction retry", () => {
  it("asks for a corrected response on count mismatch", async () => {
    const calls: any[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      if (calls.length === 1) return openAIResponse({ translations: ["OnlyOne"] });
      return openAIResponse({ translations: ["First", "Second"] });
    }) as unknown as typeof fetch;

    const result = await translateWithServer(
      ["一つ", "二つ"],
      "English",
      "Japanese",
      undefined,
      openaiConfig,
    );

    expect(result.translations).toEqual(["First", "Second"]);
    expect(calls).toHaveLength(2);
    expect(calls[1].messages[1].content).toContain("CORRECTION:");
  });

  it("surfaces the typed error when the correction is still wrong", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return openAIResponse({ translations: ["OnlyOne"] });
    }) as unknown as typeof fetch;

    await expect(
      translateWithServer(
        ["一つ", "二つ"],
        "English",
        "Japanese",
        undefined,
        openaiConfig,
      ),
    ).rejects.toBeInstanceOf(TranslationValidationError);
    expect(calls).toBe(2);
  });
});

describe("makeSiteRuleWithServer", () => {
  it("threads the site-rule schema into the request body", async () => {
    const calls: any[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return openAIResponse({
        seriesName: { regex: "", source: "" },
        chapterId: { regex: "", source: "" },
        pageIndex: { regex: "", source: "" },
      });
    }) as unknown as typeof fetch;

    await makeSiteRuleWithServer("Title", "/chapter/1", openaiConfig);

    expect(calls).toHaveLength(1);
    const format = calls[0].response_format;
    expect(format.type).toBe("json_schema");
    expect(format.json_schema.name).toBe("site_rule");
    expect(format.json_schema.schema.additionalProperties).toBe(false);
  });
});
