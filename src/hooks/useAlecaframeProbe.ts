import { useEffect } from 'react';

import { probeLocalSources } from '../lib/tauriClient';
import { useAppStore } from '../stores/useAppStore';

/**
 * Probes once, at app start, whether AlecaFrame's inventory file is present.
 *
 * This used to live on the Inventory page's mount. The sidebar now renders that page's
 * sub-navigation, so the answer has to exist before the page is first opened — otherwise the
 * sub-items appear in their no-AlecaFrame shape and then rearrange the moment you visit.
 */
export function useAlecaframeProbe(): void {
  const setAlecaframeFilePresent = useAppStore((s) => s.setAlecaframeFilePresent);

  useEffect(() => {
    let cancelled = false;
    void probeLocalSources()
      .then((availability) => {
        if (!cancelled) {
          setAlecaframeFilePresent(availability.alecaframeInventory.status === 'available');
        }
      })
      // A failed probe means "not available", which is already the default.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [setAlecaframeFilePresent]);
}
