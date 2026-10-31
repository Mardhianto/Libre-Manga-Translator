import * as ort from "onnxruntime-web/all";
import {
  boostContrast,
  buildCharset,
  cropBubbleFromImage,
  ctcDecode,
  normalizePolarity,
  padImageForOCR,
  preprocessCrop,
  sliceImageDataIntoLines,
} from "./utils";
import { createRunLock, downloadArtifactHF, yieldToMain } from "../utils";
import { DefaultConfig } from "../configs";
import { env } from "../env";
import type { OcrEngine, SingleOcrResult } from "./types";
import type { GateReason } from "../gate";

export interface PaddleEngineOptions {
  id?: string;
  label?: string;
  /** Defaults to the per-language PaddleOCR repo. */
  repo?: string;
  /** Defaults to the per-group `languages/<group>/rec.onnx`. A fixed file ignores the group. */
  modelPath?: (langGroup: string) => `${string}.onnx`;
  /** Extension-local dict asset (e.g. bundled PP-OCRv6 dict) — skips the HF dict fetch. */
  bundledDictPath?: string;
}

export class PaddleOcrEngine implements OcrEngine {
  id = "paddle";
  label = "PaddleOCR (Multilingual)";

  private session: ort.InferenceSession | null = null;
  private charset: string[] | null = null;
  private charsetKey: string | null = null;
  private currentLangGroup: string | null = null;
  /** Active provider key for mismatch-recreate (e.g. "wasm" vs "webgpu+wasm"). */
  private sessionProvider: string | null = null;
  private runExclusive = createRunLock("paddle-ocr");

  constructor(private opts: PaddleEngineOptions = {}) {
    if (opts.id) this.id = opts.id;
    if (opts.label) this.label = opts.label;
  }

  async release(): Promise<void> {
    if (this.session) {
      try {
        await this.session.release();
      } catch (err) {
        console.warn("Failed to cleanly release PaddleOCR session:", err);
      }
      this.session = null;
      this.charset = null;
      this.charsetKey = null;
      this.currentLangGroup = null;
      this.sessionProvider = null;
    }
  }

  /**
   * Load or return cached charset for the given language group.
   * Keyed on repo + langGroup (+ bundled dict path) so a model swap
   * never reuses a stale dictionary from a previous language.
   */
  private async ensureCharset(repo: string, langGroup: string): Promise<string[]> {
    const dictKey = this.opts.bundledDictPath
      ? `bundled:${this.opts.bundledDictPath}`
      : `${repo}:${DefaultConfig.ocrDictPath(langGroup)}`;
    if (this.charset && this.charsetKey === dictKey) return this.charset;
    if (this.opts.bundledDictPath) {
      const url = (browser as unknown as { runtime: { getURL: (p: string) => string } }).runtime.getURL(this.opts.bundledDictPath as unknown as string);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed to load bundled dict: ${res.status} ${res.statusText}`);
      const dictText = await res.text();
      this.charset = buildCharset(dictText);
    } else {
      const dictResp = await downloadArtifactHF(repo, DefaultConfig.ocrDictPath(langGroup));
      const dictText = await dictResp.text();
      if (!dictText || dictText.trim().length === 0) throw new Error(`Empty dictionary for ${langGroup}`);
      this.charset = buildCharset(dictText);
    }
    this.charsetKey = dictKey;
    return this.charset;
  }

  async recognize(
    bitmap: ImageBitmap,
    bboxes: Bbox[],
    sourceLang: string,
    regionLines: ImageData[][],
    gateSkip: (GateReason | null)[],
    options?: {
      minConfidence?: number;
      batchSize?: number;
      recImgHeight?: number;
      langGroup?: string;
    },
  ): Promise<SingleOcrResult[]> {
    const minConfidence = options?.minConfidence ?? DefaultConfig.ocrMinConfidence;
    const batchSize = options?.batchSize ?? DefaultConfig.ocrBatchSize;
    const recImgHeight = options?.recImgHeight ?? DefaultConfig.ocrRecImgHeight;
    const langGroup = options?.langGroup ?? "latin";
    const repo = this.opts.repo ?? DefaultConfig.ocrRepo;
    const modelFile = (this.opts.modelPath ?? DefaultConfig.ocrModelPath)(langGroup);
    // Key on the resolved file: per-group packs swap, a fixed-file engine
    // (PP-OCRv6 manga) keeps its session across language changes.
    const key = `${repo}:${modelFile}`;

    const crops = bboxes
      .map((bbox, index) =>
        gateSkip[index]
          ? []
          : regionLines[index].map((imageData) => ({
              slotIndex: index,
              imageData,
            })),
      )
      .flat();

    const result = await this.runExclusive(async () => {
      if (this.session && this.currentLangGroup !== key) {
        console.info(`[ocr] swapping rec model: ${this.currentLangGroup} → ${key}`);
        await this.release();
      }

      if (!this.session) {
        console.info(`[ocr] loading rec model: ${repo}/${modelFile}`);
        this.session = await downloadArtifactHF(repo, modelFile);
        this.currentLangGroup = key;
        // Record provider for future mismatch checks (extension-local probe may flip wasm↔webgpu).
        try {
          const maybeProviders = (this.session as unknown as { providers?: string[] })?.providers;
          this.sessionProvider = Array.isArray(maybeProviders) ? maybeProviders.join("+") : "wasm";
        } catch {
          this.sessionProvider = "wasm";
        }
      }

      await this.ensureCharset(repo, langGroup);

      return await this.runBatches(
        crops,
        batchSize,
        recImgHeight,
        minConfidence,
        bboxes.length,
        langGroup,
      );
    });

    // The consumer below indexes `result` by bbox position, so a length
    // change here would silently shift every bubble by one.
    if (result.length !== bboxes.length) {
      throw new Error(
        `[paddle] result/bbox length mismatch: ${result.length} results for ${bboxes.length} boxes`,
      );
    }

    // Retry path for empty results (regions that were not gate-skipped)
    const failedIndexes = result
      .map((r, i) => (r.failed && !gateSkip[i] ? i : -1))
      .filter((i) => i >= 0);

    if (failedIndexes.length > 0) {
      const retryCrops = failedIndexes
        .map((bboxIdx, retryIdx) => {
          const rawCrop = cropBubbleFromImage(
            bitmap,
            bboxes[bboxIdx],
            sourceLang,
            this.id,
          );
          const normalizedCrop = normalizePolarity(rawCrop);
          const boostedCrop = boostContrast(normalizedCrop);
          const paddedCrop = padImageForOCR(boostedCrop, 6);

          const bubbleH = bboxes[bboxIdx].y2 - bboxes[bboxIdx].y1;
          const bubbleW = bboxes[bboxIdx].x2 - bboxes[bboxIdx].x1;
          const isSingleLine = Math.min(bubbleH, bubbleW) < 24;

          const lines = isSingleLine
            ? [paddedCrop]
            : sliceImageDataIntoLines(paddedCrop);

          return lines.map((imageData) => ({
            // Position within `failedIndexes`, NOT a bbox index. The
            // re-mapping below converts it back; keep the two in lockstep.
            slotIndex: retryIdx,
            imageData: padImageForOCR(imageData, 4),
          }));
        })
        .flat();

      const retryResults = await this.runExclusive(async () => {
        return await this.runBatches(
          retryCrops,
          batchSize,
          recImgHeight,
          minConfidence,
          failedIndexes.length,
          langGroup,
        );
      });

      // `runBatches` allocates one slot per `slotCount` argument, so this
      // must hold exactly; a per-line return would put translated text in
      // the wrong bubble via the positional remap below.
      if (retryResults.length !== failedIndexes.length) {
        throw new Error(
          `[paddle] retry/slot length mismatch: ${retryResults.length} results for ${failedIndexes.length} retry slots`,
        );
      }

      failedIndexes.forEach((origIdx, retryIdx) => {
        if (!retryResults[retryIdx].failed) {
          result[origIdx] = retryResults[retryIdx];
        }
      });
    }

    return result;
  }

  /**
   * `slotIndex` is the position in the returned array, so the caller decides
   * what a slot means: a bbox index on the primary pass, a retry-slot index on
   * the retry pass. `slotCount` is the number of slots, i.e. result length.
   */
  private async runBatches(
    crops: { slotIndex: number; imageData: ImageData }[],
    batchSize: number,
    recImgHeight: number,
    minConfidence: number,
    slotCount: number,
    langGroup: string,
  ): Promise<SingleOcrResult[]> {
    if (!this.session || !this.charset) {
      throw new Error("PaddleOCR session or charset not initialized");
    }

    const stitchedResults = Array.from({ length: slotCount }, () => ({
      text: "",
      totalConf: 0,
      lineCount: 0,
    }));

    for (let start = 0; start < crops.length; start += batchSize) {
      await yieldToMain();
      const end = Math.min(crops.length, start + batchSize);
      const batchData = crops.slice(start, end);
      const batchImages = batchData.map(({ imageData }) => imageData);

      if (batchImages.length === 0) continue;

      const whRatios = batchImages.map((c) => c.width / c.height);
      const maxWHRatio = Math.max(...whRatios);
      const targetW = Math.max(Math.ceil(recImgHeight * maxWHRatio), 1);

      const preprocessed = batchImages.map((c) =>
        preprocessCrop(c, targetW, recImgHeight),
      );

      const N = batchImages.length;
      const channels = 3;
      const sliceSize = channels * recImgHeight * targetW;
      const batchBuffer = new Float32Array(N * sliceSize);
      preprocessed.forEach((tensor, i) => {
        batchBuffer.set(tensor.data as Float32Array, i * sliceSize);
      });

      const inputTensor = new ort.Tensor("float32", batchBuffer, [
        N,
        channels,
        recImgHeight,
        targetW,
      ]);

      await yieldToMain();
      let output: ort.Tensor | null = null;
      try {
        const inputName = this.session.inputNames[0];
        const outputMap = await this.session.run({ [inputName]: inputTensor });
        await yieldToMain();
        const outputName = this.session.outputNames[0];
        output = outputMap[outputName];

        const [, T, C] = output.dims as number[];
        const outputData = output.data as Float32Array;

        for (let i = 0; i < N; i++) {
          const slice = outputData.slice(i * T * C, (i + 1) * T * C);
          const decoded = ctcDecode(slice, this.charset, C, langGroup);
          const textLen = decoded.text.trim().length;

          if (decoded.confidence >= minConfidence) {
            const isSingleCharNoise =
              textLen === 1 && decoded.confidence < Math.max(minConfidence, 0.75);

            if (!isSingleCharNoise && textLen > 0) {
              const slot = batchData[i].slotIndex;
              const target = stitchedResults[slot];
              if (!target) {
                throw new Error(
                  `[paddle] crop ${i} claims slot ${slot}, outside 0..${stitchedResults.length - 1}`,
                );
              }

              const newText = decoded.text.trim();

              if (target.text.endsWith("-")) {
                target.text = target.text.slice(0, -1) + newText;
              } else {
                target.text += (target.text ? " " : "") + newText;
              }

              target.totalConf += decoded.confidence;
              target.lineCount += 1;
            }
          }
        }
      } finally {
        inputTensor?.dispose?.();
        output?.dispose?.();
      }
    }

    return stitchedResults.map(({ text, totalConf, lineCount }) => {
      if (lineCount === 0) {
        return { text: "", confidence: 0, failed: true };
      }
      return {
        text: text.trim(),
        confidence: lineCount > 0 ? totalConf / lineCount : 0,
      };
    });
  }
}
