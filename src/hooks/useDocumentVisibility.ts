import { useEffect, useState } from 'react';

/**
 * Tracks whether the app window is currently visible.
 *
 * On Windows the app runs inside WebView2 (Chromium), which aggressively throttles
 * and can suspend a minimized/occluded window. Timer-based polling either stalls
 * while hidden or — worse — fires a backlog of coalesced work the moment the window
 * is restored. That resume flood, funnelled through the rate-limited WFM scheduler
 * and a burst of React re-renders, is what makes the app appear frozen after it has
 * been tabbed out for a long time.
 *
 * Polling hooks gate their timers on this value so that work pauses cleanly while the
 * window is hidden and restarts fresh (no backlog) when it becomes visible again.
 */
export function useDocumentVisibility(): boolean {
  const [isVisible, setIsVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );

  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsVisible(document.visibilityState !== 'hidden');
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    // Sync once in case visibility changed before this listener attached.
    handleVisibilityChange();

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  return isVisible;
}
