/**
 * Live acceptance check for LMT-018 / LMT-033 against a running LM Studio.
 *
 * Not part of `test:unit` on purpose: it needs a real model and a real server,
 * which CI does not have. Run it by hand:
 *
 *   bun run lmstudio:live
 *   LMT_LMSTUDIO_MODEL=some-model bun run lmstudio:live
 *
 * It drives the shipped code path (`translateWithServer` -> the `lmstudio`
 * schema -> `<origin>/v1/chat/completions`) and asserts what the rows promise:
 *
 *   - the answer, not the reasoning, is what gets parsed (LMT-033)
 *   - a thinking model produces a complete page with thinking disabled (LMT-018)
 *   - an over-long page fails loudly instead of being silently truncated
 *
 * The host deliberately defaults to the legacy `/api/v1` shape users already
 * have saved, so the endpoint normalisation is exercised too.
 */

import {
  testServerConnection,
  translateWithServer,
} from "../src/lib/server/main";
import { resolveOutputCap } from "../src/lib/server/prompt-budget";
import type { ServerConfig } from "../src/lib/server/schemas";

const MODEL =
  process.env.LMT_LMSTUDIO_MODEL ?? "qwen3.5-9b-ultra-uncensored-heretic";
const HOST = process.env.LMT_LMSTUDIO_HOST ?? "http://127.0.0.1:1234/api/v1";
const RUNS = Number(process.env.LMT_LMSTUDIO_RUNS ?? "2");

const config: ServerConfig = {
  serverHost: HOST,
  serverSchema: "lmstudio",
  serverModel: MODEL,
  useServerApiKey: false,
  serverApiKey: "",
  temperature: 0.3,
  disableThinking: true,
};

/** 40 dense Japanese manga lines. */
const PAGE: string[] = [
  "おい、そんなところで何をしているんだ？",
  "べ、別に何もしてないわよ！",
  "嘘をつけ。この時間にここにいる理由なんて一つしかないだろ。",
  "うるさいわね、あんたに関係ないでしょ。",
  "関係ないとは言わせないな。",
  "ちょっと待って、二人とも落ち着いて。",
  "落ち着いてられか、こいつが全部悪いんだ。",
  "私のせいじゃない！そっちが勝手に勘違いしただけでしょ。",
  "勘違いだと？ふざけるなよ。",
  "本当のこと言うと、私も少しだけ気になってたの。",
  "な、なんだって？今なんて言った？",
  "だから、その、悪気はなかったっていうか。",
  "話をはっきりしてくれ。",
  "もういい、全部話すわ。",
  "最初はただの偶然だったの。",
  "偶然でこんなことになるかよ。",
  "信じてくれないならもういい。",
  "待て、行くな。",
  "……ごめん、言い過ぎた。",
  "分かってくれればいいのよ。",
  "それで、これからどうするつもりだ？",
  "まずは証拠を集めないと。",
  "証拠なんてあるのか？",
  "あるわよ、ちゃんと。",
  "見せてくれ。",
  "ここには置いてないけどね。",
  "ならどこにあるんだ。",
  "私の部屋よ。",
  "一人で行かせるわけにはいかない。",
  "一緒に来るってこと？",
  "他に誰がいるんだよ。",
  "分かったわ、ついてきなさい。",
  "ところで、さっきの話だけど。",
  "まだ引きずってるの？",
  "気になるのは当然だろ。",
  "そうね、私も気になってる。",
  "じゃあ、落ち着いたら話すわ。",
  "約束するの？",
  "約束するわ。",
  "よし、それでいい。",
];

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const probe = await testServerConnection(config);
if (!probe.success) fail(`server probe: ${probe.error ?? "unknown"}`);
console.log(`server: ${probe.provider} · models: ${(probe.models ?? []).join(", ")}`);
if (probe.loadedContextLength !== undefined) {
  console.log(`loaded context window: ${probe.loadedContextLength} tok`);
}
if (probe.error) console.warn(`note: ${probe.error}`);

console.log(
  `page: ${PAGE.length} boxes · answer budget: ${resolveOutputCap(PAGE.length)} tok · runs: ${RUNS}`,
);

for (let run = 1; run <= RUNS; run++) {
  const started = Date.now();
  let result;
  try {
    result = await translateWithServer(
      PAGE,
      "English",
      "Japanese",
      undefined,
      config,
    );
  } catch (error) {
    // A page that does not fit LM Studio's window fails here. That is the
    // documented behaviour for this schema - loud, not silent - so report it
    // as a finding rather than an assertion failure when the server says so.
    const message = (error as Error).message;
    if (/exceeds the available context size|context size/i.test(message)) {
      console.warn(
        `run ${run}: page does not fit the loaded window (${message.slice(0, 160)})`,
      );
      console.warn(
        "  raise the context window in LM Studio, then re-run with LMT_LMSTUDIO_PAGE=<n>",
      );
      process.exit(2);
    }
    fail(`run ${run} threw: ${message}`);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const d = result.diagnostics!;

  if (result.translations.length !== PAGE.length) {
    fail(
      `run ${run}: expected ${PAGE.length} translations, got ${result.translations.length}`,
    );
  }

  // The LMT-033 failure signature: the parsed answer is reasoning text.
  if (d.rawResponse && /Thinking Process|^\s*\d+\.\s+\*\*/i.test(d.rawResponse)) {
    fail(`run ${run}: parsed response is reasoning text, not the answer`);
  }

  if (d.untranslated?.length) {
    fail(`run ${run}: ${d.untranslated.length} boxes echoed the source`);
  }

  // LMT-018: with the lever on, a thinking model must not spend the budget
  // thinking. A "length" stop here means it still did.
  if (d.finishReason !== "stop") {
    fail(
      `run ${run}: finish reason "${d.finishReason}" (answer was cut — thinking may be on)`,
    );
  }
  if (d.truncated) fail(`run ${run}: answer reported truncated`);

  console.log(
    `run ${run}: ok · ${elapsed}s · ${d.llmCalls} call(s) · ` +
      `~${d.promptTokens} prompt tok (est) · server counted ${d.promptEvalCount ?? "?"} · ` +
      `thinking ${d.thinkingDisabled ? "off" : "on"} · finish ${d.finishReason}`,
  );
}

console.log(
  `\nPASS: ${RUNS}/${RUNS} runs produced a complete ${PAGE.length}-box translation.`,
);
