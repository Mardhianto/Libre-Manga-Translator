import { describe, it, expect } from "bun:test";
import {
  translateWithServer,
  testServerConnection,
  type ServerConfig,
} from "../../../src/lib/server/main";

/**
 * Live LLM acceptance suite — **not** part of `test:unit`.
 *
 * It needs a running OpenAI-compatible endpoint, so CI never boots one: the
 * repo's `scripts/lmt-mock-server.ts` stub is started locally by
 * `bun run test:live` (or `bun run mock:llm` in its own terminal). Keeping it
 * out of `tests/unit/` is deliberate — a suite that has to download/start a
 * model backend must not gate the ordinary push pipeline.
 *
 * Unlike the old in-tree version, an offline endpoint is a hard failure here:
 * this file only runs when you ask for it, so "nothing answered" would
 * otherwise look like a green run.
 */
const PROBE_TIMEOUT_MS = 3000;

const apiConfig: ServerConfig = {
  serverHost: "http://localhost:8033/v1",
  serverSchema: "openai",
  serverModel: "tiny-aya-fire-q4_k_m",
  useServerApiKey: false,
  serverApiKey: "",
  temperature: 0.3,
};

const targetLang = "English";

// Probed at module load rather than in `beforeAll`: the verdict has to exist
// before the suite is declared. Bounded, because module load sits outside every
// test timeout: a listener that accepts the socket but never answers would
// otherwise hang the run.
let probeTimer: ReturnType<typeof setTimeout> | undefined;
const probe = await Promise.race([
  testServerConnection(apiConfig).catch(() => null),
  new Promise<null>((resolve) => {
    probeTimer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS);
  }),
]);
clearTimeout(probeTimer);

if (probe?.success !== true) {
  throw new Error(
    `Live LLM endpoint is offline: nothing answered ${apiConfig.serverHost} within ${PROBE_TIMEOUT_MS}ms. ` +
      "Start it first (bun run mock:llm, or your own Ollama/LM Studio server) — this suite is not part of test:unit.",
  );
}

describe("API Mode translation check (tiny-aya-fire-q4_k_m)", () => {
  it("validates server connection on localhost:8033/v1", async () => {
    const connection = await testServerConnection(apiConfig);
    expect(connection.success).toBe(true);
    expect(connection.models).toContain("tiny-aya-fire-q4_k_m");
  });

  it("translates real dialogue from vertical-japanese-test.png", async () => {
    const bubbles = [
      "これはあたしとセラの冒険のお話",
      "いつかまた家族として一緒になれるように！",
      "苦しみと喜びを分かち合いながらあたしたちはこの分断された世界を旅してる",
      "はじまりはじまり～",
    ];
    const result = await translateWithServer(
      bubbles,
      targetLang,
      "Japanese",
      undefined,
      apiConfig,
    );

    expect(result.translations.length).toBe(bubbles.length);
    for (const trans of result.translations) {
      expect(typeof trans).toBe("string");
      expect(trans.length).toBeGreaterThan(0);
      expect(trans.toLowerCase()).toMatch(/[a-z]/);
    }
  });

  it("translates real dialogue from korean-test.png", async () => {
    const bubbles = [
      "저기... 총각 뭐 좀 물어볼게",
      "코エン지역은 이리로 가면 될까?",
    ];
    const result = await translateWithServer(
      bubbles,
      targetLang,
      "Korean",
      undefined,
      apiConfig,
    );

    expect(result.translations.length).toBe(bubbles.length);
    for (const trans of result.translations) {
      expect(typeof trans).toBe("string");
      expect(trans.length).toBeGreaterThan(0);
      expect(trans.toLowerCase()).toMatch(/[a-z]/);
    }
  });

  it("translates real dialogue from chinese-vertical-test.jpg", async () => {
    const bubbles = [
      "各位贵宾，请自由拿取这边的餐点",
      "三越餐厅的新菜单试吃会，现正举办中！",
      "但作为交换，请务必告诉我们您的意见",
      "意见箱在这边",
    ];
    const result = await translateWithServer(
      bubbles,
      targetLang,
      "Chinese",
      undefined,
      apiConfig,
    );

    expect(result.translations.length).toBe(bubbles.length);
    for (const trans of result.translations) {
      expect(typeof trans).toBe("string");
      expect(trans.length).toBeGreaterThan(0);
      expect(trans.toLowerCase()).toMatch(/[a-z]/);
    }
  });
});
