import { useEffect, useState } from 'react';
import { formatSettingsErrorMessage } from '../../lib/settingsErrorHandling';
import { useTranslation } from '../../i18n';
import { useAppStore } from '../../stores/useAppStore';
import { useModalA11y } from '../../hooks/useModalA11y';

const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);

export function DiscordWebhookModal() {
  const modalOpen = useAppStore((state) => state.discordWebhookModalOpen);
  const closeModal = useAppStore((state) => state.closeDiscordWebhookModal);
  const appSettings = useAppStore((state) => state.appSettings);
  const settingsLoading = useAppStore((state) => state.settingsLoading);
  const settingsError = useAppStore((state) => state.settingsError);
  const saveDiscordWebhookConfiguration = useAppStore(
    (state) => state.saveDiscordWebhookConfiguration,
  );
  const clearSettingsError = useAppStore((state) => state.clearSettingsError);
  const { t } = useTranslation();

  const [enabled, setEnabled] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [watchlistFound, setWatchlistFound] = useState(true);
  const [tradeDetected, setTradeDetected] = useState(true);
  const [underpricedListing, setUnderpricedListing] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!modalOpen) {
      return;
    }

    setEnabled(appSettings.discordWebhook.enabled);
    setWebhookUrl(appSettings.discordWebhook.webhookUrl ?? '');
    setWatchlistFound(appSettings.discordWebhook.notifications.watchlistFound);
    setTradeDetected(appSettings.discordWebhook.notifications.tradeDetected);
    setUnderpricedListing(appSettings.discordWebhook.notifications.underpricedListing);
    setLocalError(null);
    clearSettingsError();
  }, [appSettings.discordWebhook, clearSettingsError, modalOpen]);

  const modalRef = useModalA11y<HTMLDivElement>({ onClose: closeModal, active: modalOpen });

  if (!modalOpen) {
    return null;
  }

  const handleSave = async () => {
    setLocalError(null);
    clearSettingsError();
    try {
      await saveDiscordWebhookConfiguration({
        enabled,
        webhookUrl: webhookUrl.trim() || null,
        notifications: {
          watchlistFound,
          tradeDetected,
          underpricedListing,
        },
      });
    } catch (error) {
      setLocalError(formatSettingsErrorMessage('discord-webhook-save', error));
    }
  };

  return (
    <>
      <button
        className="modal-backdrop"
        type="button"
        aria-label={t('discord.close')}
        onClick={closeModal}
      />
      <div ref={modalRef} className="settings-modal" role="dialog" aria-modal="true" aria-label={t('discord.subtitle')}>
        <div className="settings-modal-header">
          <div className="settings-modal-title">
            <span className="card-label">{t('settings.section.discord.label')}</span>
            <h3>{t('discord.subtitle')}</h3>
          </div>
          <div className="settings-modal-actions">
            <button
              className="settings-close-btn"
              type="button"
              aria-label={t('discord.close')}
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
                <span className="settings-field-label">{t('discord.enable.label')}</span>
                <span className="settings-field-help">
                  {t('discord.enable.help')}
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
                <span className="settings-toggle-label">{enabled ? t('common.on') : t('common.off')}</span>
              </button>
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

            <div className="settings-notification-grid">
              <label className="settings-switch-row settings-switch-row-compact">
                <span className="settings-field-copy">
                  <span className="settings-field-label">{t('discord.event.watchlist.label')}</span>
                  <span className="settings-field-help">{t('discord.event.watchlist.help')}</span>
                </span>
                <button
                  className={`settings-toggle${watchlistFound ? ' on' : ''}`}
                  type="button"
                  role="switch"
                  aria-checked={watchlistFound}
                  aria-label={t('discord.event.watchlist.aria')}
                  onClick={() => setWatchlistFound((current) => !current)}
                >
                  <span className="settings-toggle-track">
                    <span className="settings-toggle-thumb" />
                  </span>
                </button>
              </label>

              <label className="settings-switch-row settings-switch-row-compact">
                <span className="settings-field-copy">
                  <span className="settings-field-label">{t('discord.event.trades.label')}</span>
                  <span className="settings-field-help">{t('discord.event.trades.help')}</span>
                </span>
                <button
                  className={`settings-toggle${tradeDetected ? ' on' : ''}`}
                  type="button"
                  role="switch"
                  aria-checked={tradeDetected}
                  aria-label={t('discord.event.trades.aria')}
                  onClick={() => setTradeDetected((current) => !current)}
                >
                  <span className="settings-toggle-track">
                    <span className="settings-toggle-thumb" />
                  </span>
                </button>
              </label>

              <label className="settings-switch-row settings-switch-row-compact">
                <span className="settings-field-copy">
                  <span className="settings-field-label">{t('discord.event.underpriced.label')}</span>
                  <span className="settings-field-help">{t('discord.event.underpriced.help')}</span>
                </span>
                <button
                  className={`settings-toggle${underpricedListing ? ' on' : ''}`}
                  type="button"
                  role="switch"
                  aria-checked={underpricedListing}
                  aria-label={t('discord.event.underpriced.aria')}
                  onClick={() => setUnderpricedListing((current) => !current)}
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
