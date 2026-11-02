import { describe, it, expect } from "bun:test";
import {
  TranslationValidationError,
  maskUntranslated,
  parseLlmJson,
  validateTranslationResult,
} from "../../src/lib/server/validator";

describe("parseLlmJson", () => {
  it("parses pure JSON", () => {
    const res = parseLlmJson('{"translations": ["Hello", "World"]}');
    expect(res.translations).toEqual(["Hello", "World"]);
  });

  it("extracts JSON from markdown codeblock", () => {
    const text = "```json\n{\"translations\": [\"One\", \"Two\"]}\n```";
    expect(parseLlmJson(text).translations).toEqual(["One", "Two"]);
  });

  it("extracts JSON from raw fenced codeblock with LLM conversation preamble", () => {
    const text = "Sure! Here is the output:\n```\n{\"translations\": [\"Alpha\", \"Beta\"]}\n```\nHope this helps!";
    expect(parseLlmJson(text).translations).toEqual(["Alpha", "Beta"]);
  });

  it("extracts raw outermost JSON object when fences are missing", () => {
    const text = "Here you go: {\"translations\": [\"Raw\"]} have a great day!";
    expect(parseLlmJson(text).translations).toEqual(["Raw"]);
  });

  it("extracts raw outermost JSON array", () => {
    const text = "Prefix [\"First\", \"Second\"] suffix";
    expect(parseLlmJson(text)).toEqual(["First", "Second"]);
  });

  it("throws for unparseable input", () => {
    expect(() => parseLlmJson("not json at all")).toThrow("Failed to parse server JSON");
  });
});

describe("validateTranslationResult", () => {
  it("validates well-formed translation and preserves context and sourceTexts", () => {
    const input = {
      translations: ["Hello", "World"],
      sourceTexts: ["こんにちは", "世界"],
      context: { summary: "Chapter 1", dictionary: "A=B" },
    };
    const result = validateTranslationResult(input, 2);
    expect(result.translations).toEqual(["Hello", "World"]);
    expect(result.sourceTexts).toEqual(["こんにちは", "世界"]);
    expect(result.context?.summary).toBe("Chapter 1");
    expect(result.context?.dictionary).toBe("A=B");
    expect(result.diagnostics).toEqual({
      expectedCount: 2,
      receivedCount: 2,
      untranslated: [],
      clean: true,
    });
  });

  it("accepts a bare array", () => {
    expect(validateTranslationResult(["A", "B"], 2).translations).toEqual(["A", "B"]);
  });

  it("unwraps object items and preserves their text", () => {
    const result = validateTranslationResult(
      {
        translations: [
          { box: 1, text: "Hi" },
          { box: 2, translation: "There" },
          { box: 3, content: "Friend" },
        ],
      },
      3,
    );
    expect(result.translations).toEqual(["Hi", "There", "Friend"]);
  });

  it("sorts indexed object items into their declared slots", () => {
    const result = validateTranslationResult(
      [
        { box: 2, text: "Second" },
        { box: 1, text: "First" },
      ],
      2,
    );
    expect(result.translations).toEqual(["First", "Second"]);
  });

  it("accepts a single-box object", () => {
    expect(validateTranslationResult({ box: 1, text: "Hi" }, 1).translations).toEqual([
      "Hi",
    ]);
  });

  it("accepts nested and top-level Box N maps", () => {
    expect(
      validateTranslationResult(
        { translations: { "Box 1": "A", "Box 2": "B" } },
        2,
      ).translations,
    ).toEqual(["A", "B"]);

    expect(
      validateTranslationResult({ "Box 1": "A", "Box 2": "B" }, 2).translations,
    ).toEqual(["A", "B"]);
  });

  it("coerces primitives but never stringifies unknown objects", () => {
    const result = validateTranslationResult(
      { translations: [123, null, undefined, "valid"] },
      4,
    );
    expect(result.translations).toEqual(["123", "", "", "valid"]);

    expect(() =>
      validateTranslationResult({ translations: [{ key: "val" }] }, 1),
    ).toThrow(TranslationValidationError);
  });

  it("throws a typed error on short and long arrays instead of padding/truncating", () => {
    for (const input of [
      { translations: ["OnlyOne"] },
      { translations: ["A", "B", "C"] },
    ]) {
      try {
        validateTranslationResult(input, 2);
        throw new Error("expected validation to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(TranslationValidationError);
        expect((error as TranslationValidationError).code).toBe("COUNT_MISMATCH");
      }
    }
  });

  it("throws on a Box map with a missing slot", () => {
    expect(() =>
      validateTranslationResult({ "Box 1": "A", "Box 3": "C" }, 3),
    ).toThrow(TranslationValidationError);
  });

  it("throws when translations is missing or not a list", () => {
    expect(() => validateTranslationResult(null, 1)).toThrow("not an object");
    expect(() => validateTranslationResult({ translations: "not array" }, 1)).toThrow(
      "must be an array",
    );
    expect(() => validateTranslationResult({ wrong: [] }, 1)).toThrow(
      "no translation list found",
    );
  });

  it("throws when sourceTexts is not an array", () => {
    expect(() => {
      validateTranslationResult({ translations: ["A"], sourceTexts: "bad" }, 1);
    }).toThrow("'sourceTexts' must be an array");
  });

  it("flags an exact echo as untranslated", () => {
    const result = validateTranslationResult(
      { translations: ["こんにちは"] },
      1,
      {
        sourceTexts: ["こんにちは"],
        sourceLang: "Japanese",
        targetLang: "English",
      },
    );
    expect(result.diagnostics.untranslated).toEqual([0]);
    expect(result.diagnostics.clean).toBe(false);
    expect(maskUntranslated(result.translations, result.diagnostics.untranslated)).toEqual([
      "",
    ]);
  });

  it("flags a single-character exact echo", () => {
    const result = validateTranslationResult({ translations: ["あ"] }, 1, {
      sourceTexts: ["あ"],
      sourceLang: "Japanese",
      targetLang: "English",
    });
    expect(result.diagnostics.untranslated).toEqual([0]);
  });

  it("flags a partial echo when source and target scripts are disjoint", () => {
    const result = validateTranslationResult(
      { translations: ["こんにちは、元気ですか？"] },
      1,
      {
        sourceTexts: ["おはよう、元気ですか？"],
        sourceLang: "Japanese",
        targetLang: "English",
      },
    );
    expect(result.diagnostics.untranslated).toEqual([0]);
  });

  it("falls back to the text's script when the declared source language is wrong", () => {
    const result = validateTranslationResult(
      { translations: ["こんにちは、元気ですか？"] },
      1,
      {
        sourceTexts: ["おはよう、元気ですか？"],
        sourceLang: "English",
        targetLang: "English",
      },
    );
    expect(result.diagnostics.untranslated).toEqual([0]);
  });

  it("does not flag a genuine translation", () => {
    const result = validateTranslationResult(
      { translations: ["Hello, how are you?"] },
      1,
      {
        sourceTexts: ["こんにちは、元気ですか？"],
        sourceLang: "Japanese",
        targetLang: "English",
      },
    );
    expect(result.diagnostics.untranslated).toEqual([]);
    expect(result.diagnostics.clean).toBe(true);
  });

  it("does not flag short CJK when the target also uses CJK", () => {
    const result = validateTranslationResult(
      { translations: ["你好"] },
      1,
      {
        sourceTexts: ["こんにちは"],
        sourceLang: "Japanese",
        targetLang: "Chinese (Simplified)",
      },
    );
    expect(result.diagnostics.untranslated).toEqual([]);
  });

  it("ignores echo checks when source texts do not line up", () => {
    const result = validateTranslationResult(
      { translations: ["こんにちは"] },
      1,
      { sourceTexts: [], sourceLang: "Japanese", targetLang: "English" },
    );
    expect(result.diagnostics.untranslated).toEqual([]);
  });

  it("sanitizes context fields", () => {
    const result = validateTranslationResult(
      {
        translations: ["A"],
        context: { summary: 123, dictionary: ["x"] },
      },
      1,
    );
    expect(result.context).toEqual({ summary: "", dictionary: "" });
  });
});
