import { useEffect } from 'react';
import { listenToWfmPresenceChange } from '../lib/tauriClient';
import { useAppStore } from '../stores/useAppStore';

/**
 * Keeps the displayed trade-account presence in sync with what the backend presence
 * keeper actually reports from Warframe.Market. The keeper holds a persistent
 * connection (so the user stays online/ingame and survives session re-auth) and emits
 * the live status; this hook reflects it in the UI without re-fetching the session.
 */
export function useTradePresence() {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void listenToWfmPresenceChange((rawStatus) => {
      // The backend emits exactly these normalized presence values.
      if (rawStatus !== 'ingame' && rawStatus !== 'online' && rawStatus !== 'offline') {
        return;
      }
      const status = rawStatus;
      const current = useAppStore.getState().tradeAccount;
      if (current && current.status !== status) {
        useAppStore.setState({ tradeAccount: { ...current, status } });
      }
    })
      .then((dispose) => {
        if (cancelled) {
          dispose();
        } else {
          unlisten = dispose;
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
