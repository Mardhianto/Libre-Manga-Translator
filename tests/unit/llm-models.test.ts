import { describe, it, expect } from "bun:test";
import { prebuiltAppConfig } from "@mlc-ai/web-llm";
import { DefaultConfig, resolveLangGroup } from "../../src/lib/configs";
import { llmAppConfig } from "../../src/lib/llm-engine";

/**
 * `DefaultConfig.llmModels` is a *hand-picked subset* of WebLLM's prebuilt
 * list, so it can silently rot two ways:
 *  - a model_id is dropped/renamed upstream → `reload()` throws "not found"
 *    only when a user selects it, possibly weeks later;
 *  - `weightMb` (download footprint, LMT-013) drifts from the real repo size.
 *
 * The first failure mode is cheap to bind here: every selectable id must exist
 * in the installed package's `prebuiltAppConfig`.
 */
const prebuilt = new Map(prebuiltAppConfig.model_list.map((m) => [m.model_id, m]));

describe("Local LLM model list ↔ installed WebLLM", () => {
  it("every selectable model_id exists in the installed prebuilt list", () => {
    for (const model of DefaultConfig.llmModels) {
      expect(
        prebuilt.has(model.id),
        `"${model.id}" is not in @mlc-ai/web-llm's prebuiltAppConfig — bump the package or fix the id`,
      ).toBe(true);
    }
  });

  it("only advertises models WebLLM can actually reload (no VLM/embedding)", () => {
    for (const model of DefaultConfig.llmModels) {
      const rec = prebuilt.get(model.id)!;
      // ModelType.LLM === 0; VLM/embedding would need a different call shape.
      expect(rec.model_type ?? 0, `${model.id} is not a plain LLM`).toBe(0);
    }
  });

  it("overrides applied by llmAppConfig keep every record addressable", () => {
    const ids = new Set(llmAppConfig.model_list.map((m) => m.model_id));
    for (const model of DefaultConfig.llmModels) {
      expect(ids.has(model.id), `${model.id} vanished from llmAppConfig`).toBe(true);
    }
  });

  it("requiresFeature entries really are shader-f16 models upstream", () => {
    // Guessing this wrong either hides a working model or downloads GBs
    // before WebLLM throws ShaderF16SupportError.
    for (const model of DefaultConfig.llmModels) {
      const upstream = prebuilt.get(model.id);
      if (!upstream) continue;
      const needsF16 = (upstream.required_features ?? []).includes("shader-f16");
      expect(
        model.requiresFeature === "shader-f16",
        `${model.id}: requiresFeature=${model.requiresFeature ?? "none"} but upstream required_features=${JSON.stringify(upstream.required_features ?? [])}`,
      ).toBe(needsF16);
    }
  });

  it("every model carries a positive download footprint", () => {
    // weightMb replaced the VRAM string as the storage-size source (LMT-013);
    // a missing value would silently report 0 B of cached weights.
    for (const model of DefaultConfig.llmModels) {
      expect(model.weightMb, `${model.id} has no weightMb`).toBeGreaterThan(0);
    }
  });

  it("the default model is the first entry and normalizes to itself", () => {
    const first = DefaultConfig.llmModels[0].id;
    expect(prebuilt.has(first)).toBe(true);
    // Unknown/deprecated ids must land on a model that exists upstream.
    expect(prebuilt.has(DefaultConfig.llmModels[0].id)).toBe(true);
  });
});

/**
 * LMT-030 split "Latin" (an answer) from "Auto-Detect" (a placeholder until
 * the gate speaks). CI caught the selfcheck still asserting the old contract;
 * this pins it in a unit test so the next change to `resolveLangGroup` cannot
 * pass with a stale expectation.
 */
describe("resolveLangGroup contract", () => {
  it("throws nothing and returns a supported group for every UI language", () => {
    for (const lang of DefaultConfig.availableLanguages) {
      const { group } = resolveLangGroup(lang);
      expect(typeof group).toBe("string");
      expect(group.length).toBeGreaterThan(0);
    }
  });

  it('"Latin" is a direct answer, not a fallback', () => {
    expect(resolveLangGroup("Latin")).toEqual({ group: "latin", fellBack: false });
  });

  it('"Auto-Detect" is a latin *placeholder* that admits it fell back', () => {
    expect(resolveLangGroup("Auto-Detect")).toEqual({ group: "latin", fellBack: true });
  });

  it("mapped languages resolve without a fallback", () => {
    for (const lang of ["Japanese", "Korean", "Thai", "Chinese (Simplified)", "English"]) {
      expect(resolveLangGroup(lang).fellBack, lang).toBe(false);
    }
  });

  it("an unknown language falls back to latin and says so", () => {
    expect(resolveLangGroup("Klingon")).toEqual({ group: "latin", fellBack: true });
    expect(resolveLangGroup("")).toEqual({ group: "latin", fellBack: true });
  });
});
