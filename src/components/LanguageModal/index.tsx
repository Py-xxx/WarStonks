import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { useModalA11y } from '../../hooks/useModalA11y';
import { translate, useTranslation } from '../../i18n';
import type { TranslationKey } from '../../i18n/en';
import { LANGUAGES, type AppLanguage, wfstatLangCode } from '../../lib/language';
import {
  getLanguagePackStatus,
  openExternalUrl,
  populateLanguageItemNames,
  type LanguagePackStatus,
} from '../../lib/tauriClient';
import { exportLanguagePackFile, importLanguagePackFile } from '../../lib/languagePack';

const DISCORD_INVITE = 'https://discord.com/invite/jMZYkP2URF';

const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);

/** Maps a backend LANGPACK_* code to a localized message key. */
function packErrorKey(error: unknown): TranslationKey {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('LANGPACK_EMPTY')) return 'langpanel.err.empty';
  if (message.includes('LANGPACK_OFFLINE')) return 'langpanel.err.offline';
  if (message.includes('LANGPACK_STALE')) return 'langpanel.err.stale';
  return 'langpanel.err.badformat';
}

/** wfstat code (e.g. "zh") back to our AppLanguage (e.g. "zh-hans"). */
function appLanguageForWfstat(code: string): AppLanguage | null {
  return LANGUAGES.find((option) => wfstatLangCode(option.code) === code)?.code ?? null;
}

export function LanguageModal() {
  const modalOpen = useAppStore((s) => s.languageModalOpen);
  const closeModal = useAppStore((s) => s.closeLanguageModal);
  const language = useAppStore((s) => s.language);
  const setLanguage = useAppStore((s) => s.setLanguage);
  const pushToast = useAppStore((s) => s.pushToast);
  const { t } = useTranslation();
  const modalRef = useModalA11y<HTMLDivElement>({ onClose: closeModal, active: modalOpen });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [status, setStatus] = useState<LanguagePackStatus | null>(null);
  const [busy, setBusy] = useState<'idle' | 'export' | 'import' | 'download' | 'switching'>('idle');
  // When set, a full-screen overlay covers the app until the reload lands. The overlay's
  // text renders in the TARGET language as a first taste of the switch.
  const [switchTarget, setSwitchTarget] = useState<AppLanguage | null>(null);

  const nativeName = LANGUAGES.find((o) => o.code === language)?.native ?? language;

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await getLanguagePackStatus(wfstatLangCode(language)));
    } catch {
      setStatus(null);
    }
  }, [language]);

  // Switch language: point the backend at it, install item names if missing (and online), then
  // do a FULL reload so every already-fetched surface (worldstate, market, trades, quick view)
  // re-renders in the new language rather than keeping stale cached names.
  const handleSwitchLanguage = useCallback(
    async (next: AppLanguage) => {
      setBusy('switching');
      setSwitchTarget(next);
      setLanguage(next);
      try {
        if (next !== 'en') {
          const nextStatus = await getLanguagePackStatus(wfstatLangCode(next));
          if (nextStatus && !nextStatus.populated && nextStatus.wfstatReachable) {
            await populateLanguageItemNames(wfstatLangCode(next));
          }
        }
      } catch {
        // Reload regardless — names simply fall back to English until a pack is installed.
      }
      window.location.reload();
    },
    [setLanguage],
  );

  const handleDownload = useCallback(async () => {
    setBusy('download');
    setSwitchTarget(language);
    try {
      await populateLanguageItemNames(wfstatLangCode(language));
      window.location.reload();
    } catch {
      setSwitchTarget(null);
      pushToast(t('langpanel.err.downloadFailed'), 'error');
      await refreshStatus();
      setBusy('idle');
    }
  }, [language, pushToast, refreshStatus, t]);

  useEffect(() => {
    if (modalOpen) {
      void refreshStatus();
    }
  }, [modalOpen, refreshStatus]);

  if (!modalOpen) {
    return null;
  }

  const handleExport = async () => {
    setBusy('export');
    try {
      const count = await exportLanguagePackFile(wfstatLangCode(language));
      pushToast(t('langpanel.exportOk', { lang: nativeName, count }), 'success');
    } catch (error) {
      pushToast(t(packErrorKey(error)), 'error');
    } finally {
      setBusy('idle');
    }
  };

  const handleImportFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy('import');
    try {
      const result = await importLanguagePackFile(file);
      const applied = appLanguageForWfstat(result.langCode);
      setSwitchTarget(applied ?? language);
      if (applied) {
        setLanguage(applied);
      }
      // Full reload so the imported language applies everywhere.
      window.location.reload();
    } catch (error) {
      setSwitchTarget(null);
      pushToast(t(packErrorKey(error)), 'error');
      setBusy('idle');
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const isEnglish = language === 'en';
  const populated = isEnglish || (status?.populated ?? false);
  const canExport = !isEnglish && !!status?.populated && status.upToDate && status.wfstatReachable;

  const versionStatusKey: TranslationKey | null = !status
    ? null
    : !status.wfstatReachable
      ? 'langpanel.status.offline'
      : status.upToDate
        ? 'langpanel.status.upToDate'
        : 'langpanel.status.stale';

  const overlay = switchTarget ? (
    <div className="lang-switch-overlay" role="status" aria-live="polite">
      <div className="lang-switch-globe" aria-hidden="true">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18" />
          <path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18" />
        </svg>
        <span className="lang-switch-ring" />
      </div>
      <span className="lang-switch-label">
        {translate(switchTarget, 'langpanel.switching', {
          lang: LANGUAGES.find((option) => option.code === switchTarget)?.native ?? switchTarget,
        })}
      </span>
      <span className="lang-switch-sub">
        {busy === 'import' ? translate(switchTarget, 'langpanel.applyingPack') : null}
      </span>
    </div>
  ) : null;

  return (
    <>
      {overlay}
      <button
        className="modal-backdrop"
        type="button"
        aria-label={t('langpanel.close')}
        onClick={closeModal}
      />
      <div
        ref={modalRef}
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('langpanel.subtitle')}
      >
        <div className="settings-modal-header">
          <div className="settings-modal-title">
            <span className="card-label">{t('langpanel.section.label')}</span>
            <h3>
              {t('langpanel.subtitle')}{' '}
              <span className="badge settings-beta-badge">{t('opp.beta')}</span>
            </h3>
          </div>
          <div className="settings-modal-actions">
            <button
              className="settings-close-btn"
              type="button"
              aria-label={t('langpanel.close')}
              onClick={closeModal}
            >
              <CloseIcon />
            </button>
          </div>
        </div>

        <div className="settings-modal-body">
          <div className="settings-form-card">
            <label className="settings-language-row">
              <span className="settings-language-glyph" aria-hidden="true">🌐</span>
              <span className="settings-language-label">{t('settings.language')}</span>
              <select
                className="settings-input settings-language-select"
                value={language}
                disabled={busy !== 'idle'}
                onChange={(event) => void handleSwitchLanguage(event.target.value as AppLanguage)}
                aria-label={t('settings.language.aria')}
              >
                {LANGUAGES.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.flag} {option.native}
                  </option>
                ))}
              </select>
            </label>
            <div className="langpanel-beta-note">{t('langpanel.betaNote')}</div>
          </div>

          <div className="settings-form-card">
              <span className="settings-field-label">{t('langpanel.status.title')}</span>
              <span className="settings-field-help">
                {populated
                  ? t('langpanel.status.installed', { count: isEnglish ? 0 : status?.itemCount ?? 0 })
                  : t('langpanel.status.notInstalled')}
                {!isEnglish && versionStatusKey ? ` · ${t(versionStatusKey)}` : ''}
              </span>

              {!isEnglish && !populated && status ? (
                <div className="settings-inline-warning">
                  {status.wfstatReachable
                    ? t('langpanel.notInstalledOnline', { lang: nativeName })
                    : t('langpanel.fallback', { lang: nativeName })}
                </div>
              ) : null}

              <input
                ref={fileInputRef}
                type="file"
                accept=".wslang"
                className="import-export-file-input"
                onChange={(event) => void handleImportFile(event.target.files?.[0])}
              />
              <div className="import-export-actions">
                {!isEnglish && !populated && status?.wfstatReachable ? (
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={busy !== 'idle'}
                    onClick={() => void handleDownload()}
                  >
                    {busy === 'download' ? t('langpanel.downloading') : t('langpanel.download')}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy !== 'idle'}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {busy === 'import' ? t('langpanel.importing') : t('langpanel.import')}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy !== 'idle' || !canExport}
                  onClick={() => void handleExport()}
                >
                  {busy === 'export' ? t('langpanel.exporting') : t('langpanel.export')}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void openExternalUrl(DISCORD_INVITE)}
                >
                  {t('langpanel.openDiscord')}
                </button>
              </div>
          </div>
        </div>
      </div>
    </>
  );
}
