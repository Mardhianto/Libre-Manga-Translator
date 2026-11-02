import {
  TranslationValidationError,
  maskUntranslated,
  parseLlmJson,
  validateTranslationResult,
} from "../src/lib/server/validator";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

// Valid response
const valid = validateTranslationResult(
  {
    translations: ["Hello", "World"],
    sourceTexts: ["こんにちは", "世界"],
    context: { summary: "Manga chapter 1", dictionary: "term=def" },
  },
  2,
);
assert(valid.translations.length === 2, "translations length should be 2");
assert(valid.translations[0] === "Hello", "translation[0] should be Hello");
assert(valid.context?.summary === "Manga chapter 1", "summary should match");
assert(valid.diagnostics.clean === true, "genuine translation must be clean");

// Object items and Box N maps are normalized, not stringified.
const objectItems = validateTranslationResult(
  {
    translations: [
      { box: 1, text: "Hi" },
      { box: 2, translation: "There" },
    ],
  },
  2,
);
assert(
  objectItems.translations.join("|") === "Hi|There",
  "object items must unwrap text/translation",
);

const boxMap = validateTranslationResult({ "Box 1": "A", "Box 2": "B" }, 2);
assert(boxMap.translations.join("|") === "A|B", "Box N maps must normalize");

// Count mismatch is always a typed error: never pad, never truncate.
for (const input of [{ translations: ["One"] }, { translations: ["A", "B", "C"] }]) {
  let mismatch: unknown;
  try {
    validateTranslationResult(input, 2);
  } catch (error) {
    mismatch = error;
  }
  assert(
    mismatch instanceof TranslationValidationError,
    "count mismatch must throw TranslationValidationError",
  );
  assert(
    (mismatch as TranslationValidationError).code === "COUNT_MISMATCH",
    "count mismatch code must be COUNT_MISMATCH",
  );
}

// Unknown objects must never be painted.
let badItemThrown = false;
try {
  validateTranslationResult({ translations: [{ key: "val" }] }, 1);
} catch (error) {
  badItemThrown = error instanceof TranslationValidationError;
}
assert(badItemThrown, "unknown object items must throw, not stringify");

// Non-object should throw
let nonObjectThrown = false;
try {
  validateTranslationResult("not an object", 0);
} catch {
  nonObjectThrown = true;
}
assert(nonObjectThrown, "Non-object must throw error");

// Echoed Japanese is flagged and masked.
const echoed = validateTranslationResult(
  { translations: ["こんにちは"] },
  1,
  { sourceTexts: ["こんにちは"], sourceLang: "Japanese", targetLang: "English" },
);
assert(echoed.diagnostics.untranslated[0] === 0, "echoed box must be flagged");
assert(
  maskUntranslated(echoed.translations, echoed.diagnostics.untranslated)[0] === "",
  "maskUntranslated must empty echoed boxes",
);
assert(echoed.diagnostics.clean === false, "echoed page must not be clean");

// parseLlmJson: chatty LLM preamble + code fence + trailing explanation
const chatty = parseLlmJson(
  "Here’s the translation and analysis based on the provided dialogue:\n\n```json\n" +
    '{"translations": ["One", "None", "None"], "context": {"summary": "s", "dictionary": "None"}}\n' +
    "```\n\n### Explanation:\n1. **Summary**: polite request.",
);
assert(
  Array.isArray(chatty.translations) && chatty.translations.length === 3,
  "parseLlmJson must extract 3 translations from chatty markdown",
);

// parseLlmJson: raw object without fences
const raw = parseLlmJson('{"translations": ["A", "B"]}');
assert(raw.translations[0] === "A", "parseLlmJson must parse raw JSON");

// parseLlmJson: bare JSON array
const arr = parseLlmJson('["X", "Y"]');
assert(Array.isArray(arr) && arr[1] === "Y", "parseLlmJson must parse bare array");

// parseLlmJson: garbage must throw
let garbageThrown = false;
try {
  parseLlmJson("no json here at all");
} catch {
  garbageThrown = true;
}
assert(garbageThrown, "parseLlmJson must throw on unparseable content");

console.log("PASS: validateTranslationResult self-check passed.");
