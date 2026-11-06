import { DefaultConfig } from "./configs";

/**
 * Per-job execution budgets for heavy work forwarded to the offscreen
 * document (LMT-010 / LMT-027).
 *
 * The numbers live in `DefaultConfig` so they are one grep away; the
 * resolution lives here because it is pure, so the budget can be unit-tested
 * without importing the background service worker (`wxt/browser`).
 */
export interface JobTimeoutInput {
  /** Forwarded message type, without the `OFFSCREEN_` prefix. */
  type: string;
  /** `config.currentMode`: `webgpu` | `gemini` | `api`. */
  mode?: string | null;
  /** Text regions on the page. The API budget scales with this. */
  boxes?: number;
  /** Inpaint method: `quality` runs LaMa once per region. */
  method?: string | null;
}

export function resolveJobTimeout({
  type,
  mode,
  boxes = 0,
  method,
}: JobTimeoutInput): number {
  const regions = Number.isFinite(boxes) ? Math.max(0, Math.floor(boxes)) : 0;

  if (type === "INPAINT_IMAGE") {
    return method === "quality"
      ? Math.max(
          DefaultConfig.timeoutQualityInpaintMs,
          regions * DefaultConfig.timeoutQualityInpaintPerBoxMs,
        )
      : DefaultConfig.timeoutInpaintMs;
  }

  if (type === "TRANSLATE_IMAGE") {
    if (!mode || mode === "webgpu") return DefaultConfig.timeoutLocalTranslateMs;
    if (mode === "api") {
      // A page costs at least one round-trip and at most one correction, each
      // proportional to the number of boxes. Scaling beats a flat page budget
      // that cuts off a 40-box page mid-answer.
      return Math.max(
        DefaultConfig.timeoutApiTranslateMs,
        regions * DefaultConfig.timeoutApiTranslatePerBoxMs,
      );
    }
    return DefaultConfig.timeoutGeminiTranslateMs;
  }

  // DETECT_BBOX, MAKE_SITE_RULE_AI and every other single short call.
  return DefaultConfig.timeoutShortJobMs;
}

/**
 * Background-side guard. The offscreen document replies (or throws) at
 * `budgetMs`; only a document that died mid-job stays silent past this, which
 * is the one case where freeing the semaphore before the work stopped is safe.
 */
export function resolveJobGuardTimeout(budgetMs: number): number {
  return budgetMs + DefaultConfig.timeoutGuardGraceMs;
}
