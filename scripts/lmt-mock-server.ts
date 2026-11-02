/**
 * Deterministic OpenAI-compatible stub for the live LLM tests.
 *
 * Serves exactly the two routes the product hits — `GET /v1/models` for
 * `testServerConnection` and `POST /v1/chat/completions` for `callServer` — and
 * derives its response length from the `Box N: "…"` lines the real prompt
 * builder emits. That keeps the request shape, JSON parsing, count binding,
 * correction round-trip and validator on the executed path.
 *
 * It is NOT a model: it echoes each source line back. Prompt/transport/validator
 * coverage here is genuine; translation quality is not measured by this stub and
 * must never be claimed from it.
 *
 *   bun scripts/lmt-mock-server.ts            # listens on :8033
 *   LMT_MOCK_PORT=9100 bun scripts/lmt-mock-server.ts
 *   LMT_MOCK_REJECT_SCHEMA=1 bun scripts/lmt-mock-server.ts
 *     Rejects the first `response_format: json_schema` request with HTTP 400,
 *     then accepts the json_object retry — exercises the fallback.
 */
const PORT = Number(process.env.LMT_MOCK_PORT ?? 8033);
const MODEL_ID = process.env.LMT_MOCK_MODEL ?? "tiny-aya-fire-q4_k_m";
const REJECT_SCHEMA_ONCE = process.env.LMT_MOCK_REJECT_SCHEMA === "1";
let rejectedSchema = false;

// `buildTranslationPrompts` renders one line per box:
//   Box 3: "こんにちは"        Box 5: "" (empty — return "")
const BOX_LINE = /Box (\d+): ("(?:[^"\\]|\\.)*")/g;

function sourcesFromPrompt(prompt: string): string[] {
  const byIndex = new Map<number, string>();

  for (const match of prompt.matchAll(BOX_LINE)) {
    const index = Number(match[1]) - 1;
    let source = match[2];
    try {
      source = String(JSON.parse(match[2]));
    } catch {
      // Unterminated quote in a hand-edited prompt — keep the raw token.
    }
    byIndex.set(index, source);
  }

  if (byIndex.size === 0) return [];
  const count = Math.max(...byIndex.keys()) + 1;
  return Array.from({ length: count }, (_, i) => byIndex.get(i) ?? "");
}

function complete(body: any) {
  const messages: Array<{ role: string; content: string }> = body?.messages ?? [];
  const prompt = messages.map((m) => String(m.content ?? "")).join("\n");
  const sources = sourcesFromPrompt(prompt);

  const translations = sources.map((source, i) =>
    source.trim() === "" ? "" : `Mock line ${i + 1} of ${sources.length}: ${source}`,
  );

  console.log(`[lmt-mock] ${translations.length} box(es) -> model "${body?.model ?? MODEL_ID}"`);

  return Response.json({
    id: `lmt-mock-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body?.model ?? MODEL_ID,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify({ translations }) },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: translations.length, total_tokens: 0 },
  });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/v1/models" && req.method === "GET") {
      return Response.json({
        object: "list",
        data: [{ id: MODEL_ID, object: "model", owned_by: "lmt-mock" }],
      });
    }

    if (url.pathname.endsWith("/chat/completions") && req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (
        REJECT_SCHEMA_ONCE &&
        !rejectedSchema &&
        body?.response_format?.type === "json_schema"
      ) {
        rejectedSchema = true;
        console.log("[lmt-mock] rejecting json_schema once (fallback test)");
        return Response.json(
          { error: { message: "lmt-mock: json_schema is not supported" } },
          { status: 400 },
        );
      }
      return complete(body);
    }

    return Response.json(
      { error: { message: `lmt-mock: no route for ${req.method} ${url.pathname}` } },
      { status: 404 },
    );
  },
});

console.log(`[lmt-mock] listening on http://localhost:${server.port}/v1 (${MODEL_ID})`);
