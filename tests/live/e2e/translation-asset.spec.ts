import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { translateWithServer, testServerConnection, type ServerConfig } from "../../../src/lib/server/main";

/**
 * Live-only spec (see `playwright.live.config.ts`). It needs a real
 * OpenAI-compatible endpoint on :8033, so it is excluded from `test:e2e` —
 * CI must never download or boot a model backend. Run it with
 * `bun run test:e2e:live` after starting `bun run mock:llm` (or a real server).
 */

const ASSET_PATH = path.resolve(process.cwd(), "tests/assets/vertical-japanese-test.png");
const OUTPUT_DIR = path.resolve(process.cwd(), "tests/output");

const apiConfig: ServerConfig = {
  serverHost: "http://localhost:8033/v1",
  serverSchema: "openai",
  serverModel: "tiny-aya-fire-q4_k_m",
  useServerApiKey: false,
  serverApiKey: "",
  temperature: 0.3,
};

test("translation pipeline via API mode (tiny-aya-fire-q4_k_m) on manga asset exports jpg", async ({ page }) => {
  // Opt-in suite: an offline endpoint is a hard failure, not a skip. A skip
  // here would report green while nothing was exercised.
  const conn = await testServerConnection(apiConfig);
  expect(
    conn.success,
    `Live translation server at ${apiConfig.serverHost} is offline — start \`bun run mock:llm\` (or a real server) first`,
  ).toBe(true);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Real Japanese text from vertical-japanese-test.png
  const sourceBubbles = [
    "これはあたしとセラの冒険のお話",
    "いつかまた家族として一緒になれるように！",
    "苦しみと喜びを分かち合いながらあたしたちはこの分断された世界を旅してる",
    "はじまりはじまり～",
  ];

  // 1. Execute real translation via API mode server
  const translationResponse = await translateWithServer(
    sourceBubbles,
    "English",
    "Japanese",
    undefined,
    apiConfig,
  );

  expect(translationResponse.translations.length).toBe(sourceBubbles.length);

  // 2. Load manga page and clean narration boxes, then typeset English translations
  const imageBuffer = fs.readFileSync(ASSET_PATH);
  const base64Data = imageBuffer.toString("base64");
  const dataUrl = `data:image/png;base64,${base64Data}`;

  const resultDataUrl = await page.evaluate(
    async ({ src, translations }) => {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = src;
      });

      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);

      // Exact 4 narration boxes on vertical-japanese-test.png
      const boxes = [
        // Top right: 'これはあたしとセラの冒険のお話'
        { x1: 2806, y1: 604, x2: 3119, y2: 1031, text: translations[0] },
        // Left upper: 'いつかまた家族として一緒になれるように！'
        { x1: 539, y1: 414, x2: 896, y2: 914, text: translations[1] },
        // Bottom right: '苦しみと喜びを分かち合いながらあたしたちはこの分断された世界を旅してる'
        { x1: 2167, y1: 1804, x2: 2498, y2: 2378, text: translations[2] },
        // Left lower: 'はじまりはじまり～'
        { x1: 402, y1: 700, x2: 580, y2: 1041, text: translations[3] },
      ];

      // 1. Clean the interior of each narration box (fill pure white inside border, preserving border)
      for (const b of boxes) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(b.x1 + 3, b.y1 + 3, (b.x2 - b.x1) - 6, (b.y2 - b.y1) - 6);
      }

      // 2. Typeset translated text with manga styling
      function wrapAndRender(ctx: CanvasRenderingContext2D, text: string, box: { x1: number; y1: number; x2: number; y2: number }) {
        const bw = box.x2 - box.x1;
        const bh = box.y2 - box.y1;
        const pad = 24;
        const maxW = bw - pad * 2;
        const maxH = bh - pad * 2;

        let fontSize = 38;
        let lines: string[] = [];
        while (fontSize >= 16) {
          ctx.font = `bold ${fontSize}px sans-serif`;
          lines = [];
          const words = text.split(" ");
          let currentLine = "";

          for (const word of words) {
            const testLine = currentLine ? `${currentLine} ${word}` : word;
            if (ctx.measureText(testLine).width > maxW) {
              if (currentLine) lines.push(currentLine);
              currentLine = word;
            } else {
              currentLine = testLine;
            }
          }
          if (currentLine) lines.push(currentLine);

          const lineH = fontSize * 1.35;
          if (lines.length * lineH <= maxH) break;
          fontSize -= 2;
        }

        const lineH = fontSize * 1.35;
        const totalH = lines.length * lineH;
        const startY = box.y1 + (bh - totalH) / 2 + fontSize * 0.9;
        const centerX = box.x1 + bw / 2;

        ctx.fillStyle = "#111111";
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";

        for (let i = 0; i < lines.length; i++) {
          ctx.fillText(lines[i], centerX, startY + i * lineH);
        }
      }

      for (const b of boxes) {
        wrapAndRender(ctx, b.text, b);
      }

      return canvas.toDataURL("image/jpeg", 0.95);
    },
    { src: dataUrl, translations: translationResponse.translations },
  );

  expect(resultDataUrl).toContain("data:image/jpeg;base64,");

  const base64Jpg = resultDataUrl.replace(/^data:image\/jpeg;base64,/, "");
  const outPath = path.join(OUTPUT_DIR, "translation-result.jpg");
  fs.writeFileSync(outPath, Buffer.from(base64Jpg, "base64"));

  expect(fs.existsSync(outPath)).toBe(true);
  const outBuffer = fs.readFileSync(outPath);
  expect(outBuffer.length).toBeGreaterThan(10000);
  expect(outBuffer[0]).toBe(0xff);
  expect(outBuffer[1]).toBe(0xd8);
});
