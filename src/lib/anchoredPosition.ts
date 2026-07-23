/** Breathing room kept between a popover and the edge of the viewport. */
export const VIEWPORT_MARGIN = 8;
/** Gap between the anchor element and the popover. */
export const ANCHOR_GAP = 6;

export interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface AnchoredPosition {
  top: number;
  left: number;
  maxHeight: number;
}

/**
 * Places a popover against an anchor in viewport coordinates so it is always fully on screen.
 *
 * Vertically it prefers sitting below the anchor, flips above when that would overflow, and falls
 * back to resting against the bottom edge (with `maxHeight` letting it scroll internally) when it
 * fits in neither. Horizontally it right-aligns to the anchor, then clamps into the viewport.
 *
 * Pure so the placement rules can be tested without a DOM.
 */
export function computeAnchoredPosition(
  anchor: Rect,
  popover: Size,
  viewport: Size,
): AnchoredPosition {
  const maxHeight = Math.max(0, viewport.height - VIEWPORT_MARGIN * 2);

  let top = anchor.bottom + ANCHOR_GAP;
  if (top + popover.height > viewport.height - VIEWPORT_MARGIN) {
    const above = anchor.top - ANCHOR_GAP - popover.height;
    top =
      above >= VIEWPORT_MARGIN
        ? above
        : Math.max(VIEWPORT_MARGIN, viewport.height - VIEWPORT_MARGIN - popover.height);
  }

  const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - popover.width - VIEWPORT_MARGIN);
  const left = Math.min(Math.max(anchor.right - popover.width, VIEWPORT_MARGIN), maxLeft);

  return { top, left, maxHeight };
}
