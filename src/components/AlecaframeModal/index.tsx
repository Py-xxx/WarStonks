import { useEffect, useState } from 'react';
import { formatSettingsErrorMessage } from '../../lib/settingsErrorHandling';
import { probeLocalSources } from '../../lib/tauriClient';
import { useTranslation } from '../../i18n';
import { useAppStore } from '../../stores/useAppStore';
import { useModalA11y } from '../../hooks/useModalA11y';
import type { LocalSourceAvailability } from '../../types';

const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);

/**
 * AlecaFrame integration settings.
 *
 * This used to configure AlecaFrame's *public API* (a shared link, validated over the
 * network). It now reads AlecaFrame's local app data directly, so there is nothing to
 * configure beyond on/off — the data is already on disk, and no credentials or links are
 * involved.
 *
 * Note what this toggle does **not** control: private-message and trade detection come from
 * Warframe's own `EE.log`, which exists whenever the game is installed. Those are always on
 * and independent of AlecaFrame entirely.
 */
export function AlecaframeModal() {
  const modalOpen = useAppStore((state) => state.alecaframeModalOpen);
  const closeModal = useAppStore((state) => state.closeAlecaframeModal);
  const appSettings = useAppStore((state) => state.appSettings);
  const settingsLoading = useAppStore((state) => state.settingsLoading);
  const settingsError = useAppStore((state) => state.settingsError);
  const saveAlecaframeConfiguration = useAppStore((state) => state.saveAlecaframeConfiguration);
  const clearSettingsError = useAppStore((state) => state.clearSettingsError);
  const { t } = useTranslation();

  const [enabled, setEnabled] = useState(false);
  const [availability, setAvailability] = useState<LocalSourceAvailability | null>(null);
  const modalRef = useModalA11y<HTMLDivElement>({ onClose: closeModal, active: modalOpen });

  useEffect(() => {
    setEnabled(appSettings.alecaframe.enabled);
  }, [appSettings.alecaframe.enabled, modalOpen]);

  // Re-probed each time the dialog opens rather than cached: the user may have installed
  // AlecaFrame or launched the game since the app started, and a stale "not found" would
  // send them to fix something that is already working.
  useEffect(() => {
    if (!modalOpen) {
      return;
    }
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
  }, [modalOpen]);

  if (!modalOpen) {
    return null;
  }

  const detection = availability?.alecaframeInventory;
  const detected = detection?.status === 'available';

  const save = async (next: boolean) => {
    setEnabled(next);
    clearSettingsError();
    // `publicLink` is retained on the settings struct for now so existing saved configs
    // deserialize, but it is no longer read by anything.
    await saveAlecaframeConfiguration({ enabled: next, publicLink: null });
  };

  return (
    <>
      <button
        className="modal-backdrop"
        type="button"
        aria-label={t('aleca.close')}
        onClick={closeModal}
      />
      <div
        ref={modalRef}
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('aleca.subtitle')}
      >
        <div className="settings-modal-header">
          <div className="settings-modal-title">
            <h3>{t('aleca.subtitle')}</h3>
          </div>
          <div className="settings-modal-actions">
            <button
              className="settings-close-btn"
              type="button"
              aria-label={t('aleca.close')}
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
                <span className="settings-field-label">{t('aleca.enable.label')}</span>
                <span className="settings-field-help">{t('aleca.enable.help')}</span>
              </span>
              <button
                className={`settings-toggle${enabled ? ' on' : ''}`}
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label={t('aleca.enable.label')}
                disabled={settingsLoading}
                onClick={() => void save(!enabled)}
              >
                <span className="settings-toggle-track">
                  <span className="settings-toggle-thumb" />
                </span>
                <span className="settings-toggle-label">
                  {enabled ? t('common.on') : t('common.off')}
                </span>
              </button>
            </label>

            <div className="aleca-detect-row">
              <span className={`aleca-detect-dot${detected ? ' on' : ''}`} aria-hidden="true" />
              <span className="aleca-detect-copy">
                {availability === null
                  ? t('aleca.detect.checking')
                  : detected
                    ? t('aleca.detect.found')
                    : t('aleca.detect.missing')}
              </span>
            </div>

            {/* Turning it on while AlecaFrame isn't installed is allowed — the user may be
                about to install it — but saying so beats an inventory that stays empty for
                no visible reason. */}
            {enabled && availability !== null && !detected ? (
              <p className="settings-inline-warning">{t('aleca.detect.enabledButMissing')}</p>
            ) : null}

            {/* What the switch actually turns on, stated plainly. The old API integration
                controlled trade detection too, so it is worth being explicit that this no
                longer does. */}
            <div className="aleca-unlocks">
              <span className="aleca-unlocks-title">{t('aleca.unlocks.title')}</span>
              <ul className="aleca-unlocks-list">
                <li>{t('aleca.unlocks.inventory')}</li>
                <li>{t('aleca.unlocks.relics')}</li>
                <li>{t('aleca.unlocks.wallet')}</li>
              </ul>
            </div>

            {settingsError ? (
              <p className="settings-inline-error" role="alert">
                {formatSettingsErrorMessage('alecaframe-save', settingsError)}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
