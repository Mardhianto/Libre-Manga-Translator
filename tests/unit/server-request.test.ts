import { afterEach, describe, expect, it } from "bun:test";
import { buildTranslationPrompts } from "../../src/lib/prompts";
import {
  buildLmStudioTextRequest,
  buildOllamaChatRequest,
  buildOpenAITextRequest,
  resolveChatEndpoint,
  type ServerConfig,
} from "../../src/lib/server/schemas";
import {
  makeSiteRuleWithServer,
  testServerConnection,
  translateWithServer,
} from "../../src/lib/server/main";
import { TranslationValidationError } from "../../src/lib/server/validator";
import { resolveOutputCap } from "../../src/lib/server/prompt-budget";

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

const ollamaConfig: ServerConfig = {
  serverHost: "http://127.0.0.1:11434/v1",
  serverSchema: "ollama",
  serverModel: "qwen3.5:2b",
  useServerApiKey: false,
  serverApiKey: "",
  temperature: 0.3,
  numCtx: 4096,
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function openAIResponse(content: unknown, finishReason = "stop") {
  return new Response(
    JSON.stringify({
      choices: [
        { message: { content: JSON.stringify(content) }, finish_reason: finishReason },
      ],
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

/** Native Ollama `/api/chat` reply shape (LMT-024). */
function ollamaResponse(
  content: unknown,
  opts: {
    doneReason?: string;
    promptEvalCount?: number;
    evalCount?: number;
    reasoning?: string;
  } = {},
) {
  return new Response(
    JSON.stringify({
      model: "qwen3.5:2b",
      message: {
        role: "assistant",
        content:
          typeof content === "string" ? content : JSON.stringify(content),
        ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
      },
      done: true,
      done_reason: opts.doneReason ?? "stop",
      prompt_eval_count: opts.promptEvalCount ?? 0,
      eval_count: opts.evalCount ?? 0,
    }),
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

describe("run diagnostics (LMT-032)", () => {
  it("reports the raw answer, stop reason, and cost of one call", async () => {
    globalThis.fetch = (async () =>
      openAIResponse({ translations: ["A"] })) as unknown as typeof fetch;

    const result = await translateWithServer(
      ["こんにちは"],
      "English",
      "Japanese",
      undefined,
      openaiConfig,
    );

    expect(result.diagnostics?.rawResponse).toBe('{"translations":["A"]}');
    expect(result.diagnostics?.finishReason).toBe("stop");
    expect(result.diagnostics?.llmCalls).toBe(1);
    expect(result.diagnostics?.truncated).toBe(false);
    expect(result.diagnostics?.padded).toBe(false);
    expect(result.diagnostics?.promptChars).toBeGreaterThan(0);
  });

  it("counts the answered fallback and correction rounds as calls", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return new Response("nope", { status: 400 });
      if (calls === 2) return openAIResponse({ translations: ["OnlyOne"] });
      return openAIResponse({ translations: ["A", "B"] });
    }) as unknown as typeof fetch;

    const result = await translateWithServer(
      ["こんにちは", "さようなら"],
      "English",
      "Japanese",
      undefined,
      openaiConfig,
    );

    // Three HTTP attempts, but the 400 never reached the model, so only the two
    // answers count as LLM work.
    expect(calls).toBe(3);
    expect(result.diagnostics?.llmCalls).toBe(2);
    // Baseline page cost, not the longer correction prompt.
    expect(result.diagnostics?.promptChars).toBeGreaterThan(0);
  });

  it("flags a length stop reason as truncated", async () => {
    globalThis.fetch = (async () =>
      openAIResponse({ translations: ["A"] }, "length")) as unknown as typeof fetch;

    const result = await translateWithServer(
      ["こんにちは"],
      "English",
      "Japanese",
      undefined,
      openaiConfig,
    );

    expect(result.diagnostics?.finishReason).toBe("length");
    expect(result.diagnostics?.truncated).toBe(true);
  });

  it("stamps run facts onto a thrown parse error", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "{\"translations\": [\"A\"" }, finish_reason: "length" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const error = await translateWithServer(
      ["こんにちは"],
      "English",
      "Japanese",
      undefined,
      openaiConfig,
    ).catch((e) => e);

    // The raw cut-off answer is the whole diagnosis for a parse failure.
    expect(error).toBeInstanceOf(Error);
    expect(error.lmtDiagnostics?.finishReason).toBe("length");
    expect(error.lmtDiagnostics?.rawResponse).toContain('"translations"');
  });
});

describe("retry predicate (LMT-027)", () => {
  it("does not re-send a request whose answer failed to parse", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"translations": ["A"' }, finish_reason: "length" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await expect(
      translateWithServer(
        ["こんにちは"],
        "English",
        "Japanese",
        undefined,
        openaiConfig,
      ),
    ).rejects.toBeInstanceOf(Error);

    // A cut-off answer reproduces identically: the second attempt would only
    // burn another inference and bury the truncation in the debug log.
    expect(calls).toBe(1);
  });

  it("still retries once on a 5xx", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return new Response("boom", { status: 503 });
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
    expect(calls).toBe(2);
  });

  it("does not retry when the job is already cancelled", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("boom", { status: 503 });
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    controller.abort(new DOMException("Timed out after 180s: TRANSLATE_IMAGE", "AbortError"));

    const error = await translateWithServer(
      ["こんにちは"],
      "English",
      "Japanese",
      undefined,
      openaiConfig,
      undefined,
      controller.signal,
    ).catch((e) => e);

    // No request, no retry: the deadline already passed.
    expect(calls).toBe(0);
    // The caller's reason survives, so the stage name reaches the UI.
    expect(error.message).toContain("Timed out after 180s: TRANSLATE_IMAGE");
  });

  it("still retries once on a 429", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return new Response("slow down", { status: 429 });
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
    expect(calls).toBe(2);
  });

  it("still retries a transport failure", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw new TypeError("Failed to fetch");
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
    expect(calls).toBe(2);
  });

  it("passes the abort signal to fetch", async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return openAIResponse({ translations: ["A"] });
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    await translateWithServer(
      ["こんにちは"],
      "English",
      "Japanese",
      undefined,
      openaiConfig,
      undefined,
      controller.signal,
    );

    expect(seen).toBe(controller.signal);
  });
});

describe("auto-detect prompt clause (LMT-030)", () => {
  it("names the auto-detected script when the gate picked one", () => {
    const { systemPrompt } = buildTranslationPrompts(
      ["こんにちは"],
      "English",
      "Auto-Detect",
      undefined,
      "Japanese",
    );
    expect(systemPrompt).toContain("FROM JAPANESE (auto-detected script)");
  });

  it("does not imply English when nothing was detected", () => {
    const { systemPrompt } = buildTranslationPrompts(
      ["こんにちは"],
      "English",
      "Auto-Detect",
      undefined,
      null,
    );
    expect(systemPrompt).toContain(
      "FROM the source language of the text in each box",
    );
  });

  it("keeps the explicit source verbatim", () => {
    const { systemPrompt } = buildTranslationPrompts(
      ["こんにちは"],
      "English",
      "Japanese",
    );
    expect(systemPrompt).toContain("FROM JAPANESE INTO ENGLISH");
    expect(systemPrompt).not.toContain("auto-detected");
  });
});

describe("native Ollama schema (LMT-024)", () => {
  const { schema } = buildTranslationPrompts(
    ["こんにちは", "元気？"],
    "English",
    "Japanese",
  );

  it("builds a body carrying num_ctx, think, and format", () => {
    const body = buildOllamaChatRequest(
      "qwen3.5:2b",
      "system",
      "user",
      { numCtx: 8192, numPredict: 2048, temperature: 0.3, disableThinking: true },
      schema,
    ) as any;

    expect(body.stream).toBe(false);
    expect(body.think).toBe(false);
    expect(body.format).toEqual(schema);
    expect(body.options.num_ctx).toBe(8192);
    expect(body.options.num_predict).toBe(2048);
    expect(body.options.temperature).toBe(0.3);
    expect(body.messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "user" },
    ]);
    // The OpenAI-shaped fields must not leak into the native body.
    expect(body.max_tokens).toBeUndefined();
    expect(body.response_format).toBeUndefined();
  });

  it("omits think when thinking is not being disabled", () => {
    const body = buildOllamaChatRequest(
      "m",
      "s",
      "u",
      { numCtx: 4096, numPredict: 1024, temperature: 0.3, disableThinking: false },
      schema,
    ) as any;
    expect(body.think).toBeUndefined();
  });

  it("degrades format to a plain json string, then omits it", () => {
    const json = buildOllamaChatRequest(
      "m",
      "s",
      "u",
      { numCtx: 4096, numPredict: 1024, temperature: 0.3 },
      schema,
      "json_object",
    ) as any;
    expect(json.format).toBe("json");

    const none = buildOllamaChatRequest(
      "m",
      "s",
      "u",
      { numCtx: 4096, numPredict: 1024, temperature: 0.3 },
      schema,
      "none",
    ) as any;
    expect(none.format).toBeUndefined();
  });

  it("resolves the native endpoint from every host shape users paste", () => {
    expect(resolveChatEndpoint("http://127.0.0.1:11434/v1", "ollama")).toBe(
      "http://127.0.0.1:11434/api/chat",
    );
    expect(resolveChatEndpoint("http://127.0.0.1:11434", "ollama")).toBe(
      "http://127.0.0.1:11434/api/chat",
    );
    expect(resolveChatEndpoint("http://127.0.0.1:11434/", "ollama")).toBe(
      "http://127.0.0.1:11434/api/chat",
    );
    expect(resolveChatEndpoint("http://127.0.0.1:11434/api", "ollama")).toBe(
      "http://127.0.0.1:11434/api/chat",
    );
    // Other schemas keep their existing paths untouched.
    expect(resolveChatEndpoint("http://localhost:8033/v1", "openai")).toBe(
      "http://localhost:8033/v1/chat/completions",
    );
    expect(resolveChatEndpoint("http://localhost:1234/api/v1/", "lmstudio")).toBe(
      "http://localhost:1234/api/v1/chat",
    );
  });

  it("posts to /api/chat and parses the native reply", async () => {
    let seenUrl = "";
    globalThis.fetch = (async (url: string) => {
      seenUrl = String(url);
      return ollamaResponse({ translations: ["Hello", "Fine?"] }, {
        promptEvalCount: 312,
        evalCount: 24,
      });
    }) as unknown as typeof fetch;

    const result = await translateWithServer(
      ["こんにちは", "元気？"],
      "English",
      "Japanese",
      undefined,
      ollamaConfig,
    );

    expect(seenUrl).toBe("http://127.0.0.1:11434/api/chat");
    expect(result.translations).toEqual(["Hello", "Fine?"]);
  });

  it("reports the server's own prompt count against the estimate", async () => {
    globalThis.fetch = (async () =>
      ollamaResponse({ translations: ["A"] }, {
        promptEvalCount: 640,
      })) as unknown as typeof fetch;

    const result = await translateWithServer(
      ["こんにちは"],
      "English",
      "Japanese",
      undefined,
      ollamaConfig,
    );

    const d = result.diagnostics!;
    expect(d.promptEvalCount).toBe(640);
    expect(d.promptTokens).toBeGreaterThan(0);
    expect(d.numCtx).toBeGreaterThanOrEqual(4096);
    expect(d.thinkingDisabled).toBe(true);
  });

  it("flags a native length stop as truncated", async () => {
    globalThis.fetch = (async () =>
      ollamaResponse({ translations: ["A"] }, {
        doneReason: "length",
      })) as unknown as typeof fetch;

    const result = await translateWithServer(
      ["こんにちは"],
      "English",
      "Japanese",
      undefined,
      ollamaConfig,
    );

    expect(result.diagnostics?.finishReason).toBe("length");
    expect(result.diagnostics?.truncated).toBe(true);
  });

  it("scales the answer budget with the box count", async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const count = bodies.length === 1 ? 40 : 40;
      return ollamaResponse({
        translations: new Array(count).fill("x"),
      });
    }) as unknown as typeof fetch;

    const boxes = new Array(40).fill("こんにちは");
    await translateWithServer(
      boxes,
      "English",
      "Japanese",
      undefined,
      ollamaConfig,
    );

    expect(bodies[0].options.num_predict).toBe(resolveOutputCap(40));
    expect(bodies[0].options.num_predict).toBeGreaterThan(1024);
  });

  it("grows num_ctx past the requested window when the page needs it", async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return ollamaResponse({ translations: new Array(40).fill("x") });
    }) as unknown as typeof fetch;

    // A history-heavy page: the prompt alone is far past 4096 tokens.
    const history = new Array(5).fill({
      chapterId: "c1",
      pageIndex: 1,
      text: "あ".repeat(1100),
    });
    await translateWithServer(
      new Array(40).fill("こんにちは、今日はいい天気ですね。"),
      "English",
      "Japanese",
      {
        seriesName: "T",
        summary: "summary",
        dictionary: "term -> gloss",
        lastChapterId: "c1",
        lastPageIndex: 5,
        recentHistory: history,
        translatedCount: 5,
      },
      ollamaConfig,
    );

    expect(bodies[0].options.num_ctx).toBeGreaterThan(4096);
  });

  it("drops `think` once when the server rejects the field", async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (bodies.length === 1) {
        return new Response("unknown field `think`", { status: 400 });
      }
      return ollamaResponse({ translations: ["A"] });
    }) as unknown as typeof fetch;

    const result = await translateWithServer(
      ["こんにちは"],
      "English",
      "Japanese",
      undefined,
      ollamaConfig,
    );

    expect(result.translations).toEqual(["A"]);
    expect(bodies[0].think).toBe(false);
    expect(bodies[1].think).toBeUndefined();
    // One fallback, not a loop.
    expect(bodies.length).toBe(2);
  });

  it("labels a reasoning-only answer instead of reporting an empty one", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: "", reasoning: "Thinking Process: ..." },
              finish_reason: "length",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const error = await translateWithServer(
      ["こんにちは"],
      "English",
      "Japanese",
      undefined,
      openaiConfig,
    ).catch((e) => e);

    expect(error.message).toContain("reasoning text but no answer");
  });

  it("sends reasoning_effort on the OpenAI path only when asked", async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return openAIResponse({ translations: ["A"] });
    }) as unknown as typeof fetch;

    await translateWithServer(
      ["こんにちは"],
      "English",
      "Japanese",
      undefined,
      { ...openaiConfig, disableThinking: true },
    );
    await translateWithServer(
      ["こんにちは"],
      "English",
      "Japanese",
      undefined,
      openaiConfig,
    );

    expect(bodies[0].reasoning_effort).toBe("none");
    expect(bodies[1].reasoning_effort).toBeUndefined();
  });

  it("drops reasoning_effort once when a strict server rejects it", async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (bodies.length === 1) {
        return new Response("Unrecognized request argument: reasoning_effort", {
          status: 400,
        });
      }
      return openAIResponse({ translations: ["A"] });
    }) as unknown as typeof fetch;

    const result = await translateWithServer(
      ["こんにちは"],
      "English",
      "Japanese",
      undefined,
      { ...openaiConfig, disableThinking: true },
    );

    expect(result.translations).toEqual(["A"]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].reasoning_effort).toBeUndefined();
  });
});

describe("server probe (LMT-024)", () => {
  it("reads /api/tags for the native schema", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({ models: [{ name: "qwen3.5:2b" }, { model: "llama3.2" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await testServerConnection(ollamaConfig);

    expect(urls[0]).toBe("http://127.0.0.1:11434/api/tags");
    expect(result.success).toBe(true);
    expect(result.provider).toBe("ollama");
    expect(result.models).toEqual(["qwen3.5:2b", "llama3.2"]);
  });

  it("fails loud when no Ollama answers /api/tags", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 404 })) as unknown as typeof fetch;

    const result = await testServerConnection(ollamaConfig);

    expect(result.success).toBe(false);
    expect(result.error).toContain("/api/tags");
  });

  it("suggests the native schema when Ollama hides behind the OpenAI path", async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({ models: [{ name: "qwen3.5:2b" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ data: [{ id: "qwen3.5:2b" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await testServerConnection(openaiConfig);

    expect(result.success).toBe(true);
    expect(result.provider).toBe("ollama");
    expect(result.suggestNativeOllama).toBe(true);
  });

  it("stays quiet on a plain OpenAI-compatible server", async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith("/api/tags")) {
        return new Response("nope", { status: 404 });
      }
      return new Response(JSON.stringify({ data: [{ id: "some-model" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await testServerConnection(openaiConfig);

    expect(result.success).toBe(true);
    expect(result.provider).toBe("openai-compatible");
    expect(result.suggestNativeOllama).toBeUndefined();
  });
});
