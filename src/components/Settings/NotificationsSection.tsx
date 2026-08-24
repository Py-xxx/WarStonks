/**
 * Notifications — three channels and one event matrix.
 *
 * The matrix (Desktop | Discord per event) was already the right idea and is kept. Three things
 * changed:
 *
 * 1. **Channel settings live with their channel.** The ringtone picker and the Discord webhook URL
 *    used to sit side by side in one "config" row, grouped by being configuration rather than by
 *    what they configure. Ringtone belongs under Sound; the URL belongs under Discord.
 * 2. **A channel that is off dims its matrix column** and says so in the header, instead of
 *    offering toggles that silently do nothing. They stay interactive — you may be setting events
 *    up before pasting a URL — so this is emphasis, not behaviour.
 * 3. **Save no longer closes Settings.** Saving a webhook and being thrown out of the whole
 *    surface was the single most jarring thing here. It saves, toasts, and stays put — and the
 *    Save bar only appears when Discord actually has unsaved changes, so the one inconsistent
 *    save model at least announces itself.
 */
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '../../i18n';
import type { TranslationKey } from '../../i18n/en';
import { RINGTONES, playAlertSound } from '../../lib/alertAudio';
import {
  UNDERPRICED_PCT_BELOW_OPTIONS,
  isDesktopNotificationSupported,
  requestDesktopNotificationPermission,
  sendTestDesktopNotification,
} from '../../lib/notifications';
import { formatSettingsErrorMessage } from '../../lib/settingsErrorHandling';
import { useAppStore } from '../../stores/useAppStore';
import type { NotificationSettings, RingtoneId } from '../../types';
import { Note, SettingField, SettingGroup, SettingRow } from './parts';

const RING_KEYS: Record<string, TranslationKey> = {
  Chime: 'ring.chime',
  Ping: 'ring.ping',
  Coin: 'ring.coin',
  Arpeggio: 'ring.arpeggio',
  Alert: 'ring.alert',
  Bell: 'ring.bell',
};

type DiscordEventKey =
  | 'watchlistFound'
  | 'tradeDetected'
  | 'underpricedListing'
  | 'priceChange'
  | 'listingHealth'
  | 'scannerStale'
  | 'appUpdate'
  | 'privateMessage';

interface MatrixRow {
  labelKey: TranslationKey;
  helpKey: TranslationKey;
  desktopKey: keyof NotificationSettings['events'];
  /** Omitted for events with no Discord webhook — the cell renders as unavailable rather than a
   *  toggle that silently does nothing. */
  discordKey?: DiscordEventKey;
}

const MATRIX_ROWS: MatrixRow[] = [
  {
    labelKey: 'notif.event.watchlistAlert.label',
    helpKey: 'notif.event.watchlistAlert.help',
    desktopKey: 'watchlistAlert',
    discordKey: 'watchlistFound',
  },
  {
    labelKey: 'notif.event.tradeDetected.label',
    helpKey: 'notif.event.tradeDetected.help',
    desktopKey: 'tradeDetected',
    discordKey: 'tradeDetected',
  },
  {
    labelKey: 'notif.event.privateMessage.label',
    helpKey: 'notif.event.privateMessage.help',
    desktopKey: 'privateMessage',
    discordKey: 'privateMessage',
  },
  {
    labelKey: 'notif.event.underpricedListing.label',
    helpKey: 'notif.event.underpricedListing.help',
    desktopKey: 'underpricedListing',
    discordKey: 'underpricedListing',
  },
  {
    labelKey: 'notif.event.listingHealth.label',
    helpKey: 'notif.event.listingHealth.help',
    desktopKey: 'listingHealth',
    discordKey: 'listingHealth',
  },
  {
    labelKey: 'notif.event.priceChange.label',
    helpKey: 'notif.event.priceChange.help',
    desktopKey: 'priceChange',
    discordKey: 'priceChange',
  },
  {
    labelKey: 'notif.event.scannerStale.label',
    helpKey: 'notif.event.scannerStale.help',
    desktopKey: 'scannerStale',
    discordKey: 'scannerStale',
  },
  {
    labelKey: 'notif.event.appUpdate.label',
    helpKey: 'notif.event.appUpdate.help',
    desktopKey: 'appUpdate',
    discordKey: 'appUpdate',
  },
];

const DEFAULT_DISCORD_EVENTS: Record<DiscordEventKey, boolean> = {
  watchlistFound: true,
  tradeDetected: true,
  underpricedListing: true,
  priceChange: true,
  listingHealth: true,
  scannerStale: true,
  appUpdate: true,
  privateMessage: true,
};

export function NotificationsSection() {
  const settings = useAppStore((state) => state.notificationSettings);
  const setSettings = useAppStore((state) => state.setNotificationSettings);
  const appSettings = useAppStore((state) => state.appSettings);
  const settingsLoading = useAppStore((state) => state.settingsLoading);
  const settingsError = useAppStore((state) => state.settingsError);
  const saveDiscordWebhookConfiguration = useAppStore(
    (state) => state.saveDiscordWebhookConfiguration,
  );
  const clearSettingsError = useAppStore((state) => state.clearSettingsError);
  const pushToast = useAppStore((state) => state.pushToast);
  const { t } = useTranslation();

  const [permissionNote, setPermissionNote] = useState<TranslationKey | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  // Discord is drafted locally and saved explicitly; the desktop side saves live. That asymmetry
  // is deliberate — auto-saving a half-typed webhook URL would fire validation on every keystroke.
  const [discordEnabled, setDiscordEnabled] = useState(appSettings.discordWebhook.enabled);
  const [webhookUrl, setWebhookUrl] = useState(appSettings.discordWebhook.webhookUrl ?? '');
  const [discordEvents, setDiscordEvents] = useState<Record<DiscordEventKey, boolean>>({
    ...DEFAULT_DISCORD_EVENTS,
    ...appSettings.discordWebhook.notifications,
  });

  useEffect(() => {
    setDiscordEnabled(appSettings.discordWebhook.enabled);
    setWebhookUrl(appSettings.discordWebhook.webhookUrl ?? '');
    setDiscordEvents({ ...DEFAULT_DISCORD_EVENTS, ...appSettings.discordWebhook.notifications });
    setLocalError(null);
  }, [appSettings.discordWebhook]);

  const discordDirty = useMemo(() => {
    const saved = appSettings.discordWebhook;
    if (discordEnabled !== saved.enabled) return true;
    if (webhookUrl.trim() !== (saved.webhookUrl ?? '')) return true;
    // `?? DEFAULT_DISCORD_EVENTS[key]` matters: a config saved by an older version can be missing
    // a key entirely, and comparing a defaulted `true` against `undefined` would mark the section
    // dirty the moment it opened, leaving the Save bar up forever with nothing to save.
    return (Object.keys(discordEvents) as DiscordEventKey[]).some(
      (key) => discordEvents[key] !== (saved.notifications[key] ?? DEFAULT_DISCORD_EVENTS[key]),
    );
  }, [appSettings.discordWebhook, discordEnabled, discordEvents, webhookUrl]);

  const update = (patch: Partial<NotificationSettings>) => setSettings({ ...settings, ...patch });
  const updateEvent = (key: keyof NotificationSettings['events'], value: boolean) =>
    setSettings({ ...settings, events: { ...settings.events, [key]: value } });

  // Test previews the alert sound (if on) and fires a real OS notification (if on).
  const handleTest = async () => {
    if (settings.soundEnabled) {
      void playAlertSound(settings.ringtone).catch(() => undefined);
    }
    if (settings.desktopEnabled) {
      const delivered = await sendTestDesktopNotification();
      setPermissionNote(delivered ? null : 'notif.note.sendFailed');
    }
  };

  const handleToggleDesktop = async () => {
    if (settings.desktopEnabled) {
      update({ desktopEnabled: false });
      setPermissionNote(null);
      return;
    }
    if (!isDesktopNotificationSupported()) {
      setPermissionNote('notif.note.unavailable');
      return;
    }
    // Triggers the native OS permission prompt (via the Tauri notification plugin).
    const permission = await requestDesktopNotificationPermission();
    if (permission === 'denied') {
      setPermissionNote('notif.note.blocked');
      return;
    }
    if (permission === 'unsupported') {
      setPermissionNote('notif.note.unavailable');
      return;
    }
    // 'granted' or 'default' — enable optimistically. The permission getter is unreliable on
    // macOS and can report 'default' even when granted, so we don't block on it; use Test to
    // confirm delivery.
    update({ desktopEnabled: true });
    setPermissionNote(permission === 'granted' ? null : 'notif.note.enabledHint');
  };

  const handleSaveDiscord = async () => {
    setLocalError(null);
    clearSettingsError();
    try {
      await saveDiscordWebhookConfiguration({
        enabled: discordEnabled,
        webhookUrl: webhookUrl.trim() || null,
        notifications: { ...discordEvents },
      });
      pushToast(t('notif.saved'), 'success');
    } catch (error) {
      setLocalError(formatSettingsErrorMessage('discord-webhook-save', error));
    }
  };

  const showUnderpricedTier =
    settings.events.underpricedListing || discordEvents.underpricedListing;

  return (
    <div className="flex flex-col gap-6">
      <SettingGroup title={t('notif.channels')}>
        <SettingRow
          label={t('notif.desktop.label')}
          control={
            <Switch
              tone="positive"
              checked={settings.desktopEnabled}
              aria-label={t('notif.desktop.label')}
              onCheckedChange={() => void handleToggleDesktop()}
            />
          }
        >
          {permissionNote ? <Note tone="warn">{t(permissionNote)}</Note> : null}
        </SettingRow>

        <SettingRow
          label={t('notif.sound.label')}
          control={
            <Switch
              tone="positive"
              checked={settings.soundEnabled}
              aria-label={t('notif.sound.label')}
              onCheckedChange={(next) => update({ soundEnabled: next })}
            />
          }
        >
          <SettingField label={t('notif.ringtone')} htmlFor="notif-ringtone">
            <div className="flex items-center gap-2">
              <Select
                id="notif-ringtone"
                className="h-8 flex-1"
                value={settings.ringtone}
                disabled={!settings.soundEnabled}
                onChange={(event) => update({ ringtone: event.target.value as RingtoneId })}
              >
                {RINGTONES.map((tone) => (
                  <option key={tone.id} value={tone.id}>
                    {RING_KEYS[tone.label] ? t(RING_KEYS[tone.label]) : tone.label}
                  </option>
                ))}
              </Select>
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                disabled={!settings.soundEnabled && !settings.desktopEnabled}
                onClick={() => void handleTest()}
              >
                {t('common.test')}
              </Button>
            </div>
          </SettingField>
        </SettingRow>

        <SettingRow
          label={t('notif.discordEnable')}
          control={
            <Switch
              tone="positive"
              checked={discordEnabled}
              aria-label={t('notif.discordEnable')}
              onCheckedChange={setDiscordEnabled}
            />
          }
        >
          <SettingField label={t('discord.urlLabel')} htmlFor="notif-webhook">
            <Input
              id="notif-webhook"
              type="text"
              value={webhookUrl}
              placeholder="https://discord.com/api/webhooks/..."
              spellCheck={false}
              onChange={(event) => {
                setWebhookUrl(event.target.value);
                setLocalError(null);
              }}
            />
          </SettingField>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t('notif.notifyAbout')}>
        <div className="overflow-hidden rounded-md border border-line">
          <div className="grid grid-cols-[minmax(0,1fr)_72px_72px] items-center gap-2 border-b border-line bg-bg-base px-3 py-1.5 font-mono text-[9px] tracking-[0.08em] text-ink-dim uppercase">
            <span />
            <span className="text-center">
              {t('notif.colDesktop')}
              {!settings.desktopEnabled ? ` · ${t('common.off')}` : ''}
            </span>
            <span className="text-center">
              {t('notif.colDiscord')}
              {!discordEnabled ? ` · ${t('common.off')}` : ''}
            </span>
          </div>

          {MATRIX_ROWS.map((row) => (
            <div
              key={row.desktopKey}
              className="grid grid-cols-[minmax(0,1fr)_72px_72px] items-center gap-2 border-b border-line-subtle px-3 py-2 last:border-b-0"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-xs text-ink">{t(row.labelKey)}</span>
                <span className="truncate text-[10px] text-ink-dim">{t(row.helpKey)}</span>
              </span>
              {/* A channel that is off dims its column but keeps it usable — you may be setting
                  events up before turning the channel on. */}
              <span
                className={`flex justify-center ${settings.desktopEnabled ? '' : 'opacity-45'}`}
              >
                <Switch
                  tone="positive"
                  checked={settings.events[row.desktopKey]}
                  aria-label={`${t(row.labelKey)} — ${t('notif.colDesktop')}`}
                  onCheckedChange={(next) => updateEvent(row.desktopKey, next)}
                />
              </span>
              <span className={`flex justify-center ${discordEnabled ? '' : 'opacity-45'}`}>
                {row.discordKey ? (
                  <Switch
                    tone="positive"
                    checked={discordEvents[row.discordKey]}
                    aria-label={`${t(row.labelKey)} — ${t('notif.colDiscord')}`}
                    onCheckedChange={(next) => {
                      const key = row.discordKey;
                      if (!key) return;
                      setDiscordEvents((current) => ({ ...current, [key]: next }));
                    }}
                  />
                ) : (
                  <span className="text-center text-ink-faint">{t('common.dash')}</span>
                )}
              </span>
            </div>
          ))}
        </div>

        {showUnderpricedTier ? (
          <SettingField label={t('notif.underpriced.label')} htmlFor="notif-underpriced">
            <Select
              id="notif-underpriced"
              className="h-8 tabular-nums"
              value={settings.underpricedMinPctBelow}
              onChange={(event) => update({ underpricedMinPctBelow: Number(event.target.value) })}
            >
              {UNDERPRICED_PCT_BELOW_OPTIONS.map((pct) => (
                <option key={pct} value={pct}>
                  {t('notif.underpriced.option', { pct })}
                </option>
              ))}
            </Select>
          </SettingField>
        ) : null}
      </SettingGroup>

      {localError || settingsError ? (
        <Note tone="error" role="alert">
          {localError ?? settingsError}
        </Note>
      ) : null}

      {/* Only rendered when Discord genuinely has unsaved changes. Everything else on this screen
          saves as you touch it; a permanently-present Save button implied otherwise. */}
      {discordDirty ? (
        <div className="sticky bottom-0 -mx-5 -mb-5 flex items-center justify-between gap-3 border-t border-line bg-bg-overlay px-5 py-3">
          <span className="text-[11px] text-ink-dim">{t('notif.unsavedDiscord')}</span>
          <Button size="sm" disabled={settingsLoading} onClick={() => void handleSaveDiscord()}>
            {settingsLoading ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
