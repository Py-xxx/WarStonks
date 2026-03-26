import type { StartupProgress, StartupSummary } from '../../lib/tauriClient';

interface StartupScreenProps {
  progress: StartupProgress;
  summary: StartupSummary | null;
  errorMessage: string | null;
  onRetry: () => void;
}

function formatPercent(progressValue: number): string {
  return `${Math.round(Math.max(0, Math.min(progressValue, 1)) * 100)}%`;
}

function formatStartupStatusText(progress: StartupProgress): string {
  const trimmed = progress.statusText.trim();
  if (!trimmed) {
    return 'Getting everything ready for launch.';
  }

  return trimmed
    .replace(/catalog initialization is complete\./i, '')
    .replace(/loading \d+ worldstate feeds before entering the app\./i, 'Refreshing live event data before launch.')
    .replace(/checking saved warframe market session and credentials\./i, 'Checking your trading session.')
    .replace(/building the cached set component map for trade reconciliation\./i, 'Preparing planning data.')
    .replace(/connecting startup progress and invoking the desktop initializer\./i, 'Starting the app.')
    .trim() || 'Getting everything ready for launch.';
}

function formatStartupErrorMessage(errorMessage: string): string {
  const normalized = errorMessage.trim();
  if (!normalized) {
    return 'WarStonks could not finish starting up. Please try again.';
  }

  if (/session expired/i.test(normalized)) {
    return 'WarStonks could not restore your Warframe Market session. Please retry, then sign in again if needed.';
  }
  if (/network|timed out|timeout|fetch/i.test(normalized)) {
    return 'WarStonks could not finish loading online data. Check your connection and try again. If it keeps happening, report it in Discord.';
  }
  if (/database|sqlite|catalog/i.test(normalized)) {
    return 'WarStonks could not finish preparing its local data. Please retry startup. If it keeps happening, restart the app and report it in Discord.';
  }

  return 'WarStonks could not finish starting up. Please retry. If it keeps happening, restart the app and report it in Discord.';
}

export function StartupScreen({
  progress,
  summary,
  errorMessage,
  onRetry,
}: StartupScreenProps) {
  const progressPercent = Math.max(0, Math.min(progress.progressValue, 1)) * 100;
  const stats = summary?.stats;
  const friendlyStatusText = formatStartupStatusText(progress);
  const friendlyErrorMessage = errorMessage ? formatStartupErrorMessage(errorMessage) : null;
  const indexedItemsCount = stats
    ? (stats.totalWfmItems + stats.totalWfstatItems).toLocaleString()
    : 'Preparing';

  return (
    <div className="startup-shell">
      <div className="startup-panel">
        <div className="startup-header">
          <div className="startup-header-copy">
            <p className="startup-eyebrow">Starting Up</p>
            <h1 className="startup-title">Getting WarStonks ready</h1>
            <p className="startup-subtitle">
              Loading your market tools, local data, and live signals.
            </p>
          </div>
          <div className="startup-progress-chip">{formatPercent(progress.progressValue)}</div>
        </div>

        <div className="startup-stage-card">
          <div className="startup-stage-meta">
            <span className="startup-stage-label">{progress.stageLabel}</span>
            <span className="startup-stage-state">In progress</span>
          </div>
          <p className="startup-status-text">{friendlyErrorMessage ?? friendlyStatusText}</p>
          <div className="startup-progress-track" aria-hidden="true">
            <div className="startup-progress-fill" style={{ width: `${progressPercent}%` }} />
          </div>
        </div>

        <div className="startup-grid">
          <div className="startup-info-card">
            <span className="startup-info-label">Catalog</span>
            <span className="startup-info-value">
              {summary ? 'Local market database ready' : 'Preparing local market data'}
            </span>
          </div>
          <div className="startup-info-card">
            <span className="startup-info-label">Live Data</span>
            <span className="startup-info-value">
              {summary?.currentWfmApiVersion ? `WFM ${summary.currentWfmApiVersion}` : 'Checking live sources'}
            </span>
          </div>
          <div className="startup-info-card">
            <span className="startup-info-label">Items Indexed</span>
            <span className="startup-info-value">
              {indexedItemsCount}
            </span>
          </div>
          <div className="startup-info-card">
            <span className="startup-info-label">Ready For</span>
            <span className="startup-info-value">
              Analysis, scanners, watchlists, and events
            </span>
          </div>
        </div>

        {errorMessage ? (
          <div className="startup-error-card" role="alert">
            <p className="startup-error-title">Startup needs another try</p>
            <p className="startup-error-body">{friendlyErrorMessage}</p>
            <button className="startup-retry-button" onClick={onRetry} type="button">
              Retry startup
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
