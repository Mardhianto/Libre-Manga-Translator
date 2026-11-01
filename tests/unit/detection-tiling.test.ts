import { describe, it, expect } from "bun:test";
import {
  shouldTile,
  computeTileOrigins,
  planDetectionTiles,
  boxIoU,
  boxContainment,
  mergeTiledBoxes,
} from "../../src/lib/detections/tiling";
import { mergeSegmentationTile } from "../../src/lib/detections/segmentation";

describe("detection tiling policy & geometry", () => {
  describe("shouldTile threshold", () => {
    it("returns false for standard manga pages", () => {
      // 800x1200 has aspect ratio 1.5, below 1.8
      expect(shouldTile(800, 1200)).toBe(false);
      expect(shouldTile(1000, 1400)).toBe(false);
      // Double page spread 1600x1000 has aspect ratio 1.6, below 1.8
      expect(shouldTile(1600, 1000)).toBe(false);
    });

    it("returns true for webtoon strips (aspect >= 1.8)", () => {
      expect(shouldTile(800, 1440)).toBe(true);
      expect(shouldTile(800, 4000)).toBe(true);
      expect(shouldTile(800, 12000)).toBe(true);
    });

    it("returns true for oversized dimensions even if square", () => {
      expect(shouldTile(2400, 2400)).toBe(true);
      expect(shouldTile(2001, 1500)).toBe(true);
    });

    it("handles degenerate inputs safely", () => {
      expect(shouldTile(0, 1000)).toBe(false);
      expect(shouldTile(-100, 500)).toBe(false);
    });
  });

  describe("computeTileOrigins", () => {
    it("returns a single origin when totalLength <= tileSize", () => {
      const origins = computeTileOrigins(800, 1000, 200);
      expect(origins).toEqual([{ start: 0, size: 800 }]);
    });

    it("generates overlapping tiles that strictly span [0, totalLength]", () => {
      const totalLength = 10000;
      const tileSize = 1000;
      const minOverlap = 200;

      const origins = computeTileOrigins(totalLength, tileSize, minOverlap);
      expect(origins.length).toBeGreaterThan(1);

      // First tile starts at 0
      expect(origins[0].start).toBe(0);
      expect(origins[0].size).toBe(tileSize);

      // Last tile ends exactly at totalLength
      const last = origins[origins.length - 1];
      expect(last.start + last.size).toBe(totalLength);

      // Check strictly ascending order and minimum overlap
      for (let i = 0; i < origins.length - 1; i++) {
        const curr = origins[i];
        const next = origins[i + 1];
        expect(next.start).toBeGreaterThan(curr.start);
        const overlap = curr.start + curr.size - next.start;
        expect(overlap).toBeGreaterThanOrEqual(minOverlap);
      }
    });

    it("handles exact tileSize boundary", () => {
      const origins = computeTileOrigins(1000, 1000, 200);
      expect(origins).toEqual([{ start: 0, size: 1000 }]);
    });
  });

  describe("planDetectionTiles", () => {
    it("plans a 1D column of tiles for standard-width webtoons", () => {
      const tiles = planDetectionTiles(800, 5000, 1000, 200);
      expect(tiles.length).toBeGreaterThan(1);

      for (const tile of tiles) {
        expect(tile.x).toBe(0);
        expect(tile.w).toBe(800);
        expect(tile.y).toBeGreaterThanOrEqual(0);
        expect(tile.y + tile.h).toBeLessThanOrEqual(5000);
      }

      // First tile starts at y=0, last ends at y=5000
      expect(tiles[0].y).toBe(0);
      const last = tiles[tiles.length - 1];
      expect(last.y + last.h).toBe(5000);
    });

    it("plans a 2D grid for wide and tall images", () => {
      const tiles = planDetectionTiles(2400, 3000, 1000, 200);
      expect(tiles.length).toBeGreaterThan(6);

      for (const tile of tiles) {
        expect(tile.x + tile.w).toBeLessThanOrEqual(2400);
        expect(tile.y + tile.h).toBeLessThanOrEqual(3000);
      }
    });
  });

  describe("box IoU and containment", () => {
    it("computes exact IoU for identical and disjoint boxes", () => {
      const b1 = { x1: 100, y1: 100, x2: 200, y2: 200, confidence: 1.0 };
      const b2 = { x1: 100, y1: 100, x2: 200, y2: 200, confidence: 1.0 };
      const bDisjoint = { x1: 300, y1: 300, x2: 400, y2: 400, confidence: 1.0 };

      expect(boxIoU(b1, b2)).toBe(1.0);
      expect(boxIoU(b1, bDisjoint)).toBe(0.0);
    });

    it("computes exact containment for partial seam cuts", () => {
      const full = { x1: 100, y1: 100, x2: 300, y2: 200, confidence: 1.0 }; // 200x100 = 20000
      const cut = { x1: 100, y1: 100, x2: 300, y2: 150, confidence: 1.0 };  // 200x50 = 10000

      const { inA, inB } = boxContainment(cut, full);
      expect(inA).toBe(1.0); // 100% of cut is inside full
      expect(inB).toBe(0.5); // 50% of full is inside cut
    });
  });

  describe("mergeTiledBoxes", () => {
    it("merges two overlapping detections of the same bubble into a hull", () => {
      const boxFromTile1: Bbox = {
        x1: 100,
        y1: 850,
        x2: 300,
        y2: 950,
        confidence: 0.85,
      };
      const boxFromTile2: Bbox = {
        x1: 102,
        y1: 848,
        x2: 298,
        y2: 952,
        confidence: 0.92,
      };

      const merged = mergeTiledBoxes([boxFromTile1, boxFromTile2]);
      expect(merged.length).toBe(1);
      expect(merged[0].confidence).toBe(0.92);
      expect(merged[0].x1).toBe(100);
      expect(merged[0].y1).toBe(848);
      expect(merged[0].x2).toBe(300);
      expect(merged[0].y2).toBe(952);
    });

    it("recovers full bubble when one tile detects a truncated seam cut", () => {
      // Tile 1 ended at y=1000 and caught a truncated box:
      const cutBox: Bbox = {
        x1: 150,
        y1: 960,
        x2: 350,
        y2: 1000,
        confidence: 0.45,
      };
      // Tile 2 started at y=800 and saw the full bubble:
      const fullBox: Bbox = {
        x1: 150,
        y1: 960,
        x2: 350,
        y2: 1060,
        confidence: 0.88,
      };

      const merged = mergeTiledBoxes([cutBox, fullBox]);
      expect(merged.length).toBe(1);
      expect(merged[0]).toEqual({
        x1: 150,
        y1: 960,
        x2: 350,
        y2: 1060,
        confidence: 0.88,
      });
    });

    it("keeps distinct non-overlapping bubbles intact", () => {
      const bubbleA: Bbox = {
        x1: 100,
        y1: 200,
        x2: 250,
        y2: 300,
        confidence: 0.9,
      };
      const bubbleB: Bbox = {
        x1: 100,
        y1: 600,
        x2: 250,
        y2: 700,
        confidence: 0.85,
      };

      const merged = mergeTiledBoxes([bubbleA, bubbleB]);
      expect(merged.length).toBe(2);
    });

    it("handles empty and single-element inputs", () => {
      expect(mergeTiledBoxes([])).toEqual([]);
      const single: Bbox = { x1: 10, y1: 10, x2: 50, y2: 50, confidence: 0.8 };
      expect(mergeTiledBoxes([single])).toEqual([single]);
    });
  });
});

describe("tiled segmentation compositing", () => {
  it("stamps tile masks into page space and keeps the strongest hit", () => {
    const page = new Uint8Array(4 * 4);
    mergeSegmentationTile(
      page,
      4,
      4,
      { x: 0, y: 0, w: 2, h: 2 },
      new Uint8Array([10, 20, 30, 40]),
    );

    expect(Array.from(page)).toEqual([
      10, 20, 0, 0,
      30, 40, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ]);

    // Overlaps the first tile at (1,1)-(2,2); max keeps the stronger value.
    mergeSegmentationTile(
      page,
      4,
      4,
      { x: 1, y: 1, w: 2, h: 2 },
      new Uint8Array([200, 5, 250, 0]),
    );

    expect(Array.from(page)).toEqual([
      10, 20, 0, 0,
      30, 200, 5, 0,
      0, 250, 0, 0,
      0, 0, 0, 0,
    ]);
  });

  it("clamps a tile that extends past the page edge", () => {
    const page = new Uint8Array(2 * 2);
    mergeSegmentationTile(
      page,
      2,
      2,
      { x: 1, y: 1, w: 2, h: 2 },
      new Uint8Array([9, 9, 9, 9]),
    );

    expect(Array.from(page)).toEqual([0, 0, 0, 9]);
  });
});
