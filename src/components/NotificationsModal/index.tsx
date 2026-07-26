import { useEffect, useState } from 'react';
import { useTranslation } from '../../i18n';
import type { TranslationKey } from '../../i18n/en';
import { useAppStore } from '../../stores/useAppStore';
import { useModalA11y } from '../../hooks/useModalA11y';
import { RINGTONES, playAlertSound } from '../../lib/alertAudio';
import { formatSettingsErrorMessage } from '../../lib/settingsErrorHandling';

const RING_KEYS: Record<string, TranslationKey> = {
  Chime: 'ring.chime',
  Ping: 'ring.ping',
  Coin: 'ring.coin',
  Arpeggio: 'ring.arpeggio',
  Alert: 'ring.alert',
  Bell: 'ring.bell',
};
import {
  UNDERPRICED_PCT_BELOW_OPTIONS,
  isDesktopNotificationSupported,
  requestDesktopNotificationPermission,
  sendTestDesktopNotification,
} from '../../lib/notifications';
import type { NotificationSettings, RingtoneId } from '../../types';

const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);

type DiscordEventKey =
  | 'watchlistFound'
  | 'tradeDetected'
  | 'underpricedListing'
  | 'priceChange'
  | 'listingHealth'
  | 'scannerStale'
  | 'appUpdate';

/**
 * The unified notification matrix. Every event has a Desktop and a Discord toggle side by side,
 * keyed to whichever settings field each system stores it under. Kept identical for both.
 */
interface MatrixRow {
  labelKey: TranslationKey;
  helpKey: TranslationKey;
  desktopKey: keyof NotificationSettings['events'];
  discordKey: DiscordEventKey;
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

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label?: string }) {
  return (
    <button
      className={`settings-toggle${on ? ' on' : ''}`}
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onClick}
    >
      <span className="settings-toggle-track">
        <span className="settings-toggle-thumb" />
      </span>
      {label ? <span className="settings-toggle-label">{label}</span> : null}
    </button>
  );
}

export function NotificationsModal() {
  const modalOpen = useAppStore((state) => state.notificationsModalOpen);
  const closeModal = useAppStore((state) => state.closeNotificationsModal);
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
  const modalRef = useModalA11y<HTMLDivElement>({ onClose: closeModal, active: modalOpen });

  // ---- Discord webhook state (persisted via its own Save, unlike the live-saved desktop side) ----
  const [discordEnabled, setDiscordEnabled] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [discordEvents, setDiscordEvents] = useState<Record<DiscordEventKey, boolean>>({
    watchlistFound: true,
    tradeDetected: true,
    underpricedListing: true,
    priceChange: true,
    listingHealth: true,
    scannerStale: true,
    appUpdate: true,
  });
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!modalOpen) {
      return;
    }
    setDiscordEnabled(appSettings.discordWebhook.enabled);
    setWebhookUrl(appSettings.discordWebhook.webhookUrl ?? '');
    setDiscordEvents({ ...appSettings.discordWebhook.notifications });
    setLocalError(null);
    clearSettingsError();
  }, [appSettings.discordWebhook, clearSettingsError, modalOpen]);

  if (!modalOpen) {
    return null;
  }

  const update = (patch: Partial<NotificationSettings>) => setSettings({ ...settings, ...patch });
  const updateEvent = (key: keyof NotificationSettings['events'], value: boolean) =>
    setSettings({ ...settings, events: { ...settings.events, [key]: value } });

  // Test button: previews the alert sound (if on) and fires a real OS notification (if on).
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
      // Success: close the panel and confirm with a toast.
      closeModal();
      pushToast(t('notif.saved'), 'success');
    } catch (error) {
      setLocalError(formatSettingsErrorMessage('discord-webhook-save', error));
    }
  };

  return (
    <>
      <button
        className="modal-backdrop"
        type="button"
        aria-label={t('notif.close')}
        onClick={closeModal}
      />
      <div ref={modalRef} className="settings-modal" role="dialog" aria-modal="true" aria-label={t('settings.section.notifications.label')}>
        <div className="settings-modal-header">
          <div className="settings-modal-title">
            <span className="card-label">{t('settings.section.notifications.label')}</span>
            <h3>{t('notif.subtitle')}</h3>
          </div>
          <div className="settings-modal-actions">
            <button
              className="settings-close-btn"
              type="button"
              aria-label={t('notif.close')}
              onClick={closeModal}
            >
              <CloseIcon />
            </button>
          </div>
        </div>

        <div className="settings-modal-body notif-body">
          {/* ---- Top: the three channel switches, all the same compact size ---- */}
          <div className="settings-form-card">
            <div className="settings-notification-grid">
              <label className="settings-switch-row settings-switch-row-compact">
                <span className="settings-field-copy">
                  <span className="settings-field-label">{t('notif.desktop.label')}</span>
                </span>
                <Toggle
                  on={settings.desktopEnabled}
                  onClick={() => void handleToggleDesktop()}
                  label={settings.desktopEnabled ? t('common.on') : t('common.off')}
                />
              </label>

              <label className="settings-switch-row settings-switch-row-compact">
                <span className="settings-field-copy">
                  <span className="settings-field-label">{t('notif.sound.label')}</span>
                </span>
                <Toggle
                  on={settings.soundEnabled}
                  onClick={() => update({ soundEnabled: !settings.soundEnabled })}
                  label={settings.soundEnabled ? t('common.on') : t('common.off')}
                />
              </label>

              <label className="settings-switch-row settings-switch-row-compact">
                <span className="settings-field-copy">
                  <span className="settings-field-label">{t('notif.discordEnable')}</span>
                </span>
                <Toggle
                  on={discordEnabled}
                  onClick={() => setDiscordEnabled((current) => !current)}
                  label={discordEnabled ? t('common.on') : t('common.off')}
                />
              </label>
            </div>

            {permissionNote ? (
              <div className="settings-inline-warning">{t(permissionNote)}</div>
            ) : null}

            <div className="notif-config-row">
              <label className="settings-field">
                <span className="settings-field-label">{t('notif.ringtone')}</span>
                <div className="notif-ringtone-row">
                  <select
                    className="settings-input notif-ringtone-select"
                    value={settings.ringtone}
                    disabled={!settings.soundEnabled}
                    onChange={(event) => update({ ringtone: event.target.value as RingtoneId })}
                  >
                    {RINGTONES.map((tone) => (
                      <option key={tone.id} value={tone.id}>
                        {RING_KEYS[tone.label] ? t(RING_KEYS[tone.label]) : tone.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn-secondary notif-ringtone-test"
                    disabled={!settings.soundEnabled && !settings.desktopEnabled}
                    onClick={() => void handleTest()}
                  >
                    {t('common.test')}
                  </button>
                </div>
              </label>

              <label className="settings-field">
                <span className="settings-field-label">{t('discord.urlLabel')}</span>
                <input
                  className="settings-input"
                  type="text"
                  value={webhookUrl}
                  placeholder="https://discord.com/api/webhooks/..."
                  onChange={(event) => {
                    setWebhookUrl(event.target.value);
                    setLocalError(null);
                  }}
                  spellCheck={false}
                />
              </label>
            </div>
          </div>

          {/* ---- The unified "Notify me about" matrix: Desktop | Discord per event ---- */}
          <div className="settings-form-card">
            <span className="settings-field-label">{t('notif.notifyAbout')}</span>

            <div className="notif-matrix">
              <div className="notif-matrix-head">
                <span />
                <span>{t('notif.colDesktop')}</span>
                <span>{t('notif.colDiscord')}</span>
              </div>

              {MATRIX_ROWS.map((row) => (
                <div key={row.discordKey} className="notif-matrix-row" title={t(row.helpKey)}>
                  <span className="settings-field-label">{t(row.labelKey)}</span>
                  <Toggle
                    on={settings.events[row.desktopKey]}
                    onClick={() =>
                      updateEvent(row.desktopKey, !settings.events[row.desktopKey])
                    }
                    label={settings.events[row.desktopKey] ? t('common.on') : t('common.off')}
                  />
                  <Toggle
                    on={discordEvents[row.discordKey]}
                    onClick={() =>
                      setDiscordEvents((current) => ({
                        ...current,
                        [row.discordKey]: !current[row.discordKey],
                      }))
                    }
                    label={discordEvents[row.discordKey] ? t('common.on') : t('common.off')}
                  />
                </div>
              ))}
            </div>

            {settings.events.underpricedListing || discordEvents.underpricedListing ? (
              <label className="settings-field notif-underpriced-tier">
                <span className="settings-field-label">{t('notif.underpriced.label')}</span>
                <select
                  className="settings-input"
                  value={settings.underpricedMinPctBelow}
                  onChange={(event) =>
                    update({ underpricedMinPctBelow: Number(event.target.value) })
                  }
                >
                  {UNDERPRICED_PCT_BELOW_OPTIONS.map((pct) => (
                    <option key={pct} value={pct}>
                      {t('notif.underpriced.option', { pct })}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <div className="settings-form-actions notif-save-row">
              <button
                className="settings-primary-btn"
                type="button"
                onClick={() => void handleSaveDiscord()}
                disabled={settingsLoading}
              >
                {settingsLoading ? t('common.saving') : t('common.save')}
              </button>
            </div>

            {localError || settingsError ? (
              <div className="settings-inline-error">{localError ?? settingsError}</div>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
