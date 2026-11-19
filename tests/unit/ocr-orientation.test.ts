import { describe, expect, it } from "bun:test";
import {
  classifyOrientation,
  measureOrientation,
  shouldRotateForOrientation,
} from "../../src/lib/ocr/utils";

/**
 * The orientation classifier is pure (`ImageData` in, verdict out), so it can
 * be pinned against synthetic pages without a canvas. These cases encode the
 * measured failure: a WIDE bubble holding several vertical columns used to
 * fail the old `h / w >= 0.8` gate and was then sliced across its columns.
 */

function image(
  w: number,
  h: number,
  paint: (x: number, y: number) => boolean,
): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = paint(x, y) ? 0 : 255;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  // Duck-typed: the classifier only reads width/height/data, and Bun has no
  // DOM ImageData. No canvas is created or needed.
  return { width: w, height: h, data } as unknown as ImageData;
}

/** `columns` vertical strips of stacked glyph blocks, phases independent. */
function verticalText(w: number, h: number, columns: number): ImageData {
  const pitch = w / (columns + 1);
  const width = Math.max(10, Math.round(pitch * 0.45));
  const centres = Array.from(
    { length: columns },
    (_, i) => Math.round(pitch * (i + 1)),
  );
  return image(w, h, (x, y) => {
    const column = centres.findIndex((cx) => Math.abs(x - cx) <= width / 2);
    if (column < 0) return false;
    // Real columns do not share a glyph baseline; offsetting the phase keeps
    // the row profile dense, which is what a vertical bubble actually looks
    // like to the projector.
    const phase = (y + column * 7) % 22;
    return phase >= 4 && phase < 18;
  });
}

/** `rows` horizontal runs of glyph blocks, phases independent. */
function horizontalText(w: number, h: number, rows: number): ImageData {
  const pitch = h / (rows + 1);
  const height = Math.max(10, Math.round(pitch * 0.45));
  const centres = Array.from(
    { length: rows },
    (_, i) => Math.round(pitch * (i + 1)),
  );
  return image(w, h, (x, y) => {
    const row = centres.findIndex((cy) => Math.abs(y - cy) <= height / 2);
    if (row < 0) return false;
    const phase = (x + row * 7) % 22;
    return phase >= 4 && phase < 18;
  });
}

describe("classifyOrientation", () => {
  it("never calls a single tall column horizontal", () => {
    expect(classifyOrientation(verticalText(80, 220, 1))).not.toBe("horizontal");
  });

  it("reads a WIDE three-column bubble as vertical", () => {
    // 260x170 is the case that used to fail `h / w >= 0.8` (0.65) and get
    // sliced across its columns.
    expect(classifyOrientation(verticalText(260, 170, 3))).toBe("vertical");
  });

  it("reads stacked horizontal lines as horizontal", () => {
    expect(classifyOrientation(horizontalText(220, 180, 3))).toBe("horizontal");
  });

  it("does not rotate a wide single line of text", () => {
    const img = horizontalText(300, 56, 1);
    expect(shouldRotateForOrientation(classifyOrientation(img), 56 / 300)).toBe(
      false,
    );
  });

  it("does not claim vertical for a small or empty crop", () => {
    expect(classifyOrientation(image(12, 12, () => false))).toBe("horizontal");
    expect(classifyOrientation(image(200, 200, () => false))).not.toBe(
      "vertical",
    );
  });

  it("reports the band structure it decided on", () => {
    const vertical = measureOrientation(verticalText(260, 170, 3));
    expect(vertical.columnBands).toBe(3);
    expect(vertical.columnBands).toBeGreaterThan(vertical.rowBands);

    const horizontal = measureOrientation(horizontalText(220, 180, 3));
    expect(horizontal.rowBands).toBe(3);
    expect(horizontal.rowBands).toBeGreaterThan(horizontal.columnBands);
  });
});

describe("shouldRotateForOrientation", () => {
  it("rotates a confident vertical reading regardless of aspect", () => {
    expect(shouldRotateForOrientation("vertical", 0.4)).toBe(true);
    expect(shouldRotateForOrientation("vertical", 3)).toBe(true);
  });

  it("never rotates a confident horizontal reading", () => {
    expect(shouldRotateForOrientation("horizontal", 0.4)).toBe(false);
    expect(shouldRotateForOrientation("horizontal", 3)).toBe(false);
  });

  it("falls back to the tall-crop rule only when ambiguous", () => {
    expect(shouldRotateForOrientation("ambiguous", 0.65)).toBe(false);
    expect(shouldRotateForOrientation("ambiguous", 0.8)).toBe(true);
    expect(shouldRotateForOrientation("ambiguous", 2.4)).toBe(true);
  });
});
