import * as ort from "onnxruntime-web/all";
import {
  boostContrast,
  cropBubbleFromImage,
  normalizePolarity,
  padImageForOCR,
  sliceImageDataIntoLines,
} from "./utils";
import { createRunLock, downloadArtifactHF, yieldToMain } from "../utils";
import { DefaultConfig } from "../configs";
import { env } from "../env";
import type { OcrEngine, SingleOcrResult } from "./types";
import type { GateReason } from "../gate";

const INPUT_HEIGHT = 64;
const INPUT_WIDTH = 640;
const FALLBACK_TIME_STEPS = 100;
const NUM_CLASSES = 2589;

// Fix: engine-local confidence floor. Product-scale scores run much lower
// than mean-scale, so the shared default would drop valid lines.
const PORORO_DEFAULT_MIN = 0.45;
const PORORO_MIN_CAP = 0.5;
const PORORO_PRODUCT_FLOOR = 0.02;

/**
 * Fix: lift washed-out strokes before resize.
 * Edge-sampled percentiles estimate ink vs paper; when the spread is
 * narrow the line is re-centered so thin strokes survive downscaling.
 */
function liftWashedPixels(crop: ImageData): ImageData {
  const w = crop.width;
  const h = crop.height;
  const n = w * h;
  if (n === 0) return crop;

  const src = crop.data;
  const gray = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const idx = i * 4;
    gray[i] = Math.round(
      0.299 * src[idx] + 0.587 * src[idx + 1] + 0.114 * src[idx + 2],
    );
  }
  const sorted = new Uint8Array(gray).sort();
  const low = sorted[Math.floor(n * 0.1)];
  const high = sorted[Math.floor(n * 0.9)];
  const spread = (high - low) / Math.max(10, high + low);
  if (spread >= 0.5) return crop;

  const range = Math.max(10, high - low);
  const ratio = 200.0 / range;
  const out = new Uint8ClampedArray(src);
  for (let i = 0; i < n; i++) {
    const idx = i * 4;
    for (let c = 0; c < 3; c++) {
      const v = (src[idx + c] - low + 25) * ratio;
      out[idx + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
  }
  return new ImageData(out, w, h);
}

/**
 * Preprocesses a cropped text line for Pororo BrainOCR (TPS-VGG-BiLSTM-CTC).
 *
 * Requirements:
 *  1. Grayscale luminance (L = 0.299*R + 0.587*G + 0.114*B)
 *  2. Scale to fixed height (64px), keeping aspect ratio up to max width (640px)
 *  3. Normalization to range [-1, 1] via (pixel / 255.0) * 2.0 - 1.0
 *  4. Right border padding by replicating the rightmost column to fill width 640
 *  5. Tensor format: [1, 1, 64, 640] Float32
 */
export function preprocessPororoLine(crop: ImageData): Float32Array {
  // Fix: normalize washed lines before measuring aspect so the resize
  // sees the same ink the decoder was trained on.
  const lifted = liftWashedPixels(crop);
  const naturalRatio = lifted.width / Math.max(1, lifted.height);
  const scaledW = Math.min(
    INPUT_WIDTH,
    Math.max(1, Math.ceil(INPUT_HEIGHT * naturalRatio)),
  );

  const srcCanvas = new OffscreenCanvas(lifted.width, lifted.height);
  const srcCtx = srcCanvas.getContext("2d")!;
  srcCtx.putImageData(lifted, 0, 0);

  const resizedCanvas = new OffscreenCanvas(scaledW, INPUT_HEIGHT);
  const ctx = resizedCanvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    srcCanvas,
    0,
    0,
    lifted.width,
    lifted.height,
    0,
    0,
    scaledW,
    INPUT_HEIGHT,
  );

  const raw = ctx.getImageData(0, 0, scaledW, INPUT_HEIGHT).data;

  // Single-channel grayscale buffer of shape [1, INPUT_HEIGHT, INPUT_WIDTH]
  const planeSize = INPUT_HEIGHT * INPUT_WIDTH;
  const buffer = new Float32Array(planeSize);

  for (let row = 0; row < INPUT_HEIGHT; row++) {
    // Read the rightmost pixel in this row to replicate for right padding
    const lastColIdx = (row * scaledW + (scaledW - 1)) * 4;
    const lastColGray =
      0.299 * raw[lastColIdx] +
      0.587 * raw[lastColIdx + 1] +
      0.114 * raw[lastColIdx + 2];
    const lastColNorm = (lastColGray / 255.0) * 2.0 - 1.0;

    for (let col = 0; col < INPUT_WIDTH; col++) {
      const destIdx = row * INPUT_WIDTH + col;
      if (col < scaledW) {
        const srcIdx = (row * scaledW + col) * 4;
        const gray =
          0.299 * raw[srcIdx] +
          0.587 * raw[srcIdx + 1] +
          0.114 * raw[srcIdx + 2];
        buffer[destIdx] = (gray / 255.0) * 2.0 - 1.0;
      } else {
        // Replicate last column to the right edge (matches PyTorch NormalizePAD)
        buffer[destIdx] = lastColNorm;
      }
    }
  }

  return buffer;
}

/**
 * Parses vocabulary from `ocr-opt.txt`.
 * The file contains multiple option blocks; the final section defines the active
 * 2588 characters (+ 1 CTC blank = 2589 classes).
 */
export function parsePororoVocab(optText: string): string[] {
  let characterString = "";

  for (const line of optText.split("\n")) {
    const l = line.trim();
    if (l.startsWith("character:")) {
      characterString = l.slice("character:".length).trim();
    }
  }

  if (!characterString) {
    throw new Error("Failed to parse 'character' set from Pororo ocr-opt.txt");
  }

  // Index 0 is [blank] for CTC loss/decoding, followed by the characters
  const vocab = ["[blank]", ...Array.from(characterString)];
  if (vocab.length !== NUM_CLASSES) {
    console.warn(
      `[pororo] Vocab length (${vocab.length}) differs from expected (${NUM_CLASSES})`,
    );
  }

  return vocab;
}

export class PororoOcrEngine implements OcrEngine {
  id = "pororo";
  label = "Pororo OCR (Korean Specialist)";

  private session: ort.InferenceSession | null = null;
  private vocab: string[] | null = null;
  private runExclusive = createRunLock("pororo-ocr");

  async release(): Promise<void> {
    if (this.session) {
      try {
        await this.session.release();
      } catch (err) {
        console.warn("Failed to release Pororo OCR session:", err);
      }
      this.session = null;
      this.vocab = null;
    }
  }

  private async ensureModels(): Promise<void> {
    if (this.session && this.vocab) return;

    const repo = env.pororoModelRepo;
    const [recModel, optResp] = await Promise.all([
      downloadArtifactHF(repo, "brainocr.onnx"),
      downloadArtifactHF(repo, "ocr-opt.txt"),
    ]);

    this.session = recModel as ort.InferenceSession;
    const optText = await (optResp as Response).text();
    this.vocab = parsePororoVocab(optText);
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
    const requestedMin = options?.minConfidence ?? PORORO_DEFAULT_MIN;
    // Fix: cap the shared threshold to product-scale range.
    const minConfidence = Math.min(requestedMin, PORORO_MIN_CAP);
    const batchSize = options?.batchSize ?? DefaultConfig.ocrBatchSize;

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
      await this.ensureModels();
      if (!this.session || !this.vocab) {
        throw new Error("Pororo OCR uninitialized");
      }

      return await this.runBatches(
        crops,
        batchSize,
        minConfidence,
        bboxes.length,
      );
    });

    // The consumer below indexes `result` by bbox position, so a length
    // change here would silently shift every bubble by one.
    if (result.length !== bboxes.length) {
      throw new Error(
        `[pororo] result/bbox length mismatch: ${result.length} results for ${bboxes.length} boxes`,
      );
    }

    // Retry path for empty results (regions that were not gate-skipped)
    // Fix: second-chance split keeps stacked glyphs together and pads more.
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
            : sliceImageDataIntoLines(paddedCrop, {
                thresholdRatio: 0.35,
                mergeGap: 6,
                padX: 6,
                padY: 6,
              });

          return lines.map((imageData) => ({
            // Position within `failedIndexes`, NOT a bbox index. The
            // re-mapping below converts it back; keep the two in lockstep.
            slotIndex: retryIdx,
            imageData: padImageForOCR(imageData, 6),
          }));
        })
        .flat();

      const retryResults = await this.runExclusive(async () => {
        return await this.runBatches(
          retryCrops,
          batchSize,
          minConfidence * 0.7,
          failedIndexes.length,
        );
      });

      // `runBatches` allocates one slot per `slotCount` argument, so this must
      // hold exactly; a per-line return would put translated text in the wrong
      // bubble via the positional remap below.
      if (retryResults.length !== failedIndexes.length) {
        throw new Error(
          `[pororo] retry/slot length mismatch: ${retryResults.length} results for ${failedIndexes.length} retry slots`,
        );
      }

      failedIndexes.forEach((origIdx, retryIdx) => {
        const prev = result[origIdx] as SingleOcrResult & { prod?: number };
        const next = retryResults[retryIdx] as SingleOcrResult & {
          prod?: number;
        };
        if (!next.failed && (prev.failed || (next.prod ?? 0) > (prev.prod ?? 0))) {
          result[origIdx] = next;
        }
      });
    }

    return result.map(({ text, confidence, failed }) => ({
      text,
      confidence,
      failed,
    }));
  }

  /**
   * `slotIndex` is the position in the returned array, so the caller decides
   * what a slot means: a bbox index on the primary pass, a retry-slot index on
   * the retry pass. `slotCount` is the number of slots, i.e. result length.
   */
  private async runBatches(
    crops: { slotIndex: number; imageData: ImageData }[],
    batchSize: number,
    minConfidence: number,
    slotCount: number,
  ): Promise<(SingleOcrResult & { prod?: number })[]> {
    if (!this.session || !this.vocab) {
      throw new Error("Pororo OCR session or vocab not initialized");
    }

    const stitchedResults = Array.from({ length: slotCount }, () => ({
      text: "",
      totalConf: 0,
      totalProd: 0,
      lineCount: 0,
    }));

    const vocab = this.vocab;
    const numClasses = vocab.length;
    const slicePixels = INPUT_HEIGHT * INPUT_WIDTH;

    for (let start = 0; start < crops.length; start += batchSize) {
      await yieldToMain();
      const end = Math.min(crops.length, start + batchSize);
      const batchData = crops.slice(start, end);
      const N = batchData.length;

      if (N === 0) continue;

      const batchBuffer = new Float32Array(N * slicePixels);
      for (let i = 0; i < N; i++) {
        const lineBuffer = preprocessPororoLine(batchData[i].imageData);
        batchBuffer.set(lineBuffer, i * slicePixels);
      }

      const inputTensor = new ort.Tensor("float32", batchBuffer, [
        N,
        1,
        INPUT_HEIGHT,
        INPUT_WIDTH,
      ]);

      await yieldToMain();
      let output: ort.Tensor | null = null;
      try {
        const inputName = this.session.inputNames[0] ?? "images";
        const outputMap = await this.session.run({ [inputName]: inputTensor });
        await yieldToMain();

        const outputName = this.session.outputNames[0] ?? "prediction";
        output = outputMap[outputName];
        const outputData = output.data as Float32Array;

        // Fix: read time steps from the model so vocab/model swaps stay aligned.
        const dims = (output as unknown as { dims?: number[] }).dims;
        const timeSteps =
          dims && dims.length >= 3 ? dims[1] : FALLBACK_TIME_STEPS;
        const classes = dims && dims.length >= 3 ? dims[2] : numClasses;
        const stepStride = classes;
        const batchStride = timeSteps * stepStride;

        for (let i = 0; i < N; i++) {
          const batchOffset = i * batchStride;
          const decodedChars: string[] = [];
          const keptProbs: number[] = [];
          let prevIdx = -1;

          for (let t = 0; t < timeSteps; t++) {
            const stepOffset = batchOffset + t * stepStride;
            let bestIdx = 0;
            let maxLogit = -Infinity;

            // Find argmax for time step t
            for (let c = 0; c < classes; c++) {
              const val = outputData[stepOffset + c];
              if (val > maxLogit) {
                maxLogit = val;
                bestIdx = c;
              }
            }

            // CTC collapsing: skip blank (index 0) and repeat of previous token
            if (bestIdx !== 0 && bestIdx !== prevIdx) {
              // Compute softmax probability for maxLogit
              let sumExp = 0;
              for (let c = 0; c < classes; c++) {
                sumExp += Math.exp(outputData[stepOffset + c] - maxLogit);
              }
              const prob = 1.0 / Math.max(1e-8, sumExp);

              decodedChars.push(vocab[bestIdx] ?? "");
              keptProbs.push(prob);
            }
            prevIdx = bestIdx;
          }

          const text = decodedChars.join("");
          // Fix: track both mean and product. Mean stays user-facing;
          // product rejects long uncertain readings a mean would keep.
          const meanConf =
            keptProbs.length > 0
              ? keptProbs.reduce((a, b) => a + b, 0) / keptProbs.length
              : 0;
          const prodConf =
            keptProbs.length > 0
              ? keptProbs.reduce((a, b) => a * b, 1)
              : 0;

          const textLen = text.trim().length;
          const passesProduct =
            keptProbs.length <= 1 || prodConf >= PORORO_PRODUCT_FLOOR;
          if (meanConf >= minConfidence && passesProduct && textLen > 0) {
            const newText = text.trim();
            // Single Hangul characters are full words in Korean (e.g. 네, 왜, 뭐, 응, 야);
            // do not drop them with the ASCII-noise 0.75 penalty.
            const isHangul = /[\uAC00-\uD7AF\u1100-\u11FF]/.test(newText);
            const isSingleCharNoise =
              !isHangul &&
              textLen === 1 &&
              meanConf < Math.max(minConfidence, 0.75);

            if (!isSingleCharNoise) {
              const slot = batchData[i].slotIndex;
              const target = stitchedResults[slot];
              if (!target) {
                throw new Error(
                  `[pororo] crop ${i} claims slot ${slot}, outside 0..${stitchedResults.length - 1}`,
                );
              }

              if (target.text.endsWith("-")) {
                target.text = target.text.slice(0, -1) + newText;
              } else {
                target.text += (target.text ? " " : "") + newText;
              }

              target.totalConf += meanConf;
              target.totalProd += prodConf;
              target.lineCount += 1;
            }
          }
        }
      } finally {
        inputTensor?.dispose?.();
        output?.dispose?.();
      }
    }

    return stitchedResults.map(({ text, totalConf, totalProd, lineCount }) => {
      if (lineCount === 0) {
        return { text: "", confidence: 0, failed: true, prod: 0 };
      }
      return {
        text,
        confidence: totalConf / lineCount,
        failed: text.length === 0,
        prod: totalProd / lineCount,
      };
    });
  }
}
