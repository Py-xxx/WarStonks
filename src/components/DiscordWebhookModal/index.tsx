import { useEffect, useState } from 'react';
import { useAppStore } from '../../stores/useAppStore';

const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function DiscordWebhookModal() {
  const modalOpen = useAppStore((state) => state.discordWebhookModalOpen);
  const closeModal = useAppStore((state) => state.closeDiscordWebhookModal);
  const appSettings = useAppStore((state) => state.appSettings);
  const settingsLoading = useAppStore((state) => state.settingsLoading);
  const settingsError = useAppStore((state) => state.settingsError);
  const saveDiscordWebhookConfiguration = useAppStore(
    (state) => state.saveDiscordWebhookConfiguration,
  );

  const [enabled, setEnabled] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [watchlistFound, setWatchlistFound] = useState(true);
  const [tradeDetected, setTradeDetected] = useState(true);
  const [worldstateOffline, setWorldstateOffline] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!modalOpen) {
      return;
    }

    setEnabled(appSettings.discordWebhook.enabled);
    setWebhookUrl(appSettings.discordWebhook.webhookUrl ?? '');
    setWatchlistFound(appSettings.discordWebhook.notifications.watchlistFound);
    setTradeDetected(appSettings.discordWebhook.notifications.tradeDetected);
    setWorldstateOffline(appSettings.discordWebhook.notifications.worldstateOffline);
    setLocalError(null);
  }, [appSettings.discordWebhook, modalOpen]);

  if (!modalOpen) {
    return null;
  }

  const handleSave = async () => {
    setLocalError(null);
    try {
      await saveDiscordWebhookConfiguration({
        enabled,
        webhookUrl: webhookUrl.trim() || null,
        notifications: {
          watchlistFound,
          tradeDetected,
          worldstateOffline,
        },
      });
    } catch (error) {
      setLocalError(toErrorMessage(error));
    }
  };

  return (
    <>
      <button
        className="modal-backdrop"
        type="button"
        aria-label="Close Discord webhook settings"
        onClick={closeModal}
      />
      <div className="settings-modal" role="dialog" aria-modal="true" aria-label="Discord webhook settings">
        <div className="settings-modal-header">
          <div className="settings-modal-title">
            <span className="card-label">Discord Webhook</span>
            <h3>Discord Notifications</h3>
          </div>
          <div className="settings-modal-actions">
            <button
              className="settings-close-btn"
              type="button"
              aria-label="Close Discord webhook settings"
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
                <span className="settings-field-label">Enable Discord Webhook</span>
                <span className="settings-field-help">
                  Sends rich Discord embeds for selected WarStonks alerts. Saving will send a test notification.
                </span>
              </span>
              <button
                className={`settings-toggle${enabled ? ' on' : ''}`}
                type="button"
                role="switch"
                aria-checked={enabled}
                onClick={() => setEnabled((current) => !current)}
              >
                <span className="settings-toggle-track">
                  <span className="settings-toggle-thumb" />
                </span>
                <span className="settings-toggle-label">{enabled ? 'On' : 'Off'}</span>
              </button>
            </label>

            <label className="settings-field">
              <span className="settings-field-label">Webhook URL</span>
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

            <div className="settings-notification-grid">
              <label className="settings-switch-row settings-switch-row-compact">
                <span className="settings-field-copy">
                  <span className="settings-field-label">Watchlist Item Found</span>
                  <span className="settings-field-help">Notify when a target price is hit.</span>
                </span>
                <button
                  className={`settings-toggle${watchlistFound ? ' on' : ''}`}
                  type="button"
                  role="switch"
                  aria-checked={watchlistFound}
                  onClick={() => setWatchlistFound((current) => !current)}
                >
                  <span className="settings-toggle-track">
                    <span className="settings-toggle-thumb" />
                  </span>
                </button>
              </label>

              <label className="settings-switch-row settings-switch-row-compact">
                <span className="settings-field-copy">
                  <span className="settings-field-label">New Trades Detected</span>
                  <span className="settings-field-help">Notify when new buy or sell trades are detected.</span>
                </span>
                <button
                  className={`settings-toggle${tradeDetected ? ' on' : ''}`}
                  type="button"
                  role="switch"
                  aria-checked={tradeDetected}
                  onClick={() => setTradeDetected((current) => !current)}
                >
                  <span className="settings-toggle-track">
                    <span className="settings-toggle-thumb" />
                  </span>
                </button>
              </label>

              <label className="settings-switch-row settings-switch-row-compact">
                <span className="settings-field-copy">
                  <span className="settings-field-label">WFStat Offline</span>
                  <span className="settings-field-help">Notify when worldstate feeds fail.</span>
                </span>
                <button
                  className={`settings-toggle${worldstateOffline ? ' on' : ''}`}
                  type="button"
                  role="switch"
                  aria-checked={worldstateOffline}
                  onClick={() => setWorldstateOffline((current) => !current)}
                >
                  <span className="settings-toggle-track">
                    <span className="settings-toggle-thumb" />
                  </span>
                </button>
              </label>
            </div>

            <div className="settings-form-actions">
              <button
                className="settings-primary-btn"
                type="button"
                onClick={() => {
                  void handleSave();
                }}
                disabled={settingsLoading}
              >
                {settingsLoading ? 'Saving…' : 'Save'}
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
