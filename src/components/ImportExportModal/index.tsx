import { useRef, useState } from 'react';
import { useTranslation } from '../../i18n';
import type { TranslationKey } from '../../i18n/en';
import { useAppStore } from '../../stores/useAppStore';
import { useModalA11y } from '../../hooks/useModalA11y';
import {
  applyBaddieBundle,
  exportMarketData,
  exportUserData,
  readBaddieFile,
  type BaddieBundle,
  type BaddieKind,
} from '../../lib/dataTransfer';

const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);

// `message` is a raw string (e.g. an exception message); `messageKey` is a translation key.
// Exactly one is set. Raw errors from the backend stay untranslated by design.
type Status =
  | { tone: 'success' | 'error' | 'info'; messageKey: TranslationKey }
  | { tone: 'success' | 'error' | 'info'; message: string }
  | null;

export function ImportExportModal() {
  const modalOpen = useAppStore((state) => state.importExportModalOpen);
  const closeModal = useAppStore((state) => state.closeImportExportModal);
  const setDataMaintenanceActive = useAppStore((state) => state.setDataMaintenanceActive);
  const { t } = useTranslation();
  const modalRef = useModalA11y<HTMLDivElement>({ onClose: closeModal, active: modalOpen });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [busy, setBusy] = useState(false);
  const [progressLabel, setProgressLabel] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(null);
  // A bundle awaiting the user's "this will overwrite" confirmation.
  const [pendingImport, setPendingImport] = useState<{ kind: BaddieKind; bundle: BaddieBundle } | null>(
    null,
  );

  if (!modalOpen) {
    return null;
  }

  const runExport = async (which: 'user' | 'market') => {
    setBusy(true);
    setStatus(null);
    setProgressLabel(t('ie.progress.starting'));
    setDataMaintenanceActive(true);
    try {
      if (which === 'user') {
        await exportUserData(setProgressLabel);
        setStatus({ tone: 'success', messageKey: 'ie.status.exportedUser' });
      } else {
        await exportMarketData(setProgressLabel);
        setStatus({ tone: 'success', messageKey: 'ie.status.exportedMarket' });
      }
    } catch (error) {
      setStatus({ tone: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
      setProgressLabel(null);
      setDataMaintenanceActive(false);
    }
  };

  const handleFilePicked = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    setBusy(true);
    setStatus(null);
    setProgressLabel(t('ie.progress.reading'));
    try {
      const bundle = await readBaddieFile(file);
      setPendingImport({ kind: bundle.kind, bundle });
      setStatus({
        tone: 'info',
        messageKey: bundle.kind === 'user' ? 'ie.status.readyUser' : 'ie.status.readyMarket',
      });
    } catch (error) {
      setStatus({ tone: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
      setProgressLabel(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const confirmImport = async () => {
    if (!pendingImport) {
      return;
    }
    setBusy(true);
    setStatus(null);
    setProgressLabel(t('ie.progress.starting'));
    setDataMaintenanceActive(true);
    try {
      await applyBaddieBundle(pendingImport.bundle, setProgressLabel);
      setPendingImport(null);
      setProgressLabel(t('ie.progress.done'));
      setStatus({ tone: 'success', messageKey: 'ie.status.importComplete' });
      // Reload so the in-memory store and backend-fed views reflect the restored data
      // (a brief delay lets the success message render first).
      window.setTimeout(() => window.location.reload(), 1200);
    } catch (error) {
      setStatus({ tone: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
      setProgressLabel(null);
      setDataMaintenanceActive(false);
    }
  };

  return (
    <>
      <button
        className="modal-backdrop"
        type="button"
        aria-label={t('ie.close')}
        onClick={closeModal}
      />
      <div ref={modalRef} className="settings-modal" role="dialog" aria-modal="true" aria-label={t('settings.section.importExport.label')}>
        <div className="settings-modal-header">
          <div className="settings-modal-title">
            <span className="card-label">{t('settings.section.importExport.label')}</span>
            <h3>{t('ie.subtitle')}</h3>
          </div>
          <button className="settings-close-btn" type="button" aria-label={t('common.close')} onClick={closeModal}>
            <CloseIcon />
          </button>
        </div>

        <div className="settings-modal-body">
          <div className="settings-form-card">
            <span className="settings-field-label">{t('ie.export')}</span>
            <span className="settings-field-help">{t('ie.export.help')}</span>
            <div className="import-export-actions">
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() => void runExport('user')}
              >
                {t('ie.export.userBtn')}
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() => void runExport('market')}
              >
                {t('ie.export.marketBtn')}
              </button>
            </div>
          </div>

          <div className="settings-form-card">
            <span className="settings-field-label">{t('ie.import')}</span>
            <span className="settings-field-help">{t('ie.import.help')}</span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".baddie"
              className="import-export-file-input"
              onChange={(event) => void handleFilePicked(event.target.files?.[0])}
            />
            <div className="import-export-actions">
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
              >
                {t('ie.import.chooseBtn')}
              </button>
              {pendingImport ? (
                <button
                  type="button"
                  className="btn-primary danger"
                  disabled={busy}
                  onClick={() => void confirmImport()}
                >
                  {busy
                    ? t('ie.importing')
                    : t(pendingImport.kind === 'user' ? 'ie.import.replaceUser' : 'ie.import.replaceMarket')}
                </button>
              ) : null}
            </div>
          </div>

          {busy ? (
            <div className="import-export-progress" role="status" aria-live="polite">
              <div className="import-export-progress-track">
                <div className="import-export-progress-bar" />
              </div>
              <span className="import-export-progress-label">{progressLabel ?? t('ie.progress.working')}</span>
            </div>
          ) : null}

          {!busy && status ? (
            <div
              className={
                status.tone === 'success'
                  ? 'settings-inline-success'
                  : status.tone === 'error'
                    ? 'settings-inline-error'
                    : 'settings-inline-warning'
              }
            >
              {'messageKey' in status ? t(status.messageKey) : status.message}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
