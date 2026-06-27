import { useRef, useState } from 'react';
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

type Status = { tone: 'success' | 'error' | 'info'; message: string } | null;

function describeKind(kind: BaddieKind): string {
  return kind === 'user' ? 'app data (inventory, watchlist, trades, settings)' : 'market data (saved snapshots)';
}

export function ImportExportModal() {
  const modalOpen = useAppStore((state) => state.importExportModalOpen);
  const closeModal = useAppStore((state) => state.closeImportExportModal);
  const setDataMaintenanceActive = useAppStore((state) => state.setDataMaintenanceActive);
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
    setProgressLabel('Starting…');
    setDataMaintenanceActive(true);
    try {
      if (which === 'user') {
        await exportUserData(setProgressLabel);
        setStatus({ tone: 'success', message: 'Exported your app data to a .baddie file.' });
      } else {
        await exportMarketData(setProgressLabel);
        setStatus({ tone: 'success', message: 'Exported your market data to a .baddie file.' });
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
    setProgressLabel('Reading file…');
    try {
      const bundle = await readBaddieFile(file);
      setPendingImport({ kind: bundle.kind, bundle });
      setStatus({
        tone: 'info',
        message: `Ready to import ${describeKind(bundle.kind)}. This will replace your current ${
          bundle.kind === 'user' ? 'app data' : 'market data'
        }.`,
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
    setProgressLabel('Starting…');
    setDataMaintenanceActive(true);
    try {
      await applyBaddieBundle(pendingImport.bundle, setProgressLabel);
      setPendingImport(null);
      setProgressLabel('Done — reloading…');
      setStatus({
        tone: 'success',
        message: 'Import complete. Reloading WarStonks to apply your restored data…',
      });
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
        aria-label="Close import and export"
        onClick={closeModal}
      />
      <div ref={modalRef} className="settings-modal" role="dialog" aria-modal="true" aria-label="Import and export">
        <div className="settings-modal-header">
          <div className="settings-modal-title">
            <span className="card-label">Import &amp; Export</span>
            <h3>Back up &amp; restore your data</h3>
          </div>
          <button className="settings-close-btn" type="button" aria-label="Close" onClick={closeModal}>
            <CloseIcon />
          </button>
        </div>

        <div className="settings-modal-body">
          <div className="settings-form-card">
            <span className="settings-field-label">Export</span>
            <span className="settings-field-help">
              Saves a <code>.baddie</code> file. App data (inventory, watchlist, accepted
              opportunities, trade log, settings) and market snapshots are separate files — the
              market file is large. Your Discord webhook URL and Alecaframe link are never included.
            </span>
            <div className="import-export-actions">
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() => void runExport('user')}
              >
                Export App Data
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() => void runExport('market')}
              >
                Export Market Data
              </button>
            </div>
          </div>

          <div className="settings-form-card">
            <span className="settings-field-label">Import</span>
            <span className="settings-field-help">
              Loading a file <strong>replaces</strong> the matching data. The file type (app vs
              market) is detected automatically.
            </span>
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
                Choose .baddie File…
              </button>
              {pendingImport ? (
                <button
                  type="button"
                  className="btn-primary danger"
                  disabled={busy}
                  onClick={() => void confirmImport()}
                >
                  {busy ? 'Importing…' : `Replace ${pendingImport.kind === 'user' ? 'App' : 'Market'} Data`}
                </button>
              ) : null}
            </div>
          </div>

          {busy ? (
            <div className="import-export-progress" role="status" aria-live="polite">
              <div className="import-export-progress-track">
                <div className="import-export-progress-bar" />
              </div>
              <span className="import-export-progress-label">{progressLabel ?? 'Working…'}</span>
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
              {status.message}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
