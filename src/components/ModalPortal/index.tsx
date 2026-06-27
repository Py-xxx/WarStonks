import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

/**
 * Renders modal content as a direct child of <body> so it escapes any panel/card
 * ancestor that clips (overflow) or creates a containing block (transform/animation).
 * Without this, popups rendered inside a small panel get confined to that panel and
 * can render off-screen. Use it to wrap any modal that lives inside page content.
 */
export function ModalPortal({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined') {
    return null;
  }
  return createPortal(children, document.body);
}
