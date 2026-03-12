import { useCallback, useEffect, useState } from 'react';
import {
  getArbitrageScannerState,
  listenToArbitrageScannerProgress,
  startArbitrageScanner,
  stopArbitrageScanner,
} from '../../lib/tauriClient';
import { formatShortLocalDateTime } from '../../lib/dateTime';
import { useAppStore } from '../../stores/useAppStore';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import type {
  ArbitrageScannerComponentEntry,
  ArbitrageScannerProgress,
  ArbitrageScannerSetEntry,
  ArbitrageScannerResponse,
  WfmAutocompleteItem,
} from '../../types';

type ScannerTab = 'arbitrage' | 'relic-roi';

function formatPlat(value: number | null): string {
  if (value === null) {
    return '—';
  }

  return `${Math.round(value)}p`;
}

function formatPercent(value: number | null): string {
  if (value === null) {
    return '—';
  }

  return `${Math.round(value)}%`;
}

function confidenceTone(level: string): 'green' | 'blue' | 'amber' {
  switch (level) {
    case 'high':
      return 'green';
    case 'medium':
      return 'blue';
    default:
      return 'amber';
  }
}

function getDefaultComponentTarget(component: ArbitrageScannerComponentEntry): string {
  if (
    component.recommendedEntryLow !== null &&
    component.recommendedEntryHigh !== null
  ) {
    return String(
      Math.max(
        1,
        Math.round((component.recommendedEntryLow + component.recommendedEntryHigh) / 2),
      ),
    );
  }

  if (component.recommendedEntryPrice !== null) {
    return String(Math.max(1, Math.round(component.recommendedEntryPrice)));
  }

  if (component.currentStatsPrice !== null) {
    return String(Math.max(1, Math.round(component.currentStatsPrice)));
  }

  return '';
}

function ArbitrageComponentRow({
  component,
  targetValue,
  onTargetChange,
  onAdd,
}: {
  component: ArbitrageScannerComponentEntry;
  targetValue: string;
  onTargetChange: (value: string) => void;
  onAdd: () => void;
}) {
  const imageUrl = resolveWfmAssetUrl(component.imagePath);
  const isDisabled = !component.itemId || !targetValue.trim();

  return (
    <div className="scanner-component-row">
      <div className="scanner-component-main">
        <span className="scanner-component-thumb">
          {imageUrl ? <img src={imageUrl} alt="" loading="lazy" /> : <span>{component.name.slice(0, 1)}</span>}
        </span>
        <div className="scanner-component-copy">
          <div className="scanner-component-name-row">
            <span className="scanner-component-name">
              {component.quantityInSet}x {component.name}
            </span>
            {component.entryAtOrBelowPrice ? (
              <span className="market-panel-badge tone-green">Entry ≤ Price</span>
            ) : null}
            <span className={`market-panel-badge tone-${confidenceTone(component.confidenceSummary.level)}`}>
              {component.confidenceSummary.label}
            </span>
          </div>
          <div className="scanner-component-statline">
            <span>Stats price {formatPlat(component.currentStatsPrice)}</span>
            <span>Recommended entry {formatPlat(component.recommendedEntryPrice)}</span>
            <span>
              Zone {formatPlat(component.recommendedEntryLow)} - {formatPlat(component.recommendedEntryHigh)}
            </span>
          </div>
        </div>
      </div>
      <div className="scanner-component-actions">
        <input
          className="price-input scanner-component-input"
          type="number"
          min="0"
          step="1"
          value={targetValue}
          onChange={(event) => onTargetChange(event.target.value)}
        />
        <button
          className="btn-sm scanner-component-watch-button"
          type="button"
          disabled={isDisabled}
          onClick={onAdd}
        >
          Add to Watchlist
        </button>
      </div>
    </div>
  );
}

function ArbitrageRow({
  entry,
  index,
  expanded,
  onToggle,
  targetInputs,
  onTargetChange,
  onAddToWatchlist,
}: {
  entry: ArbitrageScannerSetEntry;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  targetInputs: Record<string, string>;
  onTargetChange: (component: ArbitrageScannerComponentEntry, value: string) => void;
  onAddToWatchlist: (component: ArbitrageScannerComponentEntry) => void;
}) {
  const imageUrl = resolveWfmAssetUrl(entry.imagePath);

  return (
    <article className={`scanner-list-row${expanded ? ' is-expanded' : ''}`}>
      <button className="scanner-list-button" type="button" onClick={onToggle}>
        <div className="scanner-list-primary">
          <div className="scanner-result-rank">#{index + 1}</div>
          <span className="scanner-result-thumb">
            {imageUrl ? <img src={imageUrl} alt="" loading="lazy" /> : <span>{entry.name.slice(0, 1)}</span>}
          </span>
          <div className="scanner-list-name">
            <span className="panel-title-eyebrow">Statistics Arbitrage</span>
            <strong>{entry.name}</strong>
            <span className="scanner-list-note">{entry.note}</span>
          </div>
        </div>
        <div className="scanner-list-metrics">
          <div className="scanner-list-metric">
            <span>Entry</span>
            <strong>{formatPlat(entry.basketEntryCost)}</strong>
          </div>
          <div className="scanner-list-metric">
            <span>Exit Zone</span>
            <strong>{formatPlat(entry.setExitLow)} - {formatPlat(entry.setExitHigh)}</strong>
          </div>
          <div className="scanner-list-metric">
            <span>Margin</span>
            <strong>{formatPlat(entry.grossMargin)}</strong>
          </div>
          <div className="scanner-list-metric">
            <span>ROI</span>
            <strong>{formatPercent(entry.roiPct)}</strong>
          </div>
          <div className="scanner-list-metric">
            <span>Liquidity</span>
            <strong>{Math.round(entry.liquidityScore)}%</strong>
          </div>
          <div className="scanner-list-badges">
            <span className="market-panel-badge tone-blue">Score {Math.round(entry.arbitrageScore)}</span>
            <span className={`market-panel-badge tone-${confidenceTone(entry.confidenceSummary.level)}`}>
              {entry.confidenceSummary.label}
            </span>
            <span className="scanner-list-chevron">{expanded ? '−' : '+'}</span>
          </div>
        </div>
      </button>

      {expanded ? (
        <div className="scanner-row-body">
          <div className="scanner-row-summary-grid">
            <div className="market-metric-card">
              <span className="info-card-label">Set Exit</span>
              <strong>{formatPlat(entry.recommendedSetExitPrice)}</strong>
            </div>
            <div className="market-metric-card">
              <span className="info-card-label">Liquidity</span>
              <strong>{Math.round(entry.liquidityScore)}%</strong>
            </div>
            <div className="market-metric-card">
              <span className="info-card-label">Confidence</span>
              <strong>{entry.confidenceSummary.label}</strong>
            </div>
            <div className="market-metric-card">
              <span className="info-card-label">Components</span>
              <strong>{entry.componentCount}</strong>
            </div>
          </div>

          <div className="scanner-components-panel">
            <div className="scanner-components-header">
              <span className="card-label">Component Basket</span>
              <span className="scanner-components-meta">{entry.componentCount} components</span>
            </div>
            <div className="scanner-components-list">
              {entry.components.map((component) => (
                <ArbitrageComponentRow
                  key={`${entry.slug}-${component.slug}`}
                  component={component}
                  targetValue={targetInputs[component.slug] ?? getDefaultComponentTarget(component)}
                  onTargetChange={(value) => onTargetChange(component, value)}
                  onAdd={() => onAddToWatchlist(component)}
                />
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </article>
  );
}

export function ScannersPage() {
  const [activeTab, setActiveTab] = useState<ScannerTab>('arbitrage');
  const [arbitrage, setArbitrage] = useState<ArbitrageScannerResponse | null>(null);
  const [progress, setProgress] = useState<ArbitrageScannerProgress | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);
  const [componentTargets, setComponentTargets] = useState<Record<string, string>>({});
  const addExplicitItemToWatchlist = useAppStore((state) => state.addExplicitItemToWatchlist);

  const loadScannerState = useCallback(async (cancelled = false) => {
    try {
      const response = await getArbitrageScannerState();
      if (cancelled) {
        return;
      }
      setArbitrage(response.latestScan);
      setProgress(response.progress);
      setErrorMessage(response.progress.status === 'error' ? response.progress.lastError : null);
    } catch (error) {
      if (cancelled) {
        return;
      }
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    if (activeTab !== 'arbitrage') {
      return;
    }

    let cancelled = false;
    void loadScannerState();

    let unsubscribe: () => void = () => {};
    void listenToArbitrageScannerProgress((nextProgress) => {
      if (cancelled) {
        return;
      }

      setProgress(nextProgress);
      if (nextProgress.status === 'error') {
        setErrorMessage(nextProgress.lastError ?? 'Arbitrage scan failed.');
      } else {
        setErrorMessage(null);
      }

      if (nextProgress.status === 'success' || nextProgress.status === 'error') {
        void loadScannerState();
      }
    }).then((cleanup) => {
      unsubscribe = cleanup;
    });

    const pollInterval = window.setInterval(() => {
      void loadScannerState(cancelled);
    }, 1250);

    return () => {
      cancelled = true;
      window.clearInterval(pollInterval);
      unsubscribe();
    };
  }, [activeTab, loadScannerState]);

  const runArbitrageScan = async () => {
    setErrorMessage(null);
    try {
      const started = await startArbitrageScanner();
      if (started) {
        setProgress((current) => ({
          scannerKey: current?.scannerKey ?? 'arbitrage',
          status: 'running',
          progressValue: 0,
          stageLabel: 'Queued',
          statusText: 'Arbitrage scan queued.',
          updatedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          lastCompletedAt: current?.lastCompletedAt ?? null,
          lastError: null,
        }));
        void loadScannerState();
      } else {
        setProgress((current) =>
          current
            ? {
                ...current,
                statusText: current.status === 'running'
                  ? current.statusText
                  : 'Arbitrage scan is already running.',
              }
            : current,
        );
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const stopArbitrageScan = async () => {
    setErrorMessage(null);
    try {
      const stopped = await stopArbitrageScanner();
      if (stopped) {
        setProgress((current) =>
          current
            ? {
                ...current,
                status: 'running',
                stageLabel: 'Stopping',
                statusText: 'Stopping arbitrage scan…',
                updatedAt: new Date().toISOString(),
              }
            : current,
        );
        void loadScannerState();
      }
      if (!stopped) {
        setProgress((current) =>
          current
            ? {
                ...current,
                statusText: current.statusText || 'No active arbitrage scan to stop.',
              }
            : current,
        );
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const isRunning = progress?.status === 'running';
  const hasSavedScan = Boolean(arbitrage);
  const actionLabel = hasSavedScan ? 'Rescan' : 'Start Scan';

  useEffect(() => {
    if (!arbitrage?.results.length) {
      setExpandedSlug(null);
      return;
    }

    setExpandedSlug((current) =>
      current && arbitrage.results.some((entry) => entry.slug === current)
        ? current
        : arbitrage.results[0]?.slug ?? null,
    );
  }, [arbitrage]);

  const updateComponentTarget = (
    component: ArbitrageScannerComponentEntry,
    value: string,
  ) => {
    setComponentTargets((current) => ({
      ...current,
      [component.slug]: value,
    }));
  };

  const addComponentToWatchlist = (component: ArbitrageScannerComponentEntry) => {
    if (component.itemId === null) {
      return;
    }

    const rawTarget = componentTargets[component.slug] ?? getDefaultComponentTarget(component);
    const targetPrice = Number.parseInt(rawTarget || '0', 10);
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
      return;
    }

    const item: WfmAutocompleteItem = {
      itemId: component.itemId,
      name: component.name,
      slug: component.slug,
      maxRank: null,
      itemFamily: null,
      imagePath: component.imagePath,
    };

    addExplicitItemToWatchlist(item, 'base', 'Base Market', targetPrice);
  };

  return (
    <>
      <div className="subnav">
        <div className="subnav-left">
          <span className="page-title">Scanners</span>
          <span
            className={`subtab${activeTab === 'arbitrage' ? ' active' : ''}`}
            onClick={() => setActiveTab('arbitrage')}
            role="tab"
            tabIndex={0}
          >
            Arbitrage
          </span>
          <span
            className={`subtab${activeTab === 'relic-roi' ? ' active' : ''}`}
            onClick={() => setActiveTab('relic-roi')}
            role="tab"
            tabIndex={0}
          >
            Relic ROI
          </span>
        </div>
        {activeTab === 'arbitrage' ? (
          <div className="subnav-right">
            <button
              className="market-refresh-button"
              type="button"
              onClick={() => {
                if (isRunning) {
                  void stopArbitrageScan();
                  return;
                }
                void runArbitrageScan();
              }}
            >
              {isRunning ? 'Stop Scan' : actionLabel}
            </button>
          </div>
        ) : null}
      </div>

      <div className="page-content scanners-page-content">
        {activeTab === 'relic-roi' ? (
          <div className="scanners-empty-state">
            Relic ROI is not implemented yet.
          </div>
        ) : (
          <div className="scanners-shell">
            <div className="scanners-summary-grid">
              <div className="market-panel">
                <div className="market-panel-body">
                  <span className="info-card-label">Scanned Sets</span>
                  <strong>{arbitrage?.scannedSetCount ?? '—'}</strong>
                </div>
              </div>
              <div className="market-panel">
                <div className="market-panel-body">
                  <span className="info-card-label">Positive Opportunities</span>
                  <strong>{arbitrage?.opportunityCount ?? '—'}</strong>
                </div>
              </div>
              <div className="market-panel">
                <div className="market-panel-body">
                  <span className="info-card-label">Set Maps Refreshed</span>
                  <strong>{arbitrage?.refreshedSetCount ?? '—'}</strong>
                </div>
              </div>
              <div className="market-panel">
                <div className="market-panel-body">
                  <span className="info-card-label">Statistics Refreshed</span>
                  <strong>{arbitrage?.refreshedStatisticsCount ?? '—'}</strong>
                </div>
              </div>
            </div>

            <div className="market-panel scanners-intro-panel">
              <div className="market-panel-header">
                <div className="market-panel-header-copy">
                  <span className="panel-title-eyebrow">Scanner Logic</span>
                  <h3>Statistics-only set arbitrage</h3>
                  <p>
                    Basket costs use component entry bands with quantity in set. Set exits use conservative
                    achieved-price zones. No live orderbook requests are used in the scan.
                  </p>
                </div>
                {progress ? (
                  <div className="market-panel-header-aside">
                    <span className="market-panel-badge tone-neutral">
                      {progress.status === 'running'
                        ? `${progress.stageLabel} · ${Math.round(progress.progressValue)}%`
                        : progress.lastCompletedAt
                          ? `Updated ${formatShortLocalDateTime(progress.lastCompletedAt)}`
                          : 'No saved scan'}
                    </span>
                  </div>
                ) : null}
              </div>
              <div className="scanner-progress-block">
                <div className="scanner-progress-meta">
                  <span>{progress?.stageLabel ?? 'Ready'}</span>
                  <span>{Math.round(progress?.progressValue ?? 0)}%</span>
                </div>
                <div className="scanner-progress-track">
                  <div
                    className="scanner-progress-fill"
                    style={{ width: `${Math.max(0, Math.min(100, progress?.progressValue ?? 0))}%` }}
                  />
                </div>
                <p className="scanner-progress-copy">
                  {progress?.statusText ?? 'No saved arbitrage scan yet. Start a scan to cache the results.'}
                </p>
                {errorMessage ? (
                  <div className="scanner-inline-error" role="alert">
                    <strong>Arbitrage scan failed</strong>
                    <span>{errorMessage}</span>
                  </div>
                ) : null}
              </div>
            </div>

            {arbitrage ? (
              <div className="scanner-results-list">
                {arbitrage.results.map((entry, index) => (
                  <ArbitrageRow
                    key={entry.slug}
                    entry={entry}
                    index={index}
                    expanded={expandedSlug === entry.slug}
                    onToggle={() =>
                      setExpandedSlug((current) => (current === entry.slug ? null : entry.slug))
                    }
                    targetInputs={componentTargets}
                    onTargetChange={updateComponentTarget}
                    onAddToWatchlist={addComponentToWatchlist}
                  />
                ))}
              </div>
            ) : !isRunning ? (
              <div className="scanners-empty-state">
                No cached arbitrage scan yet. Start a scan to build and save the first result set.
              </div>
            ) : null}
          </div>
        )}
      </div>
    </>
  );
}
