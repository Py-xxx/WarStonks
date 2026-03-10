import { useEffect, useMemo, useState } from 'react';
import { formatShortLocalDateTime, getUserTimeZone } from '../../lib/dateTime';
import { testAlecaframePublicLink } from '../../lib/tauriClient';
import { useAppStore } from '../../stores/useAppStore';
import type { AlecaframeValidationResult } from '../../types';

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
  const saveAlecaframeConfiguration = useAppStore(
    (state) => state.saveAlecaframeConfiguration,
  );

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
  }, [appSettings.alecaframe.enabled, appSettings.alecaframe.publicLink, modalOpen]);

  const trimmedPublicLink = publicLink.trim();

  const previewBalances = useMemo(
    () => validationResult?.balances ?? null,
    [validationResult],
  );

  if (!modalOpen) {
    return null;
  }

  const runValidation = async (): Promise<AlecaframeValidationResult | null> => {
    const input = trimmedPublicLink;
    if (!input) {
      setValidationResult(null);
      setTestedInput('');
      setLocalError('Enter an Alecaframe public link or public token.');
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
      setLocalError(toErrorMessage(error));
      setTestState('error');
      return null;
    }
  };

  const handleSave = async () => {
    setLocalError(null);

    if (enabled && !trimmedPublicLink) {
      setLocalError('Enter a valid Alecaframe public link before enabling the API.');
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
      setLocalError(toErrorMessage(error));
    }
  };

  return (
    <>
      <button
        className="modal-backdrop"
        type="button"
        aria-label="Close Alecaframe settings"
        onClick={closeModal}
      />
      <div className="settings-modal" role="dialog" aria-modal="true" aria-label="Alecaframe API settings">
        <div className="settings-modal-header">
          <div className="settings-modal-title">
            <span className="card-label">Alecaframe API</span>
            <h3>Alecaframe API Integration</h3>
          </div>
          <button
            className="settings-close-btn"
            type="button"
            aria-label="Close Alecaframe settings"
            onClick={closeModal}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="settings-modal-body">
          <div className="settings-form-card">
            <label className="settings-switch-row">
              <span className="settings-field-copy">
                <span className="settings-field-label">Enable Alecaframe API</span>
                <span className="settings-field-help">
                  Stored in app data outside the project so it works on both macOS and Windows.
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
              <span className="settings-field-label">Public link or token</span>
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
                {testState === 'loading' ? 'Testing…' : 'Test link'}
              </button>
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

            {testState === 'success' && validationResult ? (
              <div className="settings-inline-success">
                Alecaframe link validated successfully for{' '}
                {validationResult.usernameWhenPublic ?? 'the linked account'}.
              </div>
            ) : null}

            {localError ? <div className="settings-inline-error">{localError}</div> : null}
            {settingsError ? <div className="settings-inline-error">{settingsError}</div> : null}
          </div>

          <div className="settings-form-card">
            <span className="settings-field-label settings-section-title">Validation preview</span>
            <span className="settings-field-help">Times shown in {timeZone}.</span>
            <div className="settings-preview-grid">
              <div className="settings-preview-card">
                <span className="settings-meta-label">Public user</span>
                <span className="settings-meta-value">
                  {validationResult?.usernameWhenPublic ??
                    appSettings.alecaframe.usernameWhenPublic ??
                    'Not validated'}
                </span>
              </div>
              <div className="settings-preview-card">
                <span className="settings-meta-label">Last update</span>
                <span className="settings-meta-value">
                  {formatShortLocalDateTime(
                    validationResult?.lastUpdate ?? appSettings.alecaframe.lastValidatedAt,
                  )}
                </span>
              </div>
              <div className="settings-preview-card">
                <span className="settings-meta-label">Platinum</span>
                <span className="settings-meta-value">
                  {formatBalance(previewBalances?.platinum ?? null)}
                </span>
              </div>
              <div className="settings-preview-card">
                <span className="settings-meta-label">Credits</span>
                <span className="settings-meta-value">
                  {formatBalance(previewBalances?.credits ?? null)}
                </span>
              </div>
              <div className="settings-preview-card">
                <span className="settings-meta-label">Endo</span>
                <span className="settings-meta-value">
                  {formatBalance(previewBalances?.endo ?? null)}
                </span>
              </div>
              <div className="settings-preview-card">
                <span className="settings-meta-label">Ducats</span>
                <span className="settings-meta-value">
                  {formatBalance(previewBalances?.ducats ?? null)}
                </span>
              </div>
              <div className="settings-preview-card">
                <span className="settings-meta-label">Aya</span>
                <span className="settings-meta-value">
                  {formatBalance(previewBalances?.aya ?? null)}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
