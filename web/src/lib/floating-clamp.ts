/**
 * Pure horizontal viewport clamping for floating menus and popovers.
 * Prevents absolutely-positioned dropdowns from clipping off the right or left
 * edge of narrow viewports (e.g. 375px mobile).
 */

export interface HorizontalRect {
  readonly left: number;
  readonly right: number;
}

/**
 * Returns the pixel `translateX` delta required to bring `rect` inside
 * `[margin, viewportWidth - margin]`. Returns `0` when the panel already fits.
 * If the panel is wider than the available viewport, aligns its left edge to
 * `margin` so the leading content stays reachable.
 */
export function computeHorizontalShift(
  rect: HorizontalRect,
  viewportWidth: number,
  margin = 8,
): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return 0;
  const maxRight = viewportWidth - margin;
  if (rect.right > maxRight) {
    const shiftLeft = maxRight - rect.right;
    if (rect.left + shiftLeft < margin) {
      return Math.round(margin - rect.left);
    }
    return Math.round(shiftLeft);
  }
  if (rect.left < margin) {
    return Math.round(margin - rect.left);
  }
  return 0;
}
