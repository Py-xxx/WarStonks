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

export function StartupScreen({
  progress,
  summary,
  errorMessage,
  onRetry,
}: StartupScreenProps) {
  const progressPercent = Math.max(0, Math.min(progress.progressValue, 1)) * 100;
  const stats = summary?.stats;

  return (
    <div className="startup-shell">
      <div className="startup-panel">
        <div className="startup-header">
          <div>
            <p className="startup-eyebrow">Catalog Bootstrap</p>
            <h1>WarStonks</h1>
          </div>
          <div className="startup-progress-chip">{formatPercent(progress.progressValue)}</div>
        </div>

        <div className="startup-stage-card">
          <div className="startup-stage-meta">
            <span className="startup-stage-label">{progress.stageLabel}</span>
            <span className="startup-stage-key">{progress.stageKey}</span>
          </div>
          <p className="startup-status-text">{errorMessage ?? progress.statusText}</p>
          <div className="startup-progress-track" aria-hidden="true">
            <div className="startup-progress-fill" style={{ width: `${progressPercent}%` }} />
          </div>
        </div>

        <div className="startup-grid">
          <div className="startup-info-card">
            <span className="startup-info-label">Database</span>
            <span className="startup-info-value">
              {summary?.databasePath ?? 'Preparing SQLite catalog'}
            </span>
          </div>
          <div className="startup-info-card">
            <span className="startup-info-label">WFM Version</span>
            <span className="startup-info-value">
              {summary?.currentWfmApiVersion ?? 'Checking source version'}
            </span>
          </div>
          <div className="startup-info-card">
            <span className="startup-info-label">WFM Items</span>
            <span className="startup-info-value">
              {stats ? stats.totalWfmItems.toLocaleString() : 'Fetching'}
            </span>
          </div>
          <div className="startup-info-card">
            <span className="startup-info-label">WFStat Items</span>
            <span className="startup-info-value">
              {stats ? stats.totalWfstatItems.toLocaleString() : 'Waiting'}
            </span>
          </div>
        </div>

        {errorMessage ? (
          <div className="startup-error-card" role="alert">
            <p className="startup-error-title">Startup import failed</p>
            <p className="startup-error-body">{errorMessage}</p>
            <button className="startup-retry-button" onClick={onRetry} type="button">
              Retry initialization
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
