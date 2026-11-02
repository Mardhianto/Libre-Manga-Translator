export interface ServerConfig {
  serverHost: string;
  serverSchema: "openai" | "lmstudio";
  serverModel: string;
  useServerApiKey: boolean;
  serverApiKey: string;
  temperature: number;
}

export type ResponseFormatMode = "json_schema" | "json_object" | "none";

function jsonSchemaFormat(schema: object, name: string) {
  return {
    type: "json_schema" as const,
    json_schema: {
      name,
      strict: true,
      schema,
    },
  };
}

export function buildOpenAITextRequest(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  temperature: number,
  schema?: object,
  mode: ResponseFormatMode = schema ? "json_schema" : "json_object",
  schemaName = "manga_translation",
) {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature,
    max_tokens: 4096,
    stream: false,
  };

  if (mode === "json_schema" && schema) {
    body.response_format = jsonSchemaFormat(schema, schemaName);
  } else if (mode === "json_object") {
    body.response_format = { type: "json_object" };
  }

  return body;
}

export function buildLmStudioTextRequest(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  temperature: number,
  schema?: object,
  mode: ResponseFormatMode = schema ? "json_schema" : "none",
  schemaName = "manga_translation",
) {
  const body: Record<string, unknown> = {
    model,
    input: [{ type: "text", content: userPrompt }],
    system_prompt: systemPrompt,
    temperature,
    max_output_tokens: 4096,
    stream: false,
  };

  // The native /api/v1/chat endpoint does not document response_format. Send
  // it when a schema is available and let callServer fall back on 400/422.
  if (mode === "json_schema" && schema) {
    body.response_format = jsonSchemaFormat(schema, schemaName);
  } else if (mode === "json_object") {
    body.response_format = { type: "json_object" };
  }

  return body;
}
