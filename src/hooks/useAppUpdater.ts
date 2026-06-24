import { useEffect, useRef } from 'react';
import { checkForAppUpdate, isAppUpdaterSupported } from '../lib/appUpdater';
import { fireAlertNotification } from '../lib/notifications';
import { useAppStore } from '../stores/useAppStore';

export function useAppUpdater() {
  const showAppUpdateAvailable = useAppStore((state) => state.showAppUpdateAvailable);
  const checkedRef = useRef(false);

  useEffect(() => {
    if (checkedRef.current || !isAppUpdaterSupported()) {
      return;
    }

    checkedRef.current = true;
    let cancelled = false;

    void (async () => {
      try {
        const update = await checkForAppUpdate();
        if (!update || cancelled) {
          return;
        }

        showAppUpdateAvailable(update);
        fireAlertNotification(
          useAppStore.getState().notificationSettings,
          'appUpdate',
          'WarStonks update available',
          `Version ${update.version ?? ''} is ready to install.`.trim(),
        );
      } catch (error) {
        console.warn('[updater] failed to check for app updates', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [showAppUpdateAvailable]);
}
