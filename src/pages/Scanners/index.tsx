import { useEffect, useState } from 'react';
import { getArbitrageScanner } from '../../lib/tauriClient';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import type {
  ArbitrageScannerComponentEntry,
  ArbitrageScannerResponse,
  ArbitrageScannerSetEntry,
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

function ArbitrageComponentRow({ component }: { component: ArbitrageScannerComponentEntry }) {
  const imageUrl = resolveWfmAssetUrl(component.imagePath);

  return (
    <div className="scanner-component-row">
      <div className="scanner-component-main">
        <span className="scanner-component-thumb">
          {imageUrl ? <img src={imageUrl} alt="" loading="lazy" /> : <span>{component.name.slice(0, 1)}</span>}
        </span>
        <div className="scanner-component-copy">
          <div className="scanner-component-name-row">
            <span className="scanner-component-name">{component.quantityInSet}x {component.name}</span>
            {component.entryAtOrBelowPrice ? (
              <span className="market-panel-badge tone-green">Entry ≤ Price</span>
            ) : null}
          </div>
          <span className="scanner-component-meta">
            Entry {formatPlat(component.recommendedEntryPrice)}
            {' · '}
            Zone {formatPlat(component.recommendedEntryLow)} - {formatPlat(component.recommendedEntryHigh)}
            {' · '}
            Stats price {formatPlat(component.currentStatsPrice)}
          </span>
        </div>
      </div>
      <div className="scanner-component-aside">
        <span className={`market-panel-badge tone-${confidenceTone(component.confidenceSummary.level)}`}>
          {component.confidenceSummary.label}
        </span>
      </div>
    </div>
  );
}

function ArbitrageCard({ entry, index }: { entry: ArbitrageScannerSetEntry; index: number }) {
  const imageUrl = resolveWfmAssetUrl(entry.imagePath);

  return (
    <article className="market-panel scanner-result-card">
      <div className="market-panel-header">
        <div className="market-panel-header-copy scanner-result-header">
          <div className="scanner-result-rank">#{index + 1}</div>
          <span className="scanner-result-thumb">
            {imageUrl ? <img src={imageUrl} alt="" loading="lazy" /> : <span>{entry.name.slice(0, 1)}</span>}
          </span>
          <div>
            <div className="panel-title-row">
              <span className="panel-title-eyebrow">Statistics Arbitrage</span>
            </div>
            <h3>{entry.name}</h3>
            <p>{entry.note}</p>
          </div>
        </div>
        <div className="market-panel-header-aside scanner-result-badges">
          <span className="market-panel-badge tone-blue">Score {Math.round(entry.arbitrageScore)}</span>
          <span className={`market-panel-badge tone-${confidenceTone(entry.confidenceSummary.level)}`}>
            {entry.confidenceSummary.label}
          </span>
        </div>
      </div>

      <div className="market-panel-body scanner-result-body">
        <div className="scanner-metric-grid">
          <div className="market-metric-card">
            <span className="info-card-label">Basket Entry</span>
            <strong>{formatPlat(entry.basketEntryCost)}</strong>
          </div>
          <div className="market-metric-card">
            <span className="info-card-label">Set Exit</span>
            <strong>{formatPlat(entry.recommendedSetExitPrice)}</strong>
          </div>
          <div className="market-metric-card">
            <span className="info-card-label">Gross Margin</span>
            <strong>{formatPlat(entry.grossMargin)}</strong>
          </div>
          <div className="market-metric-card">
            <span className="info-card-label">ROI</span>
            <strong>{formatPercent(entry.roiPct)}</strong>
          </div>
          <div className="market-metric-card">
            <span className="info-card-label">Liquidity</span>
            <strong>{Math.round(entry.liquidityScore)}%</strong>
          </div>
          <div className="market-metric-card">
            <span className="info-card-label">Set Exit Zone</span>
            <strong>{formatPlat(entry.setExitLow)} - {formatPlat(entry.setExitHigh)}</strong>
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
              />
            ))}
          </div>
        </div>
      </div>
    </article>
  );
}

export function ScannersPage() {
  const [activeTab, setActiveTab] = useState<ScannerTab>('arbitrage');
  const [arbitrage, setArbitrage] = useState<ArbitrageScannerResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (activeTab !== 'arbitrage') {
      return;
    }

    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setErrorMessage(null);

      try {
        const response = await getArbitrageScanner();
        if (cancelled) {
          return;
        }
        setArbitrage(response);
      } catch (error) {
        if (cancelled) {
          return;
        }
        setErrorMessage(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [activeTab]);

  const refreshArbitrage = async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      setArbitrage(await getArbitrageScanner());
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
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
                void refreshArbitrage();
              }}
              disabled={loading}
            >
              Refresh
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
                {arbitrage ? (
                  <div className="market-panel-header-aside">
                    <span className="market-panel-badge tone-neutral">
                      Updated {new Date(arbitrage.computedAt).toLocaleString()}
                    </span>
                  </div>
                ) : null}
              </div>
              {loading ? (
                <div className="market-panel-overlay">
                  <div className="market-panel-spinner" />
                  <div className="market-panel-overlay-copy">
                    <strong>Running arbitrage scan</strong>
                    <span>Refreshing cached set maps and statistics, then scoring all sets.</span>
                  </div>
                </div>
              ) : null}
            </div>

            {errorMessage ? (
              <div className="market-panel">
                <div className="market-panel-overlay is-error">
                  <div className="market-panel-overlay-copy">
                    <strong>Arbitrage scan failed</strong>
                    <span>{errorMessage}</span>
                  </div>
                </div>
              </div>
            ) : null}

            {!errorMessage && arbitrage ? (
              <div className="scanner-results-list">
                {arbitrage.results.map((entry, index) => (
                  <ArbitrageCard key={entry.slug} entry={entry} index={index} />
                ))}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </>
  );
}
