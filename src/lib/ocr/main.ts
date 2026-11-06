import {
  boostContrast,
  cropBubbleFromImage,
  normalizePolarity,
  padImageForOCR,
  sliceImageDataIntoLines,
} from "./utils";
import { fetchAsImageBitmap } from "../utils";
import { DefaultConfig, resolveLangGroup } from "../configs";
import {
  bestLabel,
  groupForLabel,
  majorityLabel,
  decideSkip,
  gateModeFor,
  type GateMode,
  type GateSummary,
  type RegionVerdict,
} from "../gate";
import { judgeRegion, loadGate } from "../gate/osd";
import type { GateReason } from "../gate";
import { isTrustedLabel } from "../gate/charset";
import type { OCRResult, OcrEngine, OcrOutcome } from "./types";
import { PaddleOcrEngine } from "./paddle";
import { MangaOcrEngine } from "./manga-ocr";
import { PororoOcrEngine } from "./pororo";
import { env } from "../env";

export type { OCRResult, OcrOutcome };

const paddleEngine = new PaddleOcrEngine();
const mangaOcrEngine = new MangaOcrEngine();
const pororoEngine = new PororoOcrEngine();
// PP-OCRv6 small rec, manga fine-tune (Japanese-only): same CTC contract as
// PaddleOCR (48px height, stock ppocrv6 dict + space + blank), fixed file +
// bundled dict, so it reuses the Paddle runner.
const ppocrv6MangaEngine = new PaddleOcrEngine({
  id: "ppocrv6-manga",
  label: "PP-OCRv6 Manga (Japanese)",
  repo: env.ppocrv6MangaRepo,
  modelPath: () => "ppocr-rec-v6-small-manga.onnx",
  bundledDictPath: "dicts/ppocrv6_dict.txt",
});

export function getOcrEngine(id = DefaultConfig.ocrEngine): OcrEngine {
  if (id === "manga-ocr") return mangaOcrEngine;
  if (id === "ppocrv6-manga") return ppocrv6MangaEngine;
  if (id === "pororo") return pororoEngine;
  return paddleEngine;
}

/** Release all OCR engine sessions so a GPU provider flip recreates them lazily. */
export async function releaseOcrEngines(): Promise<void> {
  await Promise.all([
    paddleEngine.release?.(),
    mangaOcrEngine.release?.(),
    pororoEngine.release?.(),
    ppocrv6MangaEngine.release?.(),
  ].filter(Boolean));
}

/**
 * Agnostic OCR Coordinator with script gate:
 * 1. Line-slicing & contrast normalization
 * 2. OSD script identification pass
 * 3. Pre-filtering confident wrong-script boxes
 * 4. Delegation to chosen OcrEngine (PaddleOCR or Manga-OCR)
 * 5. Post-OCR text-script verification (cjkShare / classShare rescue)
 */
export async function textRecognise(
  imageSrc: string,
  bboxes: Bbox[],
  sourceLang: string,
  minConfidence = DefaultConfig.ocrMinConfidence,
  batchSize = DefaultConfig.ocrBatchSize,
  recImgHeight = DefaultConfig.ocrRecImgHeight,
  gateOptions?: { enabled?: boolean; force?: boolean },
  engineId?: string,
): Promise<OcrOutcome> {
  const mode: GateMode = gateModeFor(
    sourceLang,
    gateOptions?.enabled ?? true,
    gateOptions?.force ?? false,
  );

  const bitmap = await fetchAsImageBitmap(imageSrc);
  try {
    // Crop + slice once; the gate and the recognizer read the same lines.
    // Fix: give the 64px line reader wider margins and stickier merges.
    const isPororo = engineId === "pororo";
    const regionLines: ImageData[][] = bboxes.map((bbox) => {
      const rawCrop = cropBubbleFromImage(bitmap, bbox, sourceLang, engineId);
      const normalizedCrop = normalizePolarity(rawCrop);
      const boostedCrop = boostContrast(normalizedCrop);
      const bubbleH = bbox.y2 - bbox.y1;
      const bubbleW = bbox.x2 - bbox.x1;
      const isSingleLine = Math.min(bubbleH, bubbleW) < 24;
      const pad = isPororo ? 6 : 4;
      if (isSingleLine) return [padImageForOCR(boostedCrop, pad)];
      const lines = isPororo
        ? sliceImageDataIntoLines(boostedCrop, {
            thresholdRatio: 0.35,
            mergeGap: 6,
            padX: 6,
            padY: 6,
          })
        : sliceImageDataIntoLines(boostedCrop);
      return lines.map((line) => padImageForOCR(line, pad));
    });

    // --- script-ID pass ---
    let gateLoaded = false;
    if (mode !== "off") gateLoaded = await loadGate();
    const verdicts: (RegionVerdict | null)[] = new Array(bboxes.length).fill(null);
    if (mode !== "off" && gateLoaded) {
      for (let i = 0; i < bboxes.length; i++) {
        verdicts[i] = await judgeRegion(regionLines[i]);
      }
    }

    let pageLabel: string | null = null;
    let langGroup: string;
    let groupSource: GateSummary["groupSource"] = "explicit";
    if (mode === "auto" && gateLoaded) {
      const cast = verdicts.filter((v): v is RegionVerdict => v !== null);
      pageLabel = majorityLabel(cast);
      if (!pageLabel) {
        // LMT-030: no majority is not the same as no evidence. The strongest
        // label still names a script; refusing it here used to fall through to
        // `latin` and read a Japanese page with the Latin rec pack silently.
        pageLabel = bestLabel(cast);
        if (pageLabel) {
          console.info(
            `[ocr] auto-detect: no page majority; using best label "${pageLabel}" (${groupForLabel(pageLabel) ?? "unmapped"})`,
          );
        }
      }
    }
    const gateGroup = mode === "auto" && gateLoaded ? groupForLabel(pageLabel) : null;
    if (gateGroup) {
      langGroup = gateGroup;
      groupSource = "gate";
    } else {
      const resolved = resolveLangGroup(sourceLang);
      langGroup = resolved.group;
      // Resolved by the user's pick, or an assumption? Only the assumption
      // earns a warning/log entry — a chosen "Latin" is not a fallback.
      groupSource = resolved.fellBack ? "fallback" : "explicit";
      if (resolved.fellBack) {
        console.warn(
          sourceLang === "Auto-Detect"
            ? `[ocr] auto-detect found no script evidence — assuming languages/${langGroup}/rec.onnx`
            : `[ocr] "${sourceLang}" has no dedicated rec model — using languages/${langGroup}/rec.onnx`,
        );
      }
    }

    // Pre-filter: a CONFIDENT, TRUSTED wrong-script refusal never gets read
    const filterEnabled = gateOptions?.enabled ?? true;
    const gateSkip: (GateReason | null)[] = new Array(bboxes.length).fill(null);
    if (filterEnabled && mode === "cjk" && gateLoaded) {
      for (let i = 0; i < bboxes.length; i++) {
        const v = verdicts[i];
        if (v && v.decision === "wrong-script" && isTrustedLabel(v.script)) {
          gateSkip[i] = "not-japanese";
        }
      }
    }

    const engine = getOcrEngine(engineId);
    const rawResults = await engine.recognize(
      bitmap,
      bboxes,
      sourceLang,
      regionLines,
      gateSkip,
      {
        minConfidence,
        batchSize,
        recImgHeight,
        langGroup,
      },
    );

    const result: OCRResult[] = rawResults.map((r, i) => ({
      text: r.text,
      confidence: r.confidence,
      failed: r.failed,
      gateSkip: gateSkip[i],
    }));

    // Post-OCR verification & rescue
    let skipped = gateSkip.filter((s) => s !== null).length;
    for (let i = 0; i < bboxes.length; i++) {
      if (gateSkip[i]) continue; // already skipped by pre-filter
      const reason = filterEnabled
        ? decideSkip(
            mode,
            verdicts[i],
            result[i].text,
            sourceLang,
            pageLabel,
          )
        : null;
      if (reason) {
        result[i].gateSkip = reason;
        skipped++;
      }
    }

    const gate: GateSummary = {
      mode,
      checked: verdicts.filter((v) => v !== null).length,
      skipped,
      group: langGroup,
      unavailable: mode !== "off" && !gateLoaded,
      // Only meaningful under Auto-Detect: an explicit source is the user's
      // answer, not a detection result.
      label: mode === "auto" ? pageLabel ?? "" : undefined,
      groupSource,
    };

    return { results: result, gate };
  } finally {
    try {
      bitmap.close();
    } catch (err) {
      console.warn("Failed to close OCR source bitmap:", err);
    }
  }
}
