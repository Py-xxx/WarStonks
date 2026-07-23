import { useState } from 'react';
import { useTranslation } from '../../i18n';
import type { TranslationKey } from '../../i18n/en';
import { useAppStore } from '../../stores/useAppStore';
import { useModalA11y } from '../../hooks/useModalA11y';
import { RINGTONES, playAlertSound } from '../../lib/alertAudio';

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

interface EventRow {
  key: keyof NotificationSettings['events'];
  labelKey: TranslationKey;
  helpKey: TranslationKey;
}

const EVENT_ROWS: EventRow[] = [
  {
    key: 'watchlistAlert',
    labelKey: 'notif.event.watchlistAlert.label',
    helpKey: 'notif.event.watchlistAlert.help',
  },
  {
    key: 'underpricedListing',
    labelKey: 'notif.event.underpricedListing.label',
    helpKey: 'notif.event.underpricedListing.help',
  },
  {
    key: 'listingHealth',
    labelKey: 'notif.event.listingHealth.label',
    helpKey: 'notif.event.listingHealth.help',
  },
  {
    key: 'priceChange',
    labelKey: 'notif.event.priceChange.label',
    helpKey: 'notif.event.priceChange.help',
  },
  {
    key: 'scannerStale',
    labelKey: 'notif.event.scannerStale.label',
    helpKey: 'notif.event.scannerStale.help',
  },
  {
    key: 'appUpdate',
    labelKey: 'notif.event.appUpdate.label',
    helpKey: 'notif.event.appUpdate.help',
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
  const { t } = useTranslation();
  const [permissionNote, setPermissionNote] = useState<TranslationKey | null>(null);
  const modalRef = useModalA11y<HTMLDivElement>({ onClose: closeModal, active: modalOpen });

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

        <div className="settings-modal-body">
          <div className="settings-form-card">
            <label className="settings-switch-row">
              <span className="settings-field-copy">
                <span className="settings-field-label">{t('notif.desktop.label')}</span>
                <span className="settings-field-help">
                  {t('notif.desktop.help')}
                </span>
              </span>
              <Toggle
                on={settings.desktopEnabled}
                onClick={() => void handleToggleDesktop()}
                label={settings.desktopEnabled ? t('common.on') : t('common.off')}
              />
            </label>

            {permissionNote ? (
              <div className="settings-inline-warning">{t(permissionNote)}</div>
            ) : null}

            <label className="settings-switch-row">
              <span className="settings-field-copy">
                <span className="settings-field-label">{t('notif.sound.label')}</span>
                <span className="settings-field-help">{t('notif.sound.help')}</span>
              </span>
              <Toggle
                on={settings.soundEnabled}
                onClick={() => update({ soundEnabled: !settings.soundEnabled })}
                label={settings.soundEnabled ? t('common.on') : t('common.off')}
              />
            </label>

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
          </div>

          <div className="settings-form-card">
            <span className="settings-field-label">{t('notif.notifyAbout')}</span>
            <div className="settings-notification-grid">
              {EVENT_ROWS.map((row) => (
                <label
                  key={row.key}
                  className="settings-switch-row settings-switch-row-compact"
                  title={t(row.helpKey)}
                >
                  <span className="settings-field-copy">
                    <span className="settings-field-label">{t(row.labelKey)}</span>
                  </span>
                  <Toggle
                    on={settings.events[row.key]}
                    onClick={() => updateEvent(row.key, !settings.events[row.key])}
                    label={settings.events[row.key] ? t('common.on') : t('common.off')}
                  />
                </label>
              ))}
            </div>

            {settings.events.underpricedListing ? (
              <label className="settings-field notif-underpriced-tier">
                <span className="settings-field-label">{t('notif.underpriced.label')}</span>
                <span className="settings-field-help">
                  {t('notif.underpriced.help')}
                </span>
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
          </div>
        </div>
      </div>
    </>
  );
}
