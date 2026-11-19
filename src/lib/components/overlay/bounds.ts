/**
 * Shared bounds helpers for the floating overlay elements (result toolbars,
 * style bar, raw-text pill): none of them may rest outside the image display —
 * the `#lmt-overlay` surface, which is sized exactly to the manga image's
 * rendered box (see `syncWrapperGeometry` in `src/entrypoints/content/utils.ts`).
 */

/** The image display surface hosting `el`, or null when detached. */
export function overlayDisplayEl(el: Element | undefined | null): HTMLElement | null {
  if (!(el instanceof Element)) return null;
  if (el instanceof HTMLElement) {
    const parent = el.offsetParent;
    if (parent instanceof HTMLElement) return parent;
  }
  // `position: fixed` elements have no offsetParent — fall back to the
  // overlay root they are rendered in.
  const root = el.closest("#lmt-overlay");
  return root instanceof HTMLElement ? root : null;
}

/** True when `rect` pokes out of the image display on any side. */
export function isRectOutside(rect: DOMRect, display: DOMRect): boolean {
  return (
    rect.left < display.left ||
    rect.top < display.top ||
    rect.right > display.right ||
    rect.bottom > display.bottom
  );
}

/**
 * Clamp a free-drag offset so the element stays inside the image display.
 * `rect` is the live element rect (current offset applied), `current` the
 * offset it was measured with and `next` the offset to clamp. Returns null
 * when the element cannot fit inside the display at all — callers treat
 * null as "return to the default position".
 */
export function clampOffsetInside(
  rect: DOMRect,
  display: DOMRect,
  current: { x: number; y: number },
  next: { x: number; y: number },
  pad = 0,
): { x: number; y: number } | null {
  const baseLeft = rect.left - current.x;
  const baseTop = rect.top - current.y;
  const minX = display.left + pad - baseLeft;
  const maxX = display.right - pad - rect.width - baseLeft;
  const minY = display.top + pad - baseTop;
  const maxY = display.bottom - pad - rect.height - baseTop;
  if (minX > maxX || minY > maxY) return null;
  return {
    x: Math.max(minX, Math.min(maxX, next.x)),
    y: Math.max(minY, Math.min(maxY, next.y)),
  };
}
