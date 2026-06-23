import { useEffect } from 'react';

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 600;
const RETRY_PARAM = 'wsretry';

/**
 * App-wide image load recovery.
 *
 * Many remote images (WFM item icons, avatars, worldstate art) are loaded directly via
 * `<img>` tags scattered across the app, with no per-tag error handling. A transient CDN
 * hiccup — or a burst of dozens of image requests from a long list — leaves some images
 * permanently broken until the component re-renders. This was the "assets randomly don't
 * load" symptom.
 *
 * This hook attaches one capture-phase `error` listener (image error events don't bubble,
 * so capture is required) and automatically retries any failed remote image a few times with
 * staggered, cache-busting reloads. Failures that exhaust retries are tagged
 * `data-asset-failed="true"` so CSS can show a neutral placeholder instead of a broken-image
 * icon. Successful loads reset the per-element retry state so a later hiccup gets a fresh set
 * of retries.
 *
 * No per-component changes are needed — it covers every `<img>`, including future ones.
 */
export function useImageErrorRecovery() {
  useEffect(() => {
    const stripRetryParam = (rawUrl: string): string | null => {
      try {
        const url = new URL(rawUrl, window.location.href);
        url.searchParams.delete(RETRY_PARAM);
        return url.toString();
      } catch {
        return null;
      }
    };

    const handleError = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLImageElement)) {
        return;
      }

      const currentSrc = target.currentSrc || target.src;
      // Only recover real remote fetches; ignore data:/blob:/empty sources.
      if (!/^https?:/i.test(currentSrc)) {
        return;
      }

      const base = stripRetryParam(currentSrc);
      if (!base) {
        return;
      }

      // Reset the counter when the element is now showing a different image (React reused
      // the DOM node for another item).
      if (target.dataset.retryBase !== base) {
        target.dataset.retryBase = base;
        target.dataset.retryCount = '0';
        delete target.dataset.assetFailed;
      }

      const attempts = Number(target.dataset.retryCount ?? '0');
      if (attempts >= MAX_RETRIES) {
        // Give up gracefully — let CSS render a placeholder rather than a broken icon.
        target.dataset.assetFailed = 'true';
        return;
      }

      const nextAttempt = attempts + 1;
      target.dataset.retryCount = String(nextAttempt);

      // Stagger retries (and spread out burst failures) with a cache-busting reload.
      window.setTimeout(() => {
        try {
          const retryUrl = new URL(base);
          retryUrl.searchParams.set(RETRY_PARAM, String(nextAttempt));
          target.src = retryUrl.toString();
        } catch {
          // Ignore — a malformed URL can't be retried.
        }
      }, RETRY_BASE_DELAY_MS * nextAttempt);
    };

    const handleLoad = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLImageElement)) {
        return;
      }
      // Clear recovery state on a good load so future transient failures retry afresh.
      if (target.dataset.retryCount || target.dataset.assetFailed) {
        delete target.dataset.retryCount;
        delete target.dataset.retryBase;
        delete target.dataset.assetFailed;
      }
    };

    document.addEventListener('error', handleError, true);
    document.addEventListener('load', handleLoad, true);
    return () => {
      document.removeEventListener('error', handleError, true);
      document.removeEventListener('load', handleLoad, true);
    };
  }, []);
}
