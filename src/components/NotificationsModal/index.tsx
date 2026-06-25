import { useState } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { useModalA11y } from '../../hooks/useModalA11y';
import { RINGTONES, playAlertSound } from '../../lib/alertAudio';
import {
  isDesktopNotificationSupported,
  requestDesktopNotificationPermission,
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
  label: string;
  help: string;
}

const EVENT_ROWS: EventRow[] = [
  { key: 'watchlistAlert', label: 'Watchlist Alert', help: 'When a watchlist target price is hit.' },
  { key: 'scannerStale', label: 'Scanner Stale', help: 'When scanner data goes out of date.' },
  { key: 'appUpdate', label: 'App Update', help: 'When a new WarStonks version is available.' },
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
  const [permissionNote, setPermissionNote] = useState<string | null>(null);
  const modalRef = useModalA11y<HTMLDivElement>({ onClose: closeModal, active: modalOpen });

  if (!modalOpen) {
    return null;
  }

  const update = (patch: Partial<NotificationSettings>) => setSettings({ ...settings, ...patch });
  const updateEvent = (key: keyof NotificationSettings['events'], value: boolean) =>
    setSettings({ ...settings, events: { ...settings.events, [key]: value } });

  const handleToggleDesktop = async () => {
    if (settings.desktopEnabled) {
      update({ desktopEnabled: false });
      setPermissionNote(null);
      return;
    }
    if (!isDesktopNotificationSupported()) {
      setPermissionNote('Desktop notifications are not available in this environment.');
      return;
    }
    // Triggers the native OS permission prompt (via the Tauri notification plugin).
    const permission = await requestDesktopNotificationPermission();
    if (permission === 'granted') {
      update({ desktopEnabled: true });
      setPermissionNote(null);
    } else if (permission === 'denied') {
      setPermissionNote(
        'Notifications are blocked for WarStonks. Enable them in your OS settings (macOS: System Settings → Notifications → WarStonks; Windows: Settings → Notifications), then try again.',
      );
    } else if (permission === 'unsupported') {
      setPermissionNote('Desktop notifications are not available in this environment.');
    } else {
      setPermissionNote('Notification permission was not granted. Click Enable again to retry.');
    }
  };

  return (
    <>
      <button
        className="modal-backdrop"
        type="button"
        aria-label="Close notification settings"
        onClick={closeModal}
      />
      <div ref={modalRef} className="settings-modal" role="dialog" aria-modal="true" aria-label="Notification settings">
        <div className="settings-modal-header">
          <div className="settings-modal-title">
            <span className="card-label">Notifications</span>
            <h3>Alerts &amp; Sound</h3>
          </div>
          <div className="settings-modal-actions">
            <button
              className="settings-close-btn"
              type="button"
              aria-label="Close notification settings"
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
                <span className="settings-field-label">Desktop Notifications</span>
                <span className="settings-field-help">
                  Show a native OS notification when an alert fires (requires permission).
                </span>
              </span>
              <Toggle
                on={settings.desktopEnabled}
                onClick={() => void handleToggleDesktop()}
                label={settings.desktopEnabled ? 'On' : 'Off'}
              />
            </label>

            {permissionNote ? (
              <div className="settings-inline-warning">{permissionNote}</div>
            ) : null}

            <label className="settings-switch-row">
              <span className="settings-field-copy">
                <span className="settings-field-label">Alert Sound</span>
                <span className="settings-field-help">Play an in-app tone when an alert fires.</span>
              </span>
              <Toggle
                on={settings.soundEnabled}
                onClick={() => update({ soundEnabled: !settings.soundEnabled })}
                label={settings.soundEnabled ? 'On' : 'Off'}
              />
            </label>

            <label className="settings-field">
              <span className="settings-field-label">Ringtone</span>
              <div className="notif-ringtone-row">
                <select
                  className="settings-input notif-ringtone-select"
                  value={settings.ringtone}
                  disabled={!settings.soundEnabled}
                  onChange={(event) => update({ ringtone: event.target.value as RingtoneId })}
                >
                  {RINGTONES.map((tone) => (
                    <option key={tone.id} value={tone.id}>
                      {tone.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn-secondary notif-ringtone-test"
                  disabled={!settings.soundEnabled}
                  onClick={() => void playAlertSound(settings.ringtone).catch(() => undefined)}
                >
                  Test
                </button>
              </div>
            </label>
          </div>

          <div className="settings-form-card">
            <span className="settings-field-label">Notify me about</span>
            <div className="settings-notification-grid">
              {EVENT_ROWS.map((row) => (
                <label key={row.key} className="settings-switch-row settings-switch-row-compact">
                  <span className="settings-field-copy">
                    <span className="settings-field-label">{row.label}</span>
                    <span className="settings-field-help">{row.help}</span>
                  </span>
                  <Toggle
                    on={settings.events[row.key]}
                    onClick={() => updateEvent(row.key, !settings.events[row.key])}
                  />
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
