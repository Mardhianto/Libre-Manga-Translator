import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { restoreBoundingBox } from "../../src/lib/detections/utils";

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8");

/**
 * The detector execution paths need OffscreenCanvas, which bun does not expose.
 * These tests therefore bind the wrappers to the chosen preprocessing policy,
 * and exercise the pure inverse transform with wide and tall page geometry.
 *
 * LMT deliberately letterboxes both detectors so a page's x/y proportions are
 * never squeezed. RT-DETR receives `orig_target_sizes = [640, 640]`; its boxes
 * are therefore in the padded square and must be un-padded exactly once.
 */
describe("detector preprocessing contracts", () => {
  const rtdetr = read("../../src/lib/detections/rtdetr.ts");
  const comictext = read("../../src/lib/detections/comictext.ts");
  const utils = read("../../src/lib/detections/utils.ts");

  it("RT-DETR letterboxes to 640×640 and un-pads every box", () => {
    expect(rtdetr).toMatch(/const INPUT_SIZE = 640;/);
    expect(rtdetr).toMatch(/scalingImage\([\s\S]*?INPUT_SIZE/);
    expect(rtdetr).toMatch(/restoreBoundingBox\([\s\S]*?INPUT_SIZE/);
    expect(rtdetr).not.toMatch(
      /drawImage\(bitmap, 0, 0, INPUT_SIZE, INPUT_SIZE\)/,
    );
  });

  it("RT-DETR requests boxes in the padded square coordinate frame", () => {
    expect(rtdetr).toMatch(
      /new BigInt64Array\(\[[\s\S]*?BigInt\(INPUT_SIZE\)[\s\S]*?BigInt\(INPUT_SIZE\)[\s\S]*?\]\)/,
    );
    expect(rtdetr).not.toMatch(/BigInt\(origWidth\)|BigInt\(origHeight\)/);
  });

  it("the shared scaler uses a centered min-scale letterbox", () => {
    expect(utils).toMatch(
      /Math\.min\(modelSize \/ bitmap\.width, modelSize \/ bitmap\.height\)/,
    );
    expect(utils).toMatch(/offsetX = \(modelSize - newWidth\) \/ 2/);
    expect(utils).toMatch(/offsetY = \(modelSize - newHeight\) \/ 2/);
  });

  it("un-pads boxes on a wide page without distorting coordinates", () => {
    expect(
      restoreBoundingBox(
        { x1: 160, y1: 220, x2: 480, y2: 380, confidence: 0.9 },
        1600,
        900,
        640,
      ),
    ).toEqual({ x1: 400, y1: 200, x2: 1200, y2: 600, confidence: 0.9 });
  });

  it("un-pads boxes on a tall page without distorting coordinates", () => {
    expect(
      restoreBoundingBox(
        { x1: 220, y1: 160, x2: 380, y2: 480, confidence: 0.9 },
        900,
        1600,
        640,
      ),
    ).toEqual({ x1: 200, y1: 400, x2: 600, y2: 1200, confidence: 0.9 });
  });

  it("RT-DETR feeds raw [0, 1] pixels (rescale, no normalization)", () => {
    expect(rtdetr).toMatch(/1\.0 \/ 255\.0/);
    expect(rtdetr).not.toMatch(/0\.485|0\.229/);
  });

  it("ComicTextDetector keeps the same letterbox and tiles tall pages", () => {
    expect(comictext).toMatch(/scalingImage\(/);
    expect(comictext).toMatch(/restoreBoundingBox\(/);
    expect(comictext).toMatch(/shouldTile\(/);
    expect(comictext).toMatch(/planDetectionTiles\(/);
    expect(comictext).toMatch(/mergeTiledBoxes\(/);
    expect(comictext).toMatch(/mergeSegmentationTile\(/);
  });
});
