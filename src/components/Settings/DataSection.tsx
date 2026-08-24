/**
 * Export and import of the two databases.
 *
 * The one genuinely destructive surface in the app: an import **replaces** the user's data and
 * then reloads the window. Everything here is shaped around making that impossible to do by
 * accident — pick a file, see what is in it, then confirm with a `destructive` button that names
 * what it is about to overwrite.
 */
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useTranslation } from '../../i18n';
import type { TranslationKey } from '../../i18n/en';
import {
  applyPendingImport,
  exportMarketDataFile,
  exportUserDataFile,
  pickImportFile,
  type PendingImport,
} from '../../lib/dataTransfer';
import type { TransferSummary } from '../../lib/tauriClient';
import { useAppStore } from '../../stores/useAppStore';
import { Note, SettingGroup } from './parts';

// `message` is a raw string (e.g. an exception message); `messageKey` is a translation key.
// Exactly one is set. Raw errors from the backend stay untranslated by design.
type Status =
  | { tone: 'success' | 'error' | 'info'; messageKey: TranslationKey; summary?: TransferSummary }
  | { tone: 'success' | 'error' | 'info'; message: string }
  | null;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A row-count breakdown so the user can actually confirm an export/import did what they
 *  expected, instead of trusting a bare "success" message. */
function TransferSummaryTable({ summary }: { summary: TransferSummary }) {
  const nonEmptyTables = summary.tables.filter((entry) => entry.rowCount > 0);
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <div className="flex items-center gap-3 font-mono text-[10px] tabular-nums text-ink-dim">
        <span>{summary.totalRows.toLocaleString()} rows</span>
        <span>{formatFileSize(summary.fileSizeBytes)}</span>
      </div>
      {nonEmptyTables.length > 0 ? (
        <ul className="max-h-40 overflow-y-auto rounded-sm bg-bg-base/60 p-1.5">
          {nonEmptyTables.map((entry) => (
            <li
              key={entry.table}
              className="flex items-baseline justify-between gap-3 px-1 py-0.5 font-mono text-[10px]"
            >
              <span className="truncate text-ink-dim">{entry.table}</span>
              <span className="shrink-0 tabular-nums text-ink">
                {entry.rowCount.toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function DataSection() {
  const setDataMaintenanceActive = useAppStore((state) => state.setDataMaintenanceActive);
  const { t } = useTranslation();

  const [busy, setBusy] = useState(false);
  const [progressLabel, setProgressLabel] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(null);
  // A file awaiting the user's "this will overwrite" confirmation.
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);

  const runExport = async (which: 'user' | 'market') => {
    setBusy(true);
    setStatus(null);
    setProgressLabel(t('ie.progress.starting'));
    setDataMaintenanceActive(true);
    try {
      const summary =
        which === 'user'
          ? await exportUserDataFile(setProgressLabel)
          : await exportMarketDataFile(setProgressLabel);
      if (summary) {
        setStatus({
          tone: 'success',
          messageKey: which === 'user' ? 'ie.status.exportedUser' : 'ie.status.exportedMarket',
          summary,
        });
      }
    } catch (error) {
      setStatus({ tone: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
      setProgressLabel(null);
      setDataMaintenanceActive(false);
    }
  };

  const handleChooseFile = async () => {
    setBusy(true);
    setStatus(null);
    setProgressLabel(t('ie.progress.reading'));
    try {
      const picked = await pickImportFile();
      if (picked) {
        setPendingImport(picked);
        setStatus({
          tone: 'info',
          messageKey: picked.kind === 'user' ? 'ie.status.readyUser' : 'ie.status.readyMarket',
        });
      }
    } catch (error) {
      setStatus({ tone: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
      setProgressLabel(null);
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
      const summary = await applyPendingImport(pendingImport, setProgressLabel);
      setPendingImport(null);
      setProgressLabel(t('ie.progress.done'));
      setStatus({ tone: 'success', messageKey: 'ie.status.importComplete', summary });
      // Reload so the in-memory store and backend-fed views reflect the restored data
      // (a brief delay lets the success message render first).
      window.setTimeout(() => window.location.reload(), 1800);
    } catch (error) {
      setStatus({ tone: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
      setProgressLabel(null);
      setDataMaintenanceActive(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <SettingGroup title={t('ie.export')} description={t('ie.export.help')}>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void runExport('user')}>
            <i className="ti ti-database" aria-hidden="true" />
            {t('ie.export.userBtn')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void runExport('market')}
          >
            <i className="ti ti-chart-line" aria-hidden="true" />
            {t('ie.export.marketBtn')}
          </Button>
        </div>
      </SettingGroup>

      <SettingGroup title={t('ie.import')} description={t('ie.import.help')}>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void handleChooseFile()}>
            {t('ie.import.chooseBtn')}
          </Button>
          {pendingImport ? (
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => void confirmImport()}
            >
              {busy
                ? t('ie.importing')
                : t(
                    pendingImport.kind === 'user'
                      ? 'ie.import.replaceUser'
                      : 'ie.import.replaceMarket',
                  )}
            </Button>
          ) : null}
        </div>
        {pendingImport?.exportedAt ? (
          <Note tone="info">
            {t('ie.import.exportedOn')} {new Date(pendingImport.exportedAt).toLocaleString()}
            {pendingImport.appVersion ? ` · WarStonks v${pendingImport.appVersion}` : ''}
          </Note>
        ) : null}
      </SettingGroup>

      {busy ? (
        <div className="flex flex-col gap-2" role="status" aria-live="polite">
          {/* An indeterminate bar, not a skeleton: the shape of what is coming back is unknown,
              and this is a user-initiated operation rather than a load. */}
          <span className="h-1 overflow-hidden rounded-full bg-bg-base">
            <span className="block h-full w-1/3 animate-[ws-indeterminate_1.4s_ease-in-out_infinite] rounded-full bg-accent-blue" />
          </span>
          <span className="font-mono text-[10px] tracking-[0.04em] text-ink-dim">
            {progressLabel ?? t('ie.progress.working')}
          </span>
        </div>
      ) : null}

      {!busy && status ? (
        <Note tone={status.tone === 'info' ? 'info' : status.tone}>
          <span className="flex flex-col">
            {'messageKey' in status ? t(status.messageKey) : status.message}
            {'summary' in status && status.summary ? (
              <TransferSummaryTable summary={status.summary} />
            ) : null}
          </span>
        </Note>
      ) : null}
    </div>
  );
}
