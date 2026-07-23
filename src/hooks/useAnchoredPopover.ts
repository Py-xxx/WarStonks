import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { computeAnchoredPosition } from '../lib/anchoredPosition';

/** Off-screen and invisible until the first measurement lands, so it never flashes mispositioned. */
const HIDDEN_STYLE: CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  visibility: 'hidden',
  pointerEvents: 'none',
};

/**
 * Positions a popover against an anchor element in viewport coordinates, flipping and clamping so
 * it is always fully on screen.
 *
 * The popover must be rendered in a portal on `document.body` — `position: fixed` inside the row
 * would still be clipped by any scrolling ancestor, which is exactly the case for a popover
 * opened from a row deep in a scrolling list.
 *
 * Also handles dismissal (Escape, or a press outside both popover and anchor), since a portaled
 * popover is visually detached from whatever opened it.
 */
export function useAnchoredPopover(
  anchorEl: HTMLElement | null,
  open: boolean,
  onDismiss?: () => void,
) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<CSSProperties>(HIDDEN_STYLE);

  const reposition = useCallback(() => {
    const popover = popoverRef.current;
    if (!anchorEl || !popover) {
      return;
    }
    const { top, left, maxHeight } = computeAnchoredPosition(
      anchorEl.getBoundingClientRect(),
      { width: popover.offsetWidth, height: popover.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setStyle({ position: 'fixed', top, left, maxHeight, overflowY: 'auto' });
  }, [anchorEl]);

  useLayoutEffect(() => {
    if (!open) {
      setStyle(HIDDEN_STYLE);
      return;
    }
    reposition();

    // `true` captures scrolls in any ancestor container, not just the window.
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open || !onDismiss) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onDismiss();
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      // The anchor toggles the popover itself — let it, rather than closing here and reopening.
      if (popoverRef.current?.contains(target) || anchorEl?.contains(target)) {
        return;
      }
      onDismiss();
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [open, onDismiss, anchorEl]);

  return { popoverRef, style };
}
