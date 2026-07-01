import { useEffect, useMemo, useState } from 'react';
import { formatShortLocalDateTime, getUserTimeZone } from '../../lib/dateTime';
import { formatSettingsErrorMessage } from '../../lib/settingsErrorHandling';
import { testAlecaframePublicLink } from '../../lib/tauriClient';
import { useTranslation } from '../../i18n';
import { useAppStore } from '../../stores/useAppStore';
import { useModalA11y } from '../../hooks/useModalA11y';
import type { AlecaframeValidationResult } from '../../types';

const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);

function formatBalance(value: number | null): string {
  if (value === null) {
    return '-';
  }

  return new Intl.NumberFormat().format(value);
}

export function AlecaframeModal() {
  const modalOpen = useAppStore((state) => state.alecaframeModalOpen);
  const closeModal = useAppStore((state) => state.closeAlecaframeModal);
  const appSettings = useAppStore((state) => state.appSettings);
  const settingsLoading = useAppStore((state) => state.settingsLoading);
  const settingsError = useAppStore((state) => state.settingsError);
  const walletSnapshot = useAppStore((state) => state.walletSnapshot);
  const walletLoading = useAppStore((state) => state.walletLoading);
  const refreshWalletSnapshot = useAppStore((state) => state.refreshWalletSnapshot);
  const saveAlecaframeConfiguration = useAppStore(
    (state) => state.saveAlecaframeConfiguration,
  );
  const clearSettingsError = useAppStore((state) => state.clearSettingsError);
  const { t } = useTranslation();

  const [enabled, setEnabled] = useState(false);
  const [publicLink, setPublicLink] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [testState, setTestState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [validationResult, setValidationResult] = useState<AlecaframeValidationResult | null>(null);
  const [testedInput, setTestedInput] = useState('');
  const timeZone = useMemo(() => getUserTimeZone(), []);

  useEffect(() => {
    if (!modalOpen) {
      return;
    }

    setEnabled(appSettings.alecaframe.enabled);
    setPublicLink(appSettings.alecaframe.publicLink ?? '');
    setLocalError(null);
    setTestState('idle');
    setValidationResult(null);
    setTestedInput('');
    clearSettingsError();
  }, [
    appSettings.alecaframe.enabled,
    appSettings.alecaframe.publicLink,
    clearSettingsError,
    modalOpen,
  ]);

  const modalRef = useModalA11y<HTMLDivElement>({ onClose: closeModal, active: modalOpen });

  useEffect(() => {
    if (!modalOpen || !appSettings.alecaframe.enabled || !appSettings.alecaframe.publicLink) {
      return;
    }

    void refreshWalletSnapshot();
  }, [
    appSettings.alecaframe.enabled,
    appSettings.alecaframe.publicLink,
    modalOpen,
    refreshWalletSnapshot,
  ]);

  const trimmedPublicLink = publicLink.trim();

  const previewBalances = useMemo(
    () => validationResult?.balances ?? walletSnapshot.balances,
    [validationResult, walletSnapshot.balances],
  );

  const previewUsername =
    validationResult?.usernameWhenPublic ??
    walletSnapshot.usernameWhenPublic ??
    appSettings.alecaframe.usernameWhenPublic;

  const previewLastUpdate =
    validationResult?.lastUpdate ??
    walletSnapshot.lastUpdate ??
    appSettings.alecaframe.lastValidatedAt;

  if (!modalOpen) {
    return null;
  }

  const runValidation = async (): Promise<AlecaframeValidationResult | null> => {
    const input = trimmedPublicLink;
    if (!input) {
      setValidationResult(null);
      setTestedInput('');
      setLocalError(t('aleca.err.enterLink'));
      setTestState('error');
      return null;
    }

    setLocalError(null);
    setTestState('loading');

    try {
      const result = await testAlecaframePublicLink(input);
      setValidationResult(result);
      setTestedInput(input);
      setTestState('success');
      return result;
    } catch (error) {
      setValidationResult(null);
      setTestedInput('');
      setLocalError(formatSettingsErrorMessage('alecaframe-validate', error));
      setTestState('error');
      return null;
    }
  };

  const handleSave = async () => {
    setLocalError(null);
    clearSettingsError();

    if (enabled && !trimmedPublicLink) {
      setLocalError(t('aleca.err.enterValidBeforeEnable'));
      return;
    }

    if (trimmedPublicLink && testedInput !== trimmedPublicLink) {
      const result = await runValidation();
      if (!result) {
        return;
      }
    }

    try {
      await saveAlecaframeConfiguration({
        enabled,
        publicLink: trimmedPublicLink || null,
      });
    } catch (error) {
      setLocalError(formatSettingsErrorMessage('alecaframe-save', error));
    }
  };

  const walletWarningMessage =
    walletSnapshot.errorMessage && appSettings.alecaframe.enabled && appSettings.alecaframe.publicLink
      ? walletSnapshot.errorMessage
      : null;

  return (
    <>
      <button
        className="modal-backdrop"
        type="button"
        aria-label={t('aleca.close')}
        onClick={closeModal}
      />
      <div ref={modalRef} className="settings-modal" role="dialog" aria-modal="true" aria-label={t('aleca.subtitle')}>
        <div className="settings-modal-header">
          <div className="settings-modal-title">
            <span className="card-label">{t('settings.section.alecaframe.label')}</span>
            <h3>{t('aleca.subtitle')}</h3>
          </div>
          <div className="settings-modal-actions">
            <button
              className="settings-secondary-btn settings-refresh-btn"
              type="button"
              onClick={() => {
                void refreshWalletSnapshot();
              }}
              disabled={
                walletLoading ||
                !appSettings.alecaframe.enabled ||
                !appSettings.alecaframe.publicLink
              }
            >
              {walletLoading ? t('common.refreshing') : t('common.refresh')}
            </button>
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
                <span className="settings-field-help">
                  {t('aleca.enable.help')}
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
              <span className="settings-field-label">{t('aleca.linkLabel')}</span>
              <input
                className="settings-input"
                type="text"
                value={publicLink}
                placeholder="https://stats.alecaframe.com/api/stats/public?token=..."
                onChange={(event) => {
                  setPublicLink(event.target.value);
                  setLocalError(null);
                  setTestState('idle');
                  setValidationResult(null);
                  setTestedInput('');
                }}
                spellCheck={false}
              />
            </label>

            <div className="settings-form-actions">
              <button
                className="settings-secondary-btn"
                type="button"
                onClick={() => {
                  void runValidation();
                }}
                disabled={!trimmedPublicLink || settingsLoading || testState === 'loading'}
              >
                {testState === 'loading' ? t('aleca.testing') : t('aleca.testLink')}
              </button>
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

            {testState === 'success' && validationResult ? (
              <div className="settings-inline-success">
                {t('aleca.validatedSuccess', {
                  name: validationResult.usernameWhenPublic ?? t('aleca.linkedAccount'),
                })}
              </div>
            ) : null}

            {localError ? <div className="settings-inline-error">{localError}</div> : null}
            {settingsError ? <div className="settings-inline-error">{settingsError}</div> : null}
          </div>

          <div className="settings-form-card">
            <span className="settings-field-label settings-section-title">{t('aleca.preview.title')}</span>
            <span className="settings-field-help">{t('aleca.preview.times', { tz: timeZone })}</span>
            <div className="settings-preview-grid">
              <div className="settings-preview-card">
                <span className="settings-meta-label">{t('aleca.preview.publicUser')}</span>
                <span className="settings-meta-value">
                  {previewUsername ?? t('aleca.preview.notValidated')}
                </span>
              </div>
              <div className="settings-preview-card">
                <span className="settings-meta-label">{t('aleca.preview.lastUpdate')}</span>
                <span className="settings-meta-value">
                  {formatShortLocalDateTime(previewLastUpdate)}
                </span>
              </div>
              <div className="settings-preview-card">
                <span className="settings-meta-label">{t('bal.platinum')}</span>
                <span className="settings-meta-value">
                  {formatBalance(previewBalances?.platinum ?? null)}
                </span>
              </div>
              <div className="settings-preview-card">
                <span className="settings-meta-label">{t('bal.credits')}</span>
                <span className="settings-meta-value">
                  {formatBalance(previewBalances?.credits ?? null)}
                </span>
              </div>
              <div className="settings-preview-card">
                <span className="settings-meta-label">{t('bal.endo')}</span>
                <span className="settings-meta-value">
                  {formatBalance(previewBalances?.endo ?? null)}
                </span>
              </div>
              <div className="settings-preview-card">
                <span className="settings-meta-label">{t('bal.ducats')}</span>
                <span className="settings-meta-value">
                  {formatBalance(previewBalances?.ducats ?? null)}
                </span>
              </div>
              <div className="settings-preview-card">
                <span className="settings-meta-label">{t('bal.aya')}</span>
                <span className="settings-meta-value">
                  {formatBalance(previewBalances?.aya ?? null)}
                </span>
              </div>
            </div>
            {walletWarningMessage ? (
              <div className="settings-inline-warning">{walletWarningMessage}</div>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
