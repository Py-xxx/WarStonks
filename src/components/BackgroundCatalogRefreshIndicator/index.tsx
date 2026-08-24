import { useEffect, useState } from 'react';
import { listenToBackgroundCatalogRefresh } from '../../lib/tauriClient';
import { useTranslation } from '../../i18n';

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
  const { t } = useTranslation();
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
    // Sits just under the toast layer: this is background progress, so a real toast should be
    // able to appear over it rather than queue behind it.
    <div
      className="fixed right-4 bottom-4 z-(--z-tooltip) flex max-w-[300px] min-w-[220px] flex-col gap-1.5 rounded-lg border border-accent-blue/35 bg-bg-overlay px-3.5 py-2.5 shadow-float"
      role="status"
    >
      {state.kind === 'running' ? (
        <>
          <span className="text-[11px] font-medium text-ink">{t('cat.updating')}</span>
          <span className="h-1 overflow-hidden rounded-full bg-bg-base">
            {/* Plots the real `progressValue`, and the width transition is what makes a long
                catalog build read as moving rather than stuck. */}
            <span
              className="block h-full rounded-full bg-accent-blue transition-[width] duration-300 ease-out"
              style={{
                width: `${Math.round(Math.min(1, Math.max(0, state.progressValue)) * 100)}%`,
              }}
            />
          </span>
          <span className="text-[10px] leading-relaxed text-ink-dim">{state.statusText}</span>
          {/* The reason this indicator exists at all: prices can be briefly stale while it runs,
              and a user comparing numbers deserves to know that. */}
          <span className="text-[10px] leading-relaxed text-ink-faint">{t('cat.caveat')}</span>
        </>
      ) : (
        <span className="text-[11px] font-medium text-accent-green">{t('cat.updated')}</span>
      )}
    </div>
  );
}
