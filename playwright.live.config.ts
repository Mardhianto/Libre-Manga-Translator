import { defineConfig } from "@playwright/test";

/**
 * Live-only Playwright project: the specs under `tests/live/e2e/` need a real
 * OpenAI-compatible endpoint on :8033, so they never run in `test:e2e` (CI has
 * no model backend and must not download one). Run them with:
 *
 *   bun run test:e2e:live
 */
export default defineConfig({
  testDir: "./tests/live/e2e",
  timeout: 60000,
  retries: 0,
  workers: 1,
  use: {
    trace: "on-first-retry",
  },
});
