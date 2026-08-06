import { useEffect, useRef } from 'react';
import { checkForAppUpdate, isAppUpdaterSupported } from '../lib/appUpdater';
import { fireAlertNotification } from '../lib/notifications';
import { sendAppUpdateDiscordNotification, isTauriRuntime } from '../lib/tauriClient';
import { useAppStore } from '../stores/useAppStore';
import { tActive } from '../i18n';

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
          tActive('sys.appUpdateAvailableTitle'),
          tActive('sys.appUpdateAvailableBody', { version: update.version ?? '' }),
        );
        // Discord (gated backend-side on discord.enabled && app_update).
        if (isTauriRuntime()) {
          void sendAppUpdateDiscordNotification({
            version: update.version ?? '',
            currentVersion: update.currentVersion ?? null,
            notes: update.notes ?? null,
            labels: {
              titleSuffix: tActive('discord.appUpdate.titleSuffix'),
              description: tActive('discord.appUpdate.description'),
              footer: tActive('discord.appUpdate.footer'),
            },
          }).catch(() => undefined);
        }
      } catch (error) {
        console.warn('[updater] failed to check for app updates', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [showAppUpdateAvailable]);
}
