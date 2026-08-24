/**
 * AlecaFrame integration.
 *
 * This used to configure AlecaFrame's *public API* (a shared link, validated over the network). It
 * now reads AlecaFrame's local app data directly, so there is nothing to configure beyond on/off —
 * the data is already on disk, and no credentials or links are involved.
 *
 * Note what this switch does **not** control: private-message and trade detection come from
 * Warframe's own `EE.log`, which exists whenever the game is installed. Those are always on and
 * independent of AlecaFrame entirely. The unlocks list exists to say so.
 */
import { useEffect, useState } from 'react';

import { Switch } from '@/components/ui/switch';
import { useTranslation } from '../../i18n';
import { formatSettingsErrorMessage } from '../../lib/settingsErrorHandling';
import { probeLocalSources } from '../../lib/tauriClient';
import { useAppStore } from '../../stores/useAppStore';
import type { LocalSourceAvailability } from '../../types';
import { Note, SettingGroup, SettingRow, StatusLine } from './parts';

export function AlecaframeSection() {
  const appSettings = useAppStore((state) => state.appSettings);
  const settingsLoading = useAppStore((state) => state.settingsLoading);
  const settingsError = useAppStore((state) => state.settingsError);
  const saveAlecaframeConfiguration = useAppStore((state) => state.saveAlecaframeConfiguration);
  const clearSettingsError = useAppStore((state) => state.clearSettingsError);
  const { t } = useTranslation();

  const [enabled, setEnabled] = useState(appSettings.alecaframe.enabled);
  const [availability, setAvailability] = useState<LocalSourceAvailability | null>(null);

  useEffect(() => {
    setEnabled(appSettings.alecaframe.enabled);
  }, [appSettings.alecaframe.enabled]);

  // Re-probed each time this section mounts rather than cached: the user may have installed
  // AlecaFrame or launched the game since the app started, and a stale "not found" would send
  // them to fix something that is already working.
  useEffect(() => {
    let cancelled = false;
    void probeLocalSources()
      .then((result) => {
        if (!cancelled) {
          setAvailability(result);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const detected = availability?.alecaframeInventory.status === 'available';

  const save = async (next: boolean) => {
    setEnabled(next);
    clearSettingsError();
    // `publicLink` is retained on the settings struct so existing saved configs deserialize, but
    // nothing reads it any more.
    await saveAlecaframeConfiguration({ enabled: next, publicLink: null });
  };

  return (
    <div className="flex flex-col gap-6">
      <SettingGroup title={t('aleca.subtitle')}>
        <SettingRow
          label={t('aleca.enable.label')}
          help={t('aleca.enable.help')}
          control={
            <Switch
              tone="positive"
              checked={enabled}
              disabled={settingsLoading}
              aria-label={t('aleca.enable.label')}
              onCheckedChange={(next) => void save(next)}
            />
          }
        />

        <StatusLine
          tone={availability === null ? 'pending' : detected ? 'positive' : 'negative'}
          label={
            availability === null
              ? t('aleca.detect.checking')
              : detected
                ? t('aleca.detect.found')
                : t('aleca.detect.missing')
          }
        />

        {/* Turning it on while AlecaFrame isn't installed is allowed — the user may be about to
            install it — but saying so beats an inventory that stays empty for no visible reason. */}
        {enabled && availability !== null && !detected ? (
          <Note tone="warn">{t('aleca.detect.enabledButMissing')}</Note>
        ) : null}

        {settingsError ? (
          <Note tone="error" role="alert">
            {formatSettingsErrorMessage('alecaframe-save', settingsError)}
          </Note>
        ) : null}
      </SettingGroup>

      {/* What the switch actually turns on, stated plainly. The old API integration controlled
          trade detection too, so it is worth being explicit that this no longer does. */}
      <SettingGroup title={t('aleca.unlocks.title')}>
        <ul className="flex flex-col gap-1.5">
          {(['aleca.unlocks.inventory', 'aleca.unlocks.relics', 'aleca.unlocks.wallet'] as const).map(
            (key) => (
              <li key={key} className="flex items-start gap-2 text-xs text-ink-soft">
                <i
                  className="ti ti-check mt-px shrink-0 text-sm text-accent-green"
                  aria-hidden="true"
                />
                {t(key)}
              </li>
            ),
          )}
        </ul>
      </SettingGroup>
    </div>
  );
}
