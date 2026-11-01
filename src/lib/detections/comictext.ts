import * as ort from "onnxruntime-web/all";
import { fetchAsImageBitmap, yieldToMain } from "../utils";
import { scalingImage, restoreBoundingBox, containmentNMS } from "./utils";
import { refineDetections } from "./boxes";
import {
  mergeSegmentationTile,
  resizeSegmentation,
  setPageSegmentation,
} from "./segmentation";
import { planDetectionTiles, shouldTile, mergeTiledBoxes } from "./tiling";

/**
 * ComicTextDetector (dmMaze / manga-image-translator beta-0.3, GPL-3.0, ~95 MB).
 *
 * Tensor contract (spike 6 rule: bind by shape, not name/index):
 * - Input: `image`: Float32[1, 3, 1024, 1024], letterbox RGB 0..1.
 * - Outputs:
 *   - [1, N, 7]: detection head (cx, cy, w, h, obj_conf, cls0, cls1)
 *   - [1, 1, 1024, 1024]: text segmentation mask
 *   - [1, 2, 1024, 1024]: DBNet lines map (ignored)
 *
 * Very tall strips use the same sliding-window tiling policy as RT-DETR.
 * Each tile's segmentation mask is composited back into one page-level mask
 * with a per-pixel max, so overlapping tiles cannot erase each other's text.
 */
const MODEL_SIZE = 1024;

interface ComicTextSingleResult {
  boxes: Bbox[];
  /** Page- or tile-sized mask, resized before the tensor is disposed. */
  segmentation: Uint8Array | null;
}

async function runComicTextSingle(
  session: ort.InferenceSession,
  input: string | CanvasImageSource,
  minConfidence: number,
): Promise<ComicTextSingleResult> {
  const { imageData, origWidth, origHeight } = await scalingImage(
    input,
    MODEL_SIZE,
  );

  const channelSize = MODEL_SIZE * MODEL_SIZE;
  const imageBuffer = new Float32Array(3 * channelSize);
  const inv255 = 1.0 / 255.0;

  await yieldToMain();
  for (let i = 0; i < channelSize; i++) {
    const rgba = i * 4;
    imageBuffer[i] = imageData.data[rgba] * inv255;
    imageBuffer[i + channelSize] = imageData.data[rgba + 1] * inv255;
    imageBuffer[i + channelSize * 2] = imageData.data[rgba + 2] * inv255;
  }

  await yieldToMain();
  let inputTensor: ort.Tensor | null = new ort.Tensor("float32", imageBuffer, [
    1,
    3,
    MODEL_SIZE,
    MODEL_SIZE,
  ]);
  const inputName = session.inputNames[0] ?? "image";
  let headTensor: ort.Tensor | null = null;
  let segTensor: ort.Tensor | null = null;
  try {
    const results = await session.run({ [inputName]: inputTensor });
    await yieldToMain();

    for (const name of session.outputNames) {
      const tensor = results[name];
      if (!tensor) continue;
      const dims = tensor.dims;
      if (dims.length === 3 && dims[0] === 1 && dims[2] === 7) {
        headTensor = tensor;
      } else if (dims.length === 4 && dims[0] === 1 && dims[1] === 1) {
        segTensor = tensor;
      }
    }

    // If output names didn't map cleanly, iterate all returned values
    if (!headTensor || !segTensor) {
      for (const key of Object.keys(results)) {
        const tensor = results[key];
        const dims = tensor.dims;
        if (dims.length === 3 && dims[0] === 1 && dims[2] === 7) {
          headTensor = tensor;
        } else if (dims.length === 4 && dims[0] === 1 && dims[1] === 1) {
          segTensor = tensor;
        }
      }
    }

    // Resize the mask before the finally block disposes the tensor, then hand
    // the page/tile-sized levels back to the caller for composition.
    let segmentation: ComicTextSingleResult["segmentation"] = null;
    if (segTensor) {
      const segData = (await segTensor.getData()) as Float32Array;
      segmentation = resizeSegmentation(
        segData,
        segTensor.dims[3],
        segTensor.dims[2],
        origWidth,
        origHeight,
        MODEL_SIZE,
      );
    }

    const formattedDetections: Bbox[] = [];
    if (headTensor) {
      const headData = (await headTensor.getData()) as Float32Array;
      const numQueries = headTensor.dims[1];

      for (let i = 0; i < numQueries; i++) {
        const offset = i * 7;
        const cx = headData[offset];
        const cy = headData[offset + 1];
        const w = headData[offset + 2];
        const h = headData[offset + 3];
        const objConf = headData[offset + 4];
        const cls0 = headData[offset + 5];
        const cls1 = headData[offset + 6];

        const score = objConf * Math.max(cls0, cls1);
        if (score < minConfidence || Number.isNaN(score)) continue;

        const x1 = cx - w / 2;
        const y1 = cy - h / 2;
        const x2 = cx + w / 2;
        const y2 = cy + h / 2;

        formattedDetections.push(
          restoreBoundingBox(
            { x1, y1, x2, y2, confidence: score },
            origWidth,
            origHeight,
            MODEL_SIZE,
          ),
        );
      }
    }

    return {
      boxes: containmentNMS(formattedDetections, 0.35),
      segmentation,
    };
  } finally {
    inputTensor?.dispose?.();
    headTensor?.dispose?.();
    segTensor?.dispose?.();
  }
}

export async function runComicTextDetection(
  session: ort.InferenceSession,
  imageSrc: string,
  minConfidence = 0.4,
): Promise<Bbox[]> {
  const bitmap = await fetchAsImageBitmap(imageSrc);
  const origWidth = bitmap.width;
  const origHeight = bitmap.height;

  try {
    if (!shouldTile(origWidth, origHeight)) {
      const single = await runComicTextSingle(session, bitmap, minConfidence);
      if (single.segmentation) {
        setPageSegmentation(
          imageSrc,
          origWidth,
          origHeight,
          single.segmentation,
        );
      }
      return refineDetections(single.boxes, origWidth, origHeight).boxes;
    }

    // Tiled sliding-window path for webtoon/tall/large images.
    const tiles = planDetectionTiles(origWidth, origHeight);
    const allBoxes: Bbox[] = [];
    const pageLevels = new Uint8Array(origWidth * origHeight);
    let hasSegmentation = false;

    for (const tile of tiles) {
      const tileCanvas = new OffscreenCanvas(tile.w, tile.h);
      const tileCtx = tileCanvas.getContext("2d", {
        willReadFrequently: true,
      })!;
      tileCtx.drawImage(
        bitmap,
        tile.x,
        tile.y,
        tile.w,
        tile.h,
        0,
        0,
        tile.w,
        tile.h,
      );

      const tileResult = await runComicTextSingle(
        session,
        tileCanvas,
        minConfidence,
      );

      for (const b of tileResult.boxes) {
        allBoxes.push({
          x1: Math.max(0, Math.min(origWidth, b.x1 + tile.x)),
          y1: Math.max(0, Math.min(origHeight, b.y1 + tile.y)),
          x2: Math.max(0, Math.min(origWidth, b.x2 + tile.x)),
          y2: Math.max(0, Math.min(origHeight, b.y2 + tile.y)),
          confidence: b.confidence,
        });
      }

      if (tileResult.segmentation) {
        mergeSegmentationTile(
          pageLevels,
          origWidth,
          origHeight,
          tile,
          tileResult.segmentation,
        );
        hasSegmentation = true;
      }

      await yieldToMain();
    }

    if (hasSegmentation) {
      setPageSegmentation(imageSrc, origWidth, origHeight, pageLevels);
    }

    const merged = mergeTiledBoxes(allBoxes);
    const nms = containmentNMS(merged);
    return refineDetections(nms, origWidth, origHeight).boxes;
  } finally {
    bitmap.close();
  }
}
