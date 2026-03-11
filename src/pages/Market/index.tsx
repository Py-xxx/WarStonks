import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ensureMarketTracking, getItemAnalytics, stopMarketTracking } from '../../lib/tauriClient';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { useAppStore } from '../../stores/useAppStore';
import type {
  AnalyticsBucketSizeKey,
  AnalyticsChartPoint,
  AnalyticsDomainKey,
  ItemAnalyticsResponse,
} from '../../types';

const DOMAIN_OPTIONS: { key: AnalyticsDomainKey; label: string }[] = [
  { key: '1d', label: '1D' },
  { key: '7d', label: '7D' },
  { key: '30d', label: '30D' },
  { key: '90d', label: '90D' },
];

const BUCKET_OPTIONS: { key: AnalyticsBucketSizeKey; label: string }[] = [
  { key: '1h', label: '1H' },
  { key: '3h', label: '3H' },
  { key: '12h', label: '12H' },
  { key: '18h', label: '18H' },
  { key: '24h', label: '24H' },
  { key: '7d', label: '7D' },
  { key: '14d', label: '14D' },
];

const SUPPORTED_BUCKETS: Record<AnalyticsDomainKey, AnalyticsBucketSizeKey[]> = {
  '1d': ['1h', '3h', '12h', '18h', '24h'],
  '7d': ['24h', '7d'],
  '30d': ['24h', '7d', '14d'],
  '90d': ['24h', '7d', '14d'],
};

const SERIES_TOGGLE_ORDER = [
  { key: 'movingAvg', label: 'Moving Avg' },
  { key: 'weightedAvg', label: 'Weighted Avg' },
  { key: 'averagePrice', label: 'Average Price' },
  { key: 'highestBuy', label: 'Highest Buy' },
  { key: 'fairValueBand', label: 'Fair Value Band' },
] as const;

type SeriesToggleKey = (typeof SERIES_TOGGLE_ORDER)[number]['key'];

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

function buildSeriesPath(
  points: AnalyticsChartPoint[],
  selector: (point: AnalyticsChartPoint) => number | null,
  width: number,
  height: number,
): string {
  const seriesValues = points.map(selector);
  const definedValues = seriesValues.filter((value): value is number => value !== null);
  if (definedValues.length === 0) {
    return '';
  }

  const max = Math.max(...definedValues);
  const min = Math.min(...definedValues);
  const range = max - min || 1;
  const step = points.length === 1 ? width : width / Math.max(points.length - 1, 1);

  let path = '';
  seriesValues.forEach((value, index) => {
    if (value === null) {
      return;
    }

    const x = index * step;
    const y = height - ((value - min) / range) * height;
    path += `${path ? ' L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`;
  });

  return path;
}

function PriceChart({
  points,
  toggles,
}: {
  points: AnalyticsChartPoint[];
  toggles: Record<SeriesToggleKey, boolean>;
}) {
  const chartWidth = 820;
  const chartHeight = 260;
  const allValues = points.flatMap((point) => [
    point.lowestSell,
    point.medianSell,
    toggles.movingAvg ? point.movingAvg : null,
    toggles.weightedAvg ? point.weightedAvg : null,
    toggles.averagePrice ? point.averagePrice : null,
    toggles.highestBuy ? point.highestBuy : null,
    toggles.fairValueBand ? point.fairValueLow : null,
    toggles.fairValueBand ? point.fairValueHigh : null,
  ]);
  const definedValues = allValues.filter((value): value is number => value !== null);
  const max = definedValues.length > 0 ? Math.max(...definedValues) : 1;
  const min = definedValues.length > 0 ? Math.min(...definedValues) : 0;
  const range = max - min || 1;
  const step = points.length === 1 ? chartWidth : chartWidth / Math.max(points.length - 1, 1);

  const projectY = (value: number) => chartHeight - ((value - min) / range) * chartHeight;
  const fairValuePolygon = toggles.fairValueBand
    ? (() => {
        const lowPoints = points
          .map((point, index) =>
            point.fairValueLow === null ? null : `${(index * step).toFixed(1)},${projectY(point.fairValueLow).toFixed(1)}`,
          )
          .filter((value): value is string => value !== null);
        const highPoints = points
          .map((point, index) =>
            point.fairValueHigh === null ? null : `${(index * step).toFixed(1)},${projectY(point.fairValueHigh).toFixed(1)}`,
          )
          .filter((value): value is string => value !== null)
          .reverse();

        if (lowPoints.length === 0 || highPoints.length === 0) {
          return '';
        }

        return `${lowPoints.join(' ')} ${highPoints.join(' ')}`;
      })()
    : '';

  const yAxisLabels = [max, max - range * 0.33, max - range * 0.66, min];

  return (
    <div className="market-chart-card">
      <div className="market-chart-surface">
        <div className="market-chart-y-axis">
          {yAxisLabels.map((value) => (
            <span key={value}>{formatPrice(value)}</span>
          ))}
        </div>
        <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} className="market-chart-svg" preserveAspectRatio="none">
          {[0.15, 0.4, 0.65, 0.9].map((position) => (
            <line
              key={position}
              x1="0"
              y1={chartHeight * position}
              x2={chartWidth}
              y2={chartHeight * position}
              className="market-chart-gridline"
            />
          ))}
          {fairValuePolygon ? (
            <polygon points={fairValuePolygon} className="market-chart-band" />
          ) : null}
          <path
            d={buildSeriesPath(points, (point) => point.lowestSell, chartWidth, chartHeight)}
            className="market-chart-line market-chart-line-primary"
          />
          <path
            d={buildSeriesPath(points, (point) => point.medianSell, chartWidth, chartHeight)}
            className="market-chart-line market-chart-line-secondary"
          />
          {toggles.movingAvg ? (
            <path
              d={buildSeriesPath(points, (point) => point.movingAvg, chartWidth, chartHeight)}
              className="market-chart-line market-chart-line-moving"
            />
          ) : null}
          {toggles.weightedAvg ? (
            <path
              d={buildSeriesPath(points, (point) => point.weightedAvg, chartWidth, chartHeight)}
              className="market-chart-line market-chart-line-weighted"
            />
          ) : null}
          {toggles.averagePrice ? (
            <path
              d={buildSeriesPath(points, (point) => point.averagePrice, chartWidth, chartHeight)}
              className="market-chart-line market-chart-line-average"
            />
          ) : null}
          {toggles.highestBuy ? (
            <path
              d={buildSeriesPath(points, (point) => point.highestBuy, chartWidth, chartHeight)}
              className="market-chart-line market-chart-line-buy"
            />
          ) : null}
        </svg>
      </div>
      <div className="market-chart-legend">
        <span><i className="legend-swatch primary" /> Lowest Sell</span>
        <span><i className="legend-swatch secondary" /> Median Lowest</span>
        {toggles.movingAvg ? <span><i className="legend-swatch moving" /> Moving Avg</span> : null}
        {toggles.weightedAvg ? <span><i className="legend-swatch weighted" /> Weighted Avg</span> : null}
        {toggles.averagePrice ? <span><i className="legend-swatch average" /> Avg Price</span> : null}
        {toggles.highestBuy ? <span><i className="legend-swatch buy" /> Highest Buy</span> : null}
        {toggles.fairValueBand ? <span><i className="legend-swatch band" /> Fair Value Band</span> : null}
      </div>
    </div>
  );
}

function VolumeChart({ points }: { points: AnalyticsChartPoint[] }) {
  const width = 820;
  const height = 110;
  const maxVolume = Math.max(...points.map((point) => point.volume), 1);
  const barWidth = points.length === 0 ? 0 : width / Math.max(points.length, 1);

  return (
    <div className="market-volume-card">
      <div className="market-volume-header">
        <span className="card-label">Volume</span>
        <span className="market-volume-subtitle">Aligned to the active chart domain and buckets</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="market-volume-svg" preserveAspectRatio="none">
        {points.map((point, index) => {
          const barHeight = (point.volume / maxVolume) * (height - 8);
          const x = index * barWidth + 2;
          const y = height - barHeight;
          return (
            <rect
              key={point.bucketAt}
              x={x}
              y={y}
              width={Math.max(barWidth - 4, 6)}
              height={barHeight}
              rx="4"
              className="market-volume-bar"
            />
          );
        })}
      </svg>
    </div>
  );
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
  const selectedItem = useAppStore((state) => state.quickView.selectedItem);
  const marketVariants = useAppStore((state) => state.marketVariants);
  const marketVariantsLoading = useAppStore((state) => state.marketVariantsLoading);
  const marketVariantsError = useAppStore((state) => state.marketVariantsError);
  const selectedMarketVariantKey = useAppStore((state) => state.selectedMarketVariantKey);
  const setSelectedMarketVariantKey = useAppStore((state) => state.setSelectedMarketVariantKey);
  const [domainKey, setDomainKey] = useState<AnalyticsDomainKey>('30d');
  const [bucketSizeKey, setBucketSizeKey] = useState<AnalyticsBucketSizeKey>('24h');
  const [analytics, setAnalytics] = useState<ItemAnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [trendTab, setTrendTab] = useState<'lowestSell' | 'medianSell' | 'weightedAvg'>('lowestSell');
  const [toggles, setToggles] = useState<Record<SeriesToggleKey, boolean>>({
    movingAvg: true,
    weightedAvg: true,
    averagePrice: false,
    highestBuy: true,
    fairValueBand: true,
  });

  const supportedBuckets = SUPPORTED_BUCKETS[domainKey];

  useEffect(() => {
    if (!supportedBuckets.includes(bucketSizeKey)) {
      setBucketSizeKey(supportedBuckets[0]);
    }
  }, [bucketSizeKey, supportedBuckets]);

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
          domainKey,
          bucketSizeKey,
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
  }, [selectedItem, selectedMarketVariantKey, domainKey, bucketSizeKey, refreshNonce]);

  const selectedVariant = useMemo(
    () => marketVariants.find((entry) => entry.key === selectedMarketVariantKey) ?? null,
    [marketVariants, selectedMarketVariantKey],
  );
  const imageUrl = resolveWfmAssetUrl(selectedItem?.imagePath ?? null);
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
        <div className="market-item-header card">
          <div className="market-item-media">
            <div className="market-item-thumb">
              {imageUrl ? <img src={imageUrl} alt="" /> : <span>{selectedItem.name.slice(0, 1)}</span>}
            </div>
            <div className="market-item-copy">
              <span className="panel-title-eyebrow">Analytics</span>
              <span className="market-item-title">{selectedItem.name}</span>
              <span className="market-item-meta">{selectedItem.slug.replace(/_/g, ' / ')}</span>
            </div>
          </div>
        </div>
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
    <div className="page-content market-page-content">
      <div className="market-item-header card">
        <div className="market-item-media">
          <div className="market-item-thumb">
            {imageUrl ? <img src={imageUrl} alt="" /> : <span>{selectedItem.name.slice(0, 1)}</span>}
          </div>
          <div className="market-item-copy">
            <span className="panel-title-eyebrow">Analytics</span>
            <span className="market-item-title">{selectedItem.name}</span>
            <span className="market-item-meta">{selectedItem.slug}</span>
            <div className="market-item-freshness">
              <span>Snapshot {formatRelativeTimestamp(analytics?.sourceSnapshotAt ?? null)}</span>
              <span>Stats {formatRelativeTimestamp(analytics?.sourceStatsFetchedAt ?? null)}</span>
              <span>Computed {formatRelativeTimestamp(analytics?.computedAt ?? null)}</span>
            </div>
          </div>
        </div>

        <div className="market-header-actions">
          {marketVariants.length > 0 ? (
            <select
              className="market-variant-select"
              value={selectedVariant?.key ?? ''}
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
        </div>
      </div>

      <div className="market-toolbar card">
        <div className="market-toolbar-row">
          <div className="market-toolbar-group">
            <span className="market-toolbar-label">Domain</span>
            <div className="market-chip-row">
              {DOMAIN_OPTIONS.map((option) => (
                <button
                  key={option.key}
                  className={`market-chip${option.key === domainKey ? ' active' : ''}`}
                  type="button"
                  onClick={() => setDomainKey(option.key)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className="market-toolbar-group">
            <span className="market-toolbar-label">Bucket Size</span>
            <div className="market-chip-row">
              {BUCKET_OPTIONS.map((option) => {
                const supported = supportedBuckets.includes(option.key);
                return (
                  <button
                    key={option.key}
                    className={`market-chip${option.key === bucketSizeKey ? ' active' : ''}`}
                    type="button"
                    disabled={!supported}
                    onClick={() => supported && setBucketSizeKey(option.key)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="market-toolbar-row">
          <div className="market-toolbar-group">
            <span className="market-toolbar-label">Overlays</span>
            <div className="market-toggle-row">
              {SERIES_TOGGLE_ORDER.map((toggle) => (
                <button
                  key={toggle.key}
                  className={`market-toggle${toggles[toggle.key] ? ' active' : ''}`}
                  type="button"
                  onClick={() =>
                    setToggles((current) => ({
                      ...current,
                      [toggle.key]: !current[toggle.key],
                    }))
                  }
                >
                  {toggle.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="market-empty-state">
          <span className="empty-primary">Loading analytics</span>
          <span className="empty-sub">Pulling cached history, refreshing the live orderbook, and computing current market structure.</span>
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
          <div className="market-chart-stack card">
            <div className="card-header">
              <div className="market-panel-header">
                <span className="panel-title-eyebrow">Price History</span>
                <span className="card-label">Lowest vs Median Lowest</span>
              </div>
            </div>
            <div className="card-body">
              <PriceChart points={analytics.chartPoints} toggles={toggles} />
              <VolumeChart points={analytics.chartPoints} />
            </div>
          </div>

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
