import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type InfoHintPlacement = 'auto' | 'bottom' | 'left';

const INFO_TOOLTIP_WIDTH_PX = 260;

/**
 * Portal-based tooltip: rendered into document.body with fixed, viewport-clamped
 * coordinates, so it can never be clipped by card overflow, out-paint sibling panels,
 * or flicker when a hover-lift transform moves the trigger under the cursor.
 */
export function InfoHint({
  text,
  placement = 'auto',
}: {
  text: string;
  placement?: InfoHintPlacement;
}) {
  const hintRef = useRef<HTMLSpanElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean } | null>(null);

  const show = () => {
    const rect = hintRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    const below = placement === 'bottom' ? true : rect.top < 150;
    const x = Math.min(
      Math.max(8, rect.left + rect.width / 2 - INFO_TOOLTIP_WIDTH_PX / 2),
      window.innerWidth - INFO_TOOLTIP_WIDTH_PX - 8,
    );
    const y = below ? rect.bottom + 8 : rect.top - 8;
    setPos({ x, y, below });
  };
  const hide = () => setPos(null);

  // Any scroll/resize invalidates the fixed coordinates — just dismiss.
  useEffect(() => {
    if (!pos) {
      return undefined;
    }
    const close = () => setPos(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [pos]);

  return (
    <span
      ref={hintRef}
      className="info-hint"
      tabIndex={0}
      aria-label={text}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <span className="info-hint-glyph" aria-hidden="true">i</span>
      {pos
        ? createPortal(
            <span
              className={`info-hint-tooltip info-hint-tooltip-floating${pos.below ? ' is-below' : ''}`}
              role="tooltip"
              style={
                pos.below
                  ? { left: pos.x, top: pos.y }
                  : { left: pos.x, bottom: window.innerHeight - pos.y }
              }
            >
              {text}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
