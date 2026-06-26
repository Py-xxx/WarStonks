import { useEffect } from 'react';
import { listenToUnderpricedListings } from '../lib/tauriClient';
import { useAppStore } from '../stores/useAppStore';

/**
 * Mounts the always-on underpriced-listings radar: subscribes to the backend firehose events and
 * collects them into the store, and periodically prunes cards past their 5-minute TTL (we can't
 * see when a seller removes a listing). Mounted once on the AppShell so the list accumulates
 * regardless of which tab is open.
 */
export function useUnderpricedListings(): void {
  const ingest = useAppStore((state) => state.ingestUnderpricedListing);
  const prune = useAppStore((state) => state.pruneExpiredUnderpricedListings);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | null = null;

    void listenToUnderpricedListings((listing) => {
      if (active) {
        ingest(listing);
      }
    })
      .then((cleanup) => {
        // Already unmounted before the subscription resolved — tear it down immediately so the
        // real unlisten is never orphaned.
        if (!active) {
          cleanup();
          return;
        }
        unsubscribe = cleanup;
      })
      .catch((error) => {
        console.error('[radar] failed to subscribe to underpriced listings', error);
      });

    const sweep = window.setInterval(() => prune(), 15_000);

    return () => {
      active = false;
      window.clearInterval(sweep);
      unsubscribe?.();
    };
  }, [ingest, prune]);
}
