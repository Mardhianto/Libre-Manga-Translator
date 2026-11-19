/**
 * Live acceptance check for LMT-024 against a running Ollama.
 *
 * Not part of `test:unit` on purpose: it needs a real model and a real server,
 * which CI does not have. Run it by hand:
 *
 *   bun run scripts/ollama-live-check.ts
 *   LMT_OLLAMA_MODEL=qwen3.5:9b bun run scripts/ollama-live-check.ts
 *
 * It translates a dense 40-box Japanese page with 5 pages of series history
 * through the shipped code path (`translateWithServer` -> native `/api/chat`)
 * and asserts the things the bug row promises: valid JSON, exact box count,
 * no echoed source, and a prompt the server did not cut.
 */

import {
  testServerConnection,
  translateWithServer,
} from "../src/lib/server/main";
import { resolveOutputCap } from "../src/lib/server/prompt-budget";
import type { ServerConfig } from "../src/lib/server/schemas";

const MODEL = process.env.LMT_OLLAMA_MODEL ?? "qwen3.5:2b";
const HOST = process.env.LMT_OLLAMA_HOST ?? "http://127.0.0.1:11434/v1";
const RUNS = Number(process.env.LMT_OLLAMA_RUNS ?? "3");

const config: ServerConfig = {
  serverHost: HOST,
  serverSchema: "ollama",
  serverModel: MODEL,
  useServerApiKey: false,
  serverApiKey: "",
  temperature: 0.3,
  numCtx: 4096,
  disableThinking: true,
};

/** 40 dense Japanese manga lines, the shape that used to be cut off. */
const PAGE: string[] = [
  "おい、そんなところで何をしているんだ？",
  "べ、別に何もしてないわよ！",
  "嘘をつけ。この時間にここにいる理由なんて一つしかないだろ。",
  "うるさいわね、あんたに関係ないでしょ。",
  "関係ないとは言わせないな。",
  "ちょっと待って、二人とも落ち着いて。",
  "落ち着いてられるか、こいつが全部悪いんだ。",
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

const history = [1, 2, 3, 4, 5].map((pageIndex) => ({
  chapterId: "chapter-7",
  pageIndex,
  text: `ページ${pageIndex}: ` + "彼女は静かに窓の外を見ていた。雨はまだ降り続いていた。".repeat(12),
}));

const seriesContext = {
  seriesName: "Live Check",
  summary: "Two students argue in an empty classroom, then agree to investigate together.",
  dictionary: "先輩 -> senior\n屋上 -> rooftop",
  lastChapterId: "chapter-7",
  lastPageIndex: 5,
  recentHistory: history,
  translatedCount: 5,
};

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const probe = await testServerConnection(config);
if (!probe.success) fail(`server probe: ${probe.error ?? "unknown"}`);
console.log(`server: ${probe.provider} · models: ${(probe.models ?? []).join(", ")}`);

console.log(
  `page: ${PAGE.length} boxes · answer budget: ${resolveOutputCap(PAGE.length)} tok · runs: ${RUNS}`,
);

let sawFullAnswer = 0;

for (let run = 1; run <= RUNS; run++) {
  const started = Date.now();
  let result;
  try {
    result = await translateWithServer(
      PAGE,
      "English",
      "Japanese",
      seriesContext,
      config,
    );
  } catch (error) {
    fail(`run ${run} threw: ${(error as Error).message}`);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const d = result.diagnostics!;

  if (result.translations.length !== PAGE.length) {
    fail(
      `run ${run}: expected ${PAGE.length} translations, got ${result.translations.length}`,
    );
  }

  const emptyIndexes = result.translations
    .map((t, i) => (!t.trim() ? i + 1 : 0))
    .filter(Boolean);
  if (emptyIndexes.length > 0) {
    // Not a truncation signal: the count matched and `finish` was "stop".
    // A 2B returning "" for a non-empty box is output quality, which this
    // row does not claim to fix (see LMT-006 for the accuracy harness).
    console.warn(
      `  warning: ${emptyIndexes.length} empty translation(s) at box(es) ${emptyIndexes.join(", ")} - model quality, not truncation`,
    );
  }

  if (d.untranslated?.length) {
    fail(`run ${run}: ${d.untranslated.length} boxes echoed the source`);
  }

  if (d.finishReason !== "stop") {
    fail(`run ${run}: finish reason "${d.finishReason}" (answer was cut)`);
  }

  if (d.truncated) fail(`run ${run}: answer reported truncated`);

  console.log(
    `run ${run}: ok · ${elapsed}s · ${d.llmCalls} call(s) · ` +
      `~${d.promptTokens} prompt tok (est) · server counted ${d.promptEvalCount} · ` +
      `ctx ${d.numCtx} · thinking ${d.thinkingDisabled ? "off" : "on"} · ` +
      `finish ${d.finishReason}`,
  );

  // The signature of the original bug: the server evaluated far fewer tokens
  // than were sent, which means the start of the prompt was dropped.
  if (d.promptEvalCount && d.promptTokens) {
    const ratio = d.promptEvalCount / d.promptTokens;
    if (ratio < 0.8) {
      fail(
        `run ${run}: server evaluated ${d.promptEvalCount} of ~${d.promptTokens} prompt tokens ` +
          `(${Math.round(ratio * 100)}%) - the prompt was cut`,
      );
    }
  }

  if (d.budgetLevel === "over") {
    fail(`run ${run}: prompt does not fit the window: ${d.budgetWarning}`);
  }

  sawFullAnswer++;
}

if (sawFullAnswer !== RUNS) fail("not every run produced a full answer");
console.log(`\nPASS: ${RUNS}/${RUNS} runs produced a complete ${PAGE.length}-box translation.`);
