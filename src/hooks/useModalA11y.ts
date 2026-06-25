import { useEffect, useRef, type RefObject } from 'react';

interface ModalA11yOptions {
  /** Invoked when the user presses Escape. Usually the modal's close handler. */
  onClose?: () => void;
  /** Lock background scroll while the modal is open. Default true. */
  lockScroll?: boolean;
  /** Whether the modal is currently mounted/open. Default true. */
  active?: boolean;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Shared modal/overlay accessibility: Escape-to-close, focus trap (Tab/Shift+Tab cycle within
 * the modal), initial focus into the modal, focus restore to the opener on close, and
 * background scroll-lock. Attach the returned ref to the modal container element.
 *
 * `onClose` is read through a ref, so passing a fresh inline closure each render won't re-run
 * the effect (which would otherwise steal focus on every render).
 */
export function useModalA11y<T extends HTMLElement = HTMLElement>(
  options: ModalA11yOptions = {},
): RefObject<T> {
  const { onClose, lockScroll = true, active = true } = options;
  // `useRef<T>(null)` hits the overload returning RefObject<T> (assignable to a `ref` prop),
  // whereas `useRef<T | null>` returns a type the JSX `ref` attribute rejects.
  const ref = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) {
      return;
    }
    const node = ref.current;
    if (!node) {
      return;
    }

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = (): HTMLElement[] =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );

    const initial = focusables()[0];
    if (initial) {
      initial.focus();
    } else {
      node.setAttribute('tabindex', '-1');
      node.focus();
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current?.();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        node.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      if (event.shiftKey) {
        if (activeEl === first || !node.contains(activeEl)) {
          event.preventDefault();
          last.focus();
        }
      } else if (activeEl === last || !node.contains(activeEl)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);

    const previousOverflow = lockScroll ? document.body.style.overflow : '';
    if (lockScroll) {
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      if (lockScroll) {
        document.body.style.overflow = previousOverflow;
      }
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  }, [active, lockScroll]);

  return ref;
}
