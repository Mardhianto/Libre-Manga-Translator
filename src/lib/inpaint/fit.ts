import type { Mask } from "./mask";
import {
  bandIndices,
  buildTwoSidedSeed,
  crossesEdgeMask,
  dilate,
  maskCount,
} from "./mask";
import { measureRing, type RingMeasurement } from "./ring";
import type { RingStats } from "./ring";
import {
  DENOISE_NOISE_FLOOR,
  FIT_DEV_MIN,
  FIT_DEV_NOISE_FACTOR,
  FLAT_FLOOR,
  INPAINT_MIN_STD,
  MASK_GROWTH_STEPS,
  MASK_GROWTH_STEP,
  MIN_INPAINTING_RADIUS,
  MIN_MASK_THICKNESS,
  TELEA_SEAL,
} from "./constants";

/**
 * Mask fitting: how far to grow the text mask, and where it should route.
 * The subtle parts are the failure
 * cases, and they are load-bearing:
 *
 * - Ratchet for selection, TRUE MINIMUM for failure: a rejected candidate
 *   never updates the incumbent, but `bestDeviation` tracks the min over ALL
 *   candidates and that is what says "fit failed".
 * - The zero case: below FLAT_FLOOR the largest under-floor candidate wins
 *   (swallows the anti-aliasing fringe), and the floor takes precedence over
 *   the monotone gate.
 * - Candidates that cross a strong edge are rejected and the loop stops -
 *   never append the raw rectangle (a grown mask across a bubble stroke scores
 *   better on the outside paper, wins, and the fill paints over the outline).
 * - The fail threshold is relative to the page noise floor.
 */

export type Route = "fill" | "denoise" | "inpaint";

export interface Fitted {
  /** the mask that will actually be applied */
  mask: Mask;
  /** seed grown by the first step only - the tight hole Beta5's LaMa needs */
  ink: Mask;
  ring: RingStats;
  /** restricted ring pixels the route was decided from (fill must reuse) */
  ringIdx: number[];
  route: Route;
  /** growth (px) that produced `mask` */
  thickness: number;
  /** smallest deviation ANY candidate achieved, accepted or not */
  bestDeviation: number;
  /**
   * The mask a hole-filling engine should use.
   *
   * Equal to `mask` whenever a ring was measured. When none was
   * (`ring.count === 0`) `mask` is only the seed grown one step - for outlined
   * lettering that is a hollow ring around the glyph, and a pixel engine
   * reading it as the hole leaves the glyph cores as KNOWN pixels inside its
   * own search radius and paints their tone across the region (the white
   * smear). In that case this is the two-sided contrast mask over the ink
   * bounds, sealed against the anti-aliased fringe (see `teleaMaskFor`).
   */
  teleaMask: Mask;
}

export const deviationThreshold = (noiseSigma: number): number =>
  Math.max(FIT_DEV_MIN, FIT_DEV_NOISE_FACTOR * noiseSigma);

/** Bounding box of a mask's set pixels, in crop-local coordinates. */
function maskBounds(m: Mask): { x1: number; y1: number; x2: number; y2: number } {
  const { w, h, data } = m;
  let x1 = w;
  let y1 = h;
  let x2 = -1;
  let y2 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!data[row + x]) continue;
      if (x < x1) x1 = x;
      if (x > x2) x2 = x;
      if (y < y1) y1 = y;
      if (y > y2) y2 = y;
    }
  }
  return x2 < x1 ? { x1: 0, y1: 0, x2: -1, y2: -1 } : { x1, y1, x2, y2 };
}

/**
 * The mask a hole-filling engine gets when no ring was measurable (`ring.count`
 * is 0 - the fit never grew a single accepted candidate).
 *
 * `mask` in that case is `ink` - the seed grown by one step, which for
 * outlined lettering is a hollow ring around the glyph. A pixel engine reading
 * that ring as its hole leaves the glyph cores as KNOWN (unmasked) pixels
 * inside its own search radius and paints their tone across the region: the
 * white smear. So the Telea rung gets a two-sided contrast mask over the ink
 * bounds (dark outline AND light core both inside the hole), unioned with the
 * outline, then sealed with a two-pixel dilation so the anti-aliased seam
 * around each core is inside too.
 *
 * The two-pixel seal is measured, not chosen: one pixel leaves the 1 px AA
 * fringe as a bright known ring (1.2% smear on the fixture), two absorbs it
 * (0.2%). The ink-bounds rect (not the seed bounds) is what carries the whole
 * box; a seed-derived rect crops the outermost glyph.
 */
function teleaMaskFor(seed: Mask, ink: Mask, luma: Float32Array): Mask {
  const bounds = maskBounds(ink);
  if (bounds.x2 < bounds.x1) return ink;

  const twoSided = buildTwoSidedSeed(
    luma,
    seed.w,
    seed.h,
    seed.ox,
    seed.oy,
    bounds,
  );
  const union = new Uint8Array(seed.w * seed.h);
  let count = 0;
  for (let i = 0; i < union.length; i++) {
    if (twoSided.data[i] || ink.data[i]) {
      union[i] = 1;
      count++;
    }
  }
  if (count === 0) return ink;

  return dilate(
    { data: union, w: seed.w, h: seed.h, ox: seed.ox, oy: seed.oy },
    TELEA_SEAL,
  );
}

/**
 * Seed measured on the crop. `mag` = crop Sobel, `strongFloor` page-level.
 * Planes come back in PAGE coords; `ox/oy` place the crop on the page.
 */
export function fitMask(
  seed: Mask,
  luma: Float32Array,
  rgb: Uint8ClampedArray,
  mag: Float32Array,
  strongFloor: number,
  noiseSigma: number,
): Fitted {
  const ink = dilate(seed, MIN_MASK_THICKNESS);

  let incumbent = seed;
  let incumbentRing: RingMeasurement | null = null;
  let incumbentDev = Infinity;
  let thickness = 0;
  let bestDeviation = Infinity;

  let cur = seed;
  let prev = seed;

  for (let s = 0; s <= MASK_GROWTH_STEPS; s++) {
    cur =
      s === 0
        ? dilate(seed, MIN_MASK_THICKNESS)
        : dilate(prev, MASK_GROWTH_STEP);
    const growth = MIN_MASK_THICKNESS + s * MASK_GROWTH_STEP;

    // Candidate rejected outright if its border rides a strong edge - the
    // same object reaches the annulus before the mask, and stopping here is
    // what keeps a ring from lying on a bubble stroke.
    if (crossesEdgeMask(cur, mag, strongFloor)) break;

    const ring = measureRing(
      cur,
      luma,
      rgb,
      mag,
      strongFloor,
      seed.ox,
      seed.oy,
    );
    if (ring.stats.count > 0 && ring.stats.deviation < bestDeviation) {
      bestDeviation = ring.stats.deviation;
    }

    const underFloor = ring.stats.deviation < FLAT_FLOOR;
    const improving = ring.stats.deviation < incumbentDev - 0.05;
    if (underFloor || improving) {
      incumbent = cur;
      incumbentRing = ring;
      incumbentDev = ring.stats.deviation;
      thickness = growth;
    } else {
      break; // monotone gate: no further growth can rescue this region
    }

    prev = cur;
  }

  // Fit failed outright: no ring was ever measurable. Fall back to the first
  // step (never the raw rectangle as a "fit") and send it to the inpainter.
  if (!incumbentRing) {
    return {
      mask: ink,
      ink,
      ring: {
        count: 0,
        median: 255,
        deviation: 999,
        planes: [
          { a: 255, b: 0, c: 0 },
          { a: 255, b: 0, c: 0 },
          { a: 255, b: 0, c: 0 },
        ],
        medians: [255, 255, 255],
        multimodal: false,
        periodic: false,
      },
      ringIdx: [],
      route: "inpaint",
      thickness: 0,
      bestDeviation: Infinity,
      teleaMask: teleaMaskFor(seed, ink, luma),
    };
  }

  const stats = incumbentRing.stats;
  const failThreshold = deviationThreshold(noiseSigma);

  const fitFailed = stats.count < 12 || bestDeviation > failThreshold;
  const secondPopulation =
    stats.deviation > INPAINT_MIN_STD &&
    thickness <= MIN_INPAINTING_RADIUS &&
    maskCount(incumbent) > maskCount(seed);

  let route: Route = "fill";
  if (fitFailed || stats.multimodal || stats.periodic || secondPopulation) {
    route = "inpaint";
  } else if (noiseSigma >= DENOISE_NOISE_FLOOR || stats.deviation > failThreshold / 2) {
    route = "denoise";
  }

  return {
    mask: incumbent,
    ink,
    ring: stats,
    ringIdx: incumbentRing.ringIdx,
    route,
    thickness,
    bestDeviation: Math.min(bestDeviation, stats.deviation),
    // A measured ring means the shape is trustworthy; only the no-ring path
    // (above) widens to the two-sided contrast mask.
    teleaMask: incumbent,
  };
}

/** Pixels the mask grew between two dilations (diagnostics/tests). */
export const growthBand = (a: Mask, b: Mask): number[] => bandIndices(a, b);
