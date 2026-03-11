import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ensureMarketTracking, getItemAnalytics, stopMarketTracking } from '../../lib/tauriClient';
import { useAppStore } from '../../stores/useAppStore';
import type {
  AnalyticsBucketSizeKey,
  AnalyticsDomainKey,
  ItemAnalyticsResponse,
} from '../../types';

const DEFAULT_ANALYTICS_DOMAIN_KEY: AnalyticsDomainKey = '30d';
const DEFAULT_ANALYTICS_BUCKET_SIZE_KEY: AnalyticsBucketSizeKey = '24h';

function formatNumber(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }

  return Number.isInteger(value) ? `${value}` : value.toFixed(digits);
}

function formatPrice(value: number | null | undefined): string {
  const rendered = formatNumber(value, 1);
  return rendered === '—' ? rendered : `${rendered} pt`;
}

function formatPercent(value: number | null | undefined): string {
  const rendered = formatNumber(value, 1);
  return rendered === '—' ? rendered : `${rendered}%`;
}

function formatRelativeTimestamp(value: string | null | undefined): string {
  if (!value) {
    return '—';
  }

  const deltaMs = Date.now() - new Date(value).getTime();
  if (Number.isNaN(deltaMs)) {
    return value;
  }

  const seconds = Math.max(0, Math.floor(deltaMs / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

function EmptyAnalyticsState({ body }: { body: string }) {
  return (
    <div className="market-empty-state">
      <span className="empty-primary">Analytics is ready when the market selection is ready</span>
      <span className="empty-sub">{body}</span>
    </div>
  );
}

function AnalyticsPanel({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow: string;
  children: ReactNode;
}) {
  return (
    <div className="card market-panel">
      <div className="card-header">
        <div className="market-panel-header">
          <span className="panel-title-eyebrow">{eyebrow}</span>
          <span className="card-label">{title}</span>
        </div>
      </div>
      <div className="card-body">{children}</div>
    </div>
  );
}

function AnalyticsTab() {
  const pageContentRef = useRef<HTMLDivElement | null>(null);
  const selectedItem = useAppStore((state) => state.quickView.selectedItem);
  const marketVariants = useAppStore((state) => state.marketVariants);
  const marketVariantsLoading = useAppStore((state) => state.marketVariantsLoading);
  const marketVariantsError = useAppStore((state) => state.marketVariantsError);
  const selectedMarketVariantKey = useAppStore((state) => state.selectedMarketVariantKey);
  const setSelectedMarketVariantKey = useAppStore((state) => state.setSelectedMarketVariantKey);
  const [analytics, setAnalytics] = useState<ItemAnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [trendTab, setTrendTab] = useState<'lowestSell' | 'medianSell' | 'weightedAvg'>('lowestSell');

  useEffect(() => {
    pageContentRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [selectedItem?.itemId, selectedMarketVariantKey]);

  useEffect(() => {
    if (loading) {
      return;
    }

    if (analytics || errorMessage) {
      pageContentRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    }
  }, [analytics, errorMessage, loading]);

  useEffect(() => {
    if (!selectedItem || !selectedMarketVariantKey) {
      setAnalytics(null);
      setLoading(false);
      setErrorMessage(null);
      return;
    }

    let isMounted = true;
    setLoading(true);
    setErrorMessage(null);

    void ensureMarketTracking(
      selectedItem.itemId,
      selectedItem.slug,
      selectedMarketVariantKey,
      'analytics',
    )
      .then(() =>
        getItemAnalytics(
          selectedItem.itemId,
          selectedItem.slug,
          selectedMarketVariantKey,
          DEFAULT_ANALYTICS_DOMAIN_KEY,
          DEFAULT_ANALYTICS_BUCKET_SIZE_KEY,
        ),
      )
      .then((response) => {
        if (!isMounted) {
          return;
        }
        setAnalytics(response);
        setLoading(false);
        setErrorMessage(null);
      })
      .catch((error) => {
        if (!isMounted) {
          return;
        }
        setAnalytics(null);
        setLoading(false);
        setErrorMessage(error instanceof Error ? error.message : String(error));
      });

    return () => {
      isMounted = false;
      void stopMarketTracking(
        selectedItem.itemId,
        selectedItem.slug,
        selectedMarketVariantKey,
        'analytics',
      ).catch(() => undefined);
    };
  }, [selectedItem, selectedMarketVariantKey, refreshNonce]);

  const trendMetrics =
    analytics?.trendQualityBreakdown.tabs[trendTab] ??
    analytics?.trendQualityBreakdown.tabs.lowestSell;

  if (!selectedItem) {
    return (
      <div className="page-content">
        <EmptyAnalyticsState body="Use the global search to select a WFM item, then this page will load cached history, live orderbook pressure, and compact market snapshots." />
      </div>
    );
  }

  if (marketVariants.length > 1 && !selectedMarketVariantKey) {
    return (
      <div className="page-content">
        <EmptyAnalyticsState body="This item has separate rank markets. Pick the rank variant below before loading analytics so the history and live orders never mix different variants." />
        <div className="market-variant-card card">
          <div className="card-body market-variant-grid">
            {marketVariantsLoading ? <span className="empty-sub">Loading rank variants…</span> : null}
            {marketVariantsError ? <span className="watchlist-form-error">{marketVariantsError}</span> : null}
            {marketVariants.map((variant) => (
              <button
                key={variant.key}
                className={`market-variant-pill${variant.key === selectedMarketVariantKey ? ' active' : ''}`}
                type="button"
                onClick={() => {
                  void setSelectedMarketVariantKey(variant.key);
                }}
              >
                {variant.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={pageContentRef} className="page-content market-page-content">
      <div className="market-header-actions">
        {marketVariants.length > 0 ? (
          <select
            className="market-variant-select"
            value={selectedMarketVariantKey ?? ''}
            onChange={(event) => {
              void setSelectedMarketVariantKey(event.target.value || null);
            }}
            aria-label="Select market variant"
          >
            {marketVariants.map((variant) => (
              <option key={variant.key} value={variant.key}>
                {variant.label}
              </option>
            ))}
          </select>
        ) : null}
        <button className="btn-sm" type="button" onClick={() => setRefreshNonce((value) => value + 1)}>
          Refresh
        </button>
        <div className="market-item-freshness">
          <span>Snapshot {formatRelativeTimestamp(analytics?.sourceSnapshotAt ?? null)}</span>
          <span>Stats {formatRelativeTimestamp(analytics?.sourceStatsFetchedAt ?? null)}</span>
          <span>Computed {formatRelativeTimestamp(analytics?.computedAt ?? null)}</span>
        </div>
      </div>

      {loading ? (
        <div className="market-empty-state">
          <span className="empty-primary">Loading analytics</span>
          <span className="empty-sub">Refreshing the live orderbook and computing the current market structure.</span>
        </div>
      ) : null}

      {errorMessage ? (
        <div className="market-error-card card">
          <div className="card-body">
            <span className="watchlist-form-error">{errorMessage}</span>
          </div>
        </div>
      ) : null}

      {analytics ? (
        <>
          <div className="market-analytics-grid">
            <AnalyticsPanel title="Entry / Exit Zone Overview" eyebrow="Market State">
              <div className="market-metric-grid">
                <div className="market-metric-card">
                  <span className="market-metric-label">Current Lowest</span>
                  <span className="market-metric-value">{formatPrice(analytics.entryExitZoneOverview.currentLowestPrice)}</span>
                </div>
                <div className="market-metric-card">
                  <span className="market-metric-label">Median Lowest</span>
                  <span className="market-metric-value">{formatPrice(analytics.entryExitZoneOverview.currentMedianLowestPrice)}</span>
                </div>
                <div className="market-metric-card">
                  <span className="market-metric-label">Fair Value Band</span>
                  <span className="market-metric-value">
                    {formatPrice(analytics.entryExitZoneOverview.fairValueLow)} - {formatPrice(analytics.entryExitZoneOverview.fairValueHigh)}
                  </span>
                </div>
                <div className="market-metric-card">
                  <span className="market-metric-label">Zone Quality</span>
                  <span className="market-metric-value">{analytics.entryExitZoneOverview.zoneQuality}</span>
                </div>
              </div>
              <div className="market-copy-block">
                <span className="market-copy-title">Entry Zone</span>
                <span>
                  {formatPrice(analytics.entryExitZoneOverview.entryZoneLow)} - {formatPrice(analytics.entryExitZoneOverview.entryZoneHigh)}
                </span>
                <p>{analytics.entryExitZoneOverview.entryRationale}</p>
              </div>
              <div className="market-copy-block">
                <span className="market-copy-title">Exit Zone</span>
                <span>
                  {formatPrice(analytics.entryExitZoneOverview.exitZoneLow)} - {formatPrice(analytics.entryExitZoneOverview.exitZoneHigh)}
                </span>
                <p>{analytics.entryExitZoneOverview.exitRationale}</p>
              </div>
            </AnalyticsPanel>

            <AnalyticsPanel title="Orderbook Pressure" eyebrow="Execution">
              <div className="market-metric-grid">
                <div className="market-metric-card">
                  <span className="market-metric-label">Cheapest Sell</span>
                  <span className="market-metric-value">{formatPrice(analytics.orderbookPressure.cheapestSell)}</span>
                </div>
                <div className="market-metric-card">
                  <span className="market-metric-label">Highest Buy</span>
                  <span className="market-metric-value">{formatPrice(analytics.orderbookPressure.highestBuy)}</span>
                </div>
                <div className="market-metric-card">
                  <span className="market-metric-label">Spread</span>
                  <span className="market-metric-value">
                    {formatPrice(analytics.orderbookPressure.spread)} · {formatPercent(analytics.orderbookPressure.spreadPct)}
                  </span>
                </div>
                <div className="market-metric-card">
                  <span className="market-metric-label">Pressure</span>
                  <span className="market-metric-value">{analytics.orderbookPressure.pressureLabel}</span>
                </div>
              </div>
              <div className="market-pressure-row">
                <div>
                  <span className="market-copy-title">Entry Depth</span>
                  <span>{formatNumber(analytics.orderbookPressure.entryDepth, 0)} visible quantity</span>
                </div>
                <div>
                  <span className="market-copy-title">Exit Depth</span>
                  <span>{formatNumber(analytics.orderbookPressure.exitDepth, 0)} visible quantity</span>
                </div>
                <div>
                  <span className="market-copy-title">Pressure Ratio</span>
                  <span>{formatNumber(analytics.orderbookPressure.pressureRatio, 2)}</span>
                </div>
              </div>
            </AnalyticsPanel>

            <AnalyticsPanel title="Trend Quality Breakdown" eyebrow="Structure">
              <div className="market-tab-row">
                {(['lowestSell', 'medianSell', 'weightedAvg'] as const).map((key) => (
                  <button
                    key={key}
                    className={`market-chip${trendTab === key ? ' active' : ''}`}
                    type="button"
                    onClick={() => setTrendTab(key)}
                  >
                    {key === 'lowestSell' ? 'Lowest Sell' : key === 'medianSell' ? 'Median Lowest' : 'Weighted Avg'}
                  </button>
                ))}
              </div>
              {trendMetrics ? (
                <>
                  <div className="market-metric-grid">
                    <div className="market-metric-card">
                      <span className="market-metric-label">1H Slope</span>
                      <span className="market-metric-value">{formatPercent(trendMetrics.slope1h)}</span>
                    </div>
                    <div className="market-metric-card">
                      <span className="market-metric-label">3H Slope</span>
                      <span className="market-metric-value">{formatPercent(trendMetrics.slope3h)}</span>
                    </div>
                    <div className="market-metric-card">
                      <span className="market-metric-label">6H Slope</span>
                      <span className="market-metric-value">{formatPercent(trendMetrics.slope6h)}</span>
                    </div>
                    <div className="market-metric-card">
                      <span className="market-metric-label">Confidence</span>
                      <span className="market-metric-value">{formatPercent(trendMetrics.confidence)}</span>
                    </div>
                  </div>
                  <div className="market-copy-block">
                    <span className="market-copy-title">Cross Signal</span>
                    <p>{trendMetrics.crossSignal}</p>
                  </div>
                  <div className="market-copy-block">
                    <span className="market-copy-title">Reversal</span>
                    <p>{trendMetrics.reversal}</p>
                  </div>
                  <div className="market-signal-list">
                    {trendMetrics.confirmingSignals.map((signal) => (
                      <span key={signal} className="market-signal-pill">{signal}</span>
                    ))}
                  </div>
                  <div className="market-pressure-row">
                    <div>
                      <span className="market-copy-title">Stability</span>
                      <span>{formatPercent(analytics.trendQualityBreakdown.stability)}</span>
                    </div>
                    <div>
                      <span className="market-copy-title">Volatility</span>
                      <span>{formatPercent(analytics.trendQualityBreakdown.volatility)}</span>
                    </div>
                    <div>
                      <span className="market-copy-title">Noise</span>
                      <span>{formatPercent(analytics.trendQualityBreakdown.noise)}</span>
                    </div>
                  </div>
                </>
              ) : null}
            </AnalyticsPanel>

            <AnalyticsPanel title="Action Card" eyebrow="Readout">
              <div className={`market-action-card tone-${analytics.actionCard.tone}`}>
                <div className="market-action-header">
                  <span className="market-action-label">Suggested Action</span>
                  <span className="market-action-value">{analytics.actionCard.suggestedAction}</span>
                </div>
                <div className="market-metric-grid">
                  <div className="market-metric-card">
                    <span className="market-metric-label">Zone Quality</span>
                    <span className="market-metric-value">{analytics.actionCard.zoneQuality}</span>
                  </div>
                  <div className="market-metric-card">
                    <span className="market-metric-label">Zone Adjusted Edge</span>
                    <span className="market-metric-value">{formatPrice(analytics.actionCard.zoneAdjustedEdge)}</span>
                  </div>
                  <div className="market-metric-card">
                    <span className="market-metric-label">Spread</span>
                    <span className="market-metric-value">
                      {formatPrice(analytics.actionCard.spread)} · {formatPercent(analytics.actionCard.spreadPct)}
                    </span>
                  </div>
                  <div className="market-metric-card">
                    <span className="market-metric-label">Book Bias</span>
                    <span className="market-metric-value">{analytics.actionCard.pressureLabel}</span>
                  </div>
                </div>
                <p className="market-action-rationale">{analytics.actionCard.rationale}</p>
                <div className="market-signal-list">
                  {analytics.actionCard.alignedSignals.map((signal) => (
                    <span key={signal} className="market-signal-pill">{signal}</span>
                  ))}
                </div>
              </div>
            </AnalyticsPanel>
          </div>
        </>
      ) : null}
    </div>
  );
}

function AnalysisTab() {
  return (
    <div className="page-content">
      <div className="market-empty-state">
        <span className="empty-primary">Analysis will layer on top of analytics next</span>
        <span className="empty-sub">
          Flip models, execution reliability, manipulation risk, and deeper strategy signals are intentionally being kept separate from the analytics view.
        </span>
      </div>
    </div>
  );
}

export function MarketPage() {
  const marketSubTab = useAppStore((s) => s.marketSubTab);
  const setMarketSubTab = useAppStore((s) => s.setMarketSubTab);

  return (
    <>
      <div className="subnav">
        <div className="subnav-left">
          <span className="page-title">Market</span>
          {(['analysis', 'analytics'] as const).map((tab) => (
            <span
              key={tab}
              className={`subtab${marketSubTab === tab ? ' active' : ''}`}
              onClick={() => setMarketSubTab(tab)}
              role="tab"
              aria-selected={marketSubTab === tab}
              tabIndex={0}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </span>
          ))}
        </div>
      </div>

      {marketSubTab === 'analytics' ? <AnalyticsTab /> : <AnalysisTab />}
    </>
  );
}
