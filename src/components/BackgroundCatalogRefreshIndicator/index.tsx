import { useEffect, useState } from 'react';
import { listenToBackgroundCatalogRefresh } from '../../lib/tauriClient';

type RefreshState =
  | { kind: 'idle' }
  | { kind: 'running'; statusText: string; progressValue: number }
  | { kind: 'done' };

/**
 * A small persistent bottom-right indicator for the item catalog refreshing off the boot path —
 * see `item_catalog_v2::spawn_background_catalog_v2_refresh` on the Rust side. Only appears when
 * a refresh is actually running (most launches never see this at all, since the freshness check
 * usually finds nothing to do); briefly shows "Updated" on completion, then disappears. A failure
 * is silent here by design — the previous catalog file is untouched and keeps serving, and the
 * next launch's freshness check will simply try again.
 */
export function BackgroundCatalogRefreshIndicator() {
  const [state, setState] = useState<RefreshState>({ kind: 'idle' });

  useEffect(() => {
    let isMounted = true;
    let doneTimer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | undefined;

    void listenToBackgroundCatalogRefresh({
      onProgress: (progress) => {
        if (!isMounted) return;
        setState({ kind: 'running', statusText: progress.statusText, progressValue: progress.progressValue });
      },
      onComplete: () => {
        if (!isMounted) return;
        setState({ kind: 'done' });
        doneTimer = setTimeout(() => {
          if (isMounted) setState({ kind: 'idle' });
        }, 4000);
      },
      onFailed: () => {
        if (!isMounted) return;
        setState({ kind: 'idle' });
      },
    }).then((nextUnlisten) => {
      if (!isMounted) {
        nextUnlisten();
        return;
      }
      unlisten = nextUnlisten;
    });

    return () => {
      isMounted = false;
      clearTimeout(doneTimer);
      unlisten?.();
    };
  }, []);

  if (state.kind === 'idle') {
    return null;
  }

  return (
    <div className="bg-catalog-refresh" role="status">
      {state.kind === 'running' ? (
        <>
          <span className="bg-catalog-refresh-label">Updating item catalog…</span>
          <div className="bg-catalog-refresh-bar">
            <div
              className="bg-catalog-refresh-bar-fill"
              style={{ width: `${Math.round(Math.min(1, Math.max(0, state.progressValue)) * 100)}%` }}
            />
          </div>
          <span className="bg-catalog-refresh-status">{state.statusText}</span>
          <span className="bg-catalog-refresh-caveat">
            Some item data may be briefly out of date until this finishes.
          </span>
        </>
      ) : (
        <span className="bg-catalog-refresh-label">Item catalog updated</span>
      )}
    </div>
  );
}
