import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ensureMarketTracking, getItemAnalytics, stopMarketTracking } from '../../lib/tauriClient';
import { useAppStore } from '../../stores/useAppStore';
import type { AnalyticsChartPoint, ItemAnalyticsResponse } from '../../types';

type ChartDomainKey = '48h' | '7d' | '30d' | '90d';
type ChartBucketKey = '1h' | '3h' | '6h' | '12h' | '24h' | '7d' | '14d';
type ChartSeriesKey = 'median' | 'lowest' | 'movingAverage' | 'average' | 'entryZone' | 'exitZone';
type ChartMode = 'line' | 'candlestick';

interface MockBucketPoint {
  timestamp: number;
  open: number | null;
  close: number | null;
  low: number | null;
  high: number | null;
  lowest: number | null;
  median: number | null;
  average: number | null;
  movingAverage: number | null;
  entryZone: number | null;
  exitZone: number | null;
  volume: number;
}

interface ChartSeriesOption {
  key: ChartSeriesKey;
  label: string;
  colorClass: string;
}

const DOMAIN_OPTIONS: Array<{ key: ChartDomainKey; label: string; hours: number }> = [
  { key: '48h', label: '48 hours', hours: 48 },
  { key: '7d', label: '7 days', hours: 24 * 7 },
  { key: '30d', label: '30 days', hours: 24 * 30 },
  { key: '90d', label: '90 days', hours: 24 * 90 },
];

const BUCKET_OPTIONS_BY_DOMAIN: Record<ChartDomainKey, ChartBucketKey[]> = {
  '48h': ['1h', '3h', '6h', '12h', '24h'],
  '7d': ['3h', '6h', '12h', '24h'],
  '30d': ['12h', '24h', '7d'],
  '90d': ['24h', '7d', '14d'],
};

const SERIES_OPTIONS: ChartSeriesOption[] = [
  { key: 'median', label: 'Median', colorClass: 'secondary' },
  { key: 'lowest', label: 'Lowest', colorClass: 'primary' },
  { key: 'movingAverage', label: 'SMA', colorClass: 'moving' },
  { key: 'average', label: 'Avg Price', colorClass: 'average' },
  { key: 'entryZone', label: 'Entry Zone', colorClass: 'entry' },
  { key: 'exitZone', label: 'Exit Zone', colorClass: 'exit' },
];

const DEFAULT_SERIES_TOGGLES: Record<ChartSeriesKey, boolean> = {
  median: true,
  lowest: true,
  movingAverage: true,
  average: false,
  entryZone: true,
  exitZone: true,
};

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function buildChartPoints(points: AnalyticsChartPoint[]): MockBucketPoint[] {
  return points
    .map((point) => {
      const timestamp = new Date(point.bucketAt).getTime();
      if (Number.isNaN(timestamp)) {
        return null;
      }

      return {
        timestamp,
        open: point.openPrice,
        close: point.closedPrice,
        low: point.lowPrice,
        high: point.highPrice,
        lowest: point.lowestSell,
        median: point.medianSell,
        average: point.averagePrice,
        movingAverage: point.movingAvg,
        entryZone: point.fairValueLow,
        exitZone: point.fairValueHigh,
        volume: point.volume,
      };
    })
    .filter((point): point is MockBucketPoint => point !== null);
}

function formatChartTimestamp(timestamp: number, domain: ChartDomainKey): string {
  const formatOptions: Intl.DateTimeFormatOptions =
    domain === '48h'
      ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { month: 'short', day: 'numeric' };

  return new Intl.DateTimeFormat(undefined, formatOptions).format(new Date(timestamp));
}

function buildSeriesPath(
  points: MockBucketPoint[],
  valueKey: keyof Pick<MockBucketPoint, 'lowest' | 'median' | 'movingAverage' | 'average' | 'entryZone' | 'exitZone'>,
  chartWidth: number,
  chartHeight: number,
  minValue: number,
  maxValue: number,
): string {
  const drawablePoints = points
    .map((point, index) => ({
      index,
      value: point[valueKey],
    }))
    .filter((point): point is { index: number; value: number } => point.value !== null);

  if (!drawablePoints.length) {
    return '';
  }

  const valueRange = Math.max(1, maxValue - minValue);
  return drawablePoints
    .map((point, pathIndex) => {
      const x = points.length === 1 ? chartWidth / 2 : (point.index / (points.length - 1)) * chartWidth;
      const y = chartHeight - ((point.value - minValue) / valueRange) * chartHeight;
      return `${pathIndex === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
}

function getChartBounds(points: MockBucketPoint[]) {
  const values = points.flatMap((point) => [
    point.low,
    point.high,
    point.lowest,
    point.median,
    point.average,
    point.movingAverage,
    point.entryZone,
    point.exitZone,
  ]);
  const numericValues = values.filter((value): value is number => value !== null);

  if (!numericValues.length) {
    return { minValue: 0, maxValue: 100 };
  }

  const rawMin = Math.min(...numericValues);
  const rawMax = Math.max(...numericValues);
  const padding = Math.max(2, ((rawMax - rawMin) || 1) * 0.12);
  return {
    minValue: rawMin - padding,
    maxValue: rawMax + padding,
  };
}

function renderChartY(value: number, chartHeight: number, minValue: number, maxValue: number): number {
  const valueRange = Math.max(1, maxValue - minValue);
  return chartHeight - ((value - minValue) / valueRange) * chartHeight;
}

function StaticAnalyticsChart({
  itemName,
  analytics,
  loading,
  errorMessage,
  domain,
  bucket,
  onDomainChange,
  onBucketChange,
}: {
  itemName: string;
  analytics: ItemAnalyticsResponse | null;
  loading: boolean;
  errorMessage: string | null;
  domain: ChartDomainKey;
  bucket: ChartBucketKey;
  onDomainChange: (value: ChartDomainKey) => void;
  onBucketChange: (value: ChartBucketKey) => void;
}) {
  const [chartMode, setChartMode] = useState<ChartMode>('line');
  const [seriesToggles, setSeriesToggles] = useState<Record<ChartSeriesKey, boolean>>(DEFAULT_SERIES_TOGGLES);

  const bucketOptions = BUCKET_OPTIONS_BY_DOMAIN[domain];
  const points = buildChartPoints(analytics?.chartPoints ?? []);
  const plotWidth = 900;
  const pricePlotHeight = 252;
  const volumePlotHeight = 92;
  const xAxisHeight = 24;
  const volumeTop = pricePlotHeight + 18;
  const totalPlotHeight = volumeTop + volumePlotHeight;
  const { minValue, maxValue } = getChartBounds(points);
  const valueRange = Math.max(1, maxValue - minValue);
  const tickValues = Array.from({ length: 5 }, (_, index) =>
    roundTo(maxValue - (index / 4) * valueRange, 1),
  );
  const visibleSeries = SERIES_OPTIONS.filter((option) => seriesToggles[option.key]);
  const volumeMax = Math.max(...points.map((point) => point.volume), 1);
  const latestPoint = points[points.length - 1] ?? null;
  const latestDelta =
    latestPoint?.open !== null &&
    latestPoint?.close !== null &&
    latestPoint?.open !== undefined &&
    latestPoint?.close !== undefined
      ? roundTo(latestPoint.close - latestPoint.open, 1)
      : null;
  const latestDeltaPct =
    latestDelta !== null && latestPoint?.open !== null && latestPoint.open > 0
      ? roundTo((latestDelta / latestPoint.open) * 100, 2)
      : null;

  function toggleSeries(key: ChartSeriesKey) {
    setSeriesToggles((current) => ({
      ...current,
      [key]: !current[key],
    }));
  }

  return (
    <div className="card market-chart-stack">
      <div className="card-header">
        <div className="market-chart-header">
          <div className="market-chart-header-copy">
            <span className="panel-title-eyebrow">Live Market Graph</span>
            <span className="card-label">Item Price History</span>
          </div>
          <div className="market-chart-header-tools">
            <span className="market-chart-item-pill">Selected item: {itemName}</span>
            <div className="market-chart-select-row">
              <label className="market-toolbar-group">
                <span className="market-toolbar-label">Domain</span>
                <select
                  className="market-variant-select"
                  value={domain}
                  onChange={(event) => onDomainChange(event.target.value as ChartDomainKey)}
                >
                  {DOMAIN_OPTIONS.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="market-toolbar-group">
                <span className="market-toolbar-label">Bucket</span>
                <select
                  className="market-variant-select"
                  value={bucket}
                  onChange={(event) => onBucketChange(event.target.value as ChartBucketKey)}
                >
                  {bucketOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <div className="market-toolbar-group">
                <span className="market-toolbar-label">Graph Type</span>
                <div className="market-chart-mode-row">
                  <button
                    className={`market-mode-chip${chartMode === 'line' ? ' active' : ''}`}
                    type="button"
                    onClick={() => setChartMode('line')}
                  >
                    Line
                  </button>
                  <button
                    className={`market-mode-chip${chartMode === 'candlestick' ? ' active' : ''}`}
                    type="button"
                    onClick={() => setChartMode('candlestick')}
                  >
                    Candles
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="card-body">
        <div className="market-chart-card">
          <div className="market-chart-toolbar">
            <div className="market-chart-toolbar-copy">
              <span className="market-chart-note">
                WFM statistics history with local observatory snapshots filling recent live context.
              </span>
              <div className="market-chart-ohlc-row">
                <span>O {formatPrice(latestPoint?.open ?? null)}</span>
                <span>H {formatPrice(latestPoint?.high ?? null)}</span>
                <span>L {formatPrice(latestPoint?.low ?? null)}</span>
                <span>C {formatPrice(latestPoint?.close ?? null)}</span>
                <span className={`market-chart-delta${latestDelta !== null && latestDelta < 0 ? ' is-down' : ' is-up'}`}>
                  {latestDelta !== null && latestDelta > 0 ? '+' : ''}{formatPrice(latestDelta)}
                  {' '}
                  ({latestDeltaPct !== null && latestDeltaPct > 0 ? '+' : ''}{formatPercent(latestDeltaPct)})
                </span>
              </div>
            </div>
            <div className="market-toggle-row">
              {SERIES_OPTIONS.map((option) => (
                <button
                  key={option.key}
                  className={`market-chart-toggle${seriesToggles[option.key] ? ' active' : ''}`}
                  type="button"
                  onClick={() => toggleSeries(option.key)}
                >
                  <span className={`legend-swatch ${option.colorClass}`} />
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="market-chart-surface">
            <div className="market-chart-y-axis">
              {tickValues.map((value) => (
                <span key={value}>{formatPrice(value)}</span>
              ))}
            </div>
            {loading ? (
              <div className="market-chart-status">Loading history from WFM statistics and local market snapshots.</div>
            ) : errorMessage ? (
              <div className="market-chart-status is-error">{errorMessage}</div>
            ) : points.length === 0 ? (
              <div className="market-chart-status">No chart history is available for the selected item and variant.</div>
            ) : (
              <svg
                className="market-chart-svg"
                viewBox={`0 0 ${plotWidth} ${totalPlotHeight + xAxisHeight}`}
                preserveAspectRatio="none"
                aria-label="Market price graph"
              >
                {Array.from({ length: 5 }, (_, index) => {
                  const y = (index / 4) * pricePlotHeight;
                  return (
                    <line
                      key={`h-${index}`}
                      className="market-chart-gridline"
                      x1="0"
                      y1={y}
                      x2={plotWidth}
                      y2={y}
                    />
                  );
                })}
                {Array.from({ length: Math.min(points.length, 6) }, (_, index) => {
                  const x = points.length <= 1 ? plotWidth / 2 : (index / Math.max(1, Math.min(points.length, 6) - 1)) * plotWidth;
                  return (
                    <line
                      key={`v-${index}`}
                      className="market-chart-gridline market-chart-gridline-vertical"
                      x1={x}
                      y1="0"
                      x2={x}
                      y2={totalPlotHeight}
                    />
                  );
                })}
                <line
                  className="market-chart-gridline market-chart-divider"
                  x1="0"
                  y1={volumeTop - 8}
                  x2={plotWidth}
                  y2={volumeTop - 8}
                />

                {chartMode === 'candlestick'
                  ? points.map((point, index) => {
                      if (
                        point.open === null ||
                        point.close === null ||
                        point.low === null ||
                        point.high === null
                      ) {
                        return null;
                      }

                      const step = points.length === 1 ? plotWidth : plotWidth / Math.max(1, points.length - 1);
                      const candleWidth = Math.max(6, Math.min(22, step * 0.45));
                      const x = points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth;
                      const openY = renderChartY(point.open, pricePlotHeight, minValue, maxValue);
                      const closeY = renderChartY(point.close, pricePlotHeight, minValue, maxValue);
                      const highY = renderChartY(point.high, pricePlotHeight, minValue, maxValue);
                      const lowY = renderChartY(point.low, pricePlotHeight, minValue, maxValue);
                      const bodyY = Math.min(openY, closeY);
                      const bodyHeight = Math.max(3, Math.abs(closeY - openY));
                      const isUp = point.close >= point.open;

                      return (
                        <g key={point.timestamp}>
                          <line
                            className={`market-candle-wick${isUp ? ' is-up' : ' is-down'}`}
                            x1={x}
                            y1={highY}
                            x2={x}
                            y2={lowY}
                          />
                          <rect
                            className={`market-candle-body${isUp ? ' is-up' : ' is-down'}`}
                            x={x - candleWidth / 2}
                            y={bodyY}
                            width={candleWidth}
                            height={bodyHeight}
                            rx="2"
                          />
                        </g>
                      );
                    })
                  : null}

                {visibleSeries.map((series) => (
                  <path
                    key={series.key}
                    className={`market-chart-line market-chart-line-${series.colorClass}`}
                    d={buildSeriesPath(points, series.key, plotWidth, pricePlotHeight, minValue, maxValue)}
                  />
                ))}

                {visibleSeries
                  .filter((series) => series.key === 'median' || series.key === 'lowest')
                  .flatMap((series) =>
                    points.map((point, index) => {
                      const value = point[series.key];
                      if (value === null) {
                        return null;
                      }
                      const x = points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth;
                      const y = renderChartY(value, pricePlotHeight, minValue, maxValue);
                      return (
                        <circle
                          key={`${series.key}-${point.timestamp}`}
                          className={`market-chart-marker market-chart-marker-${series.colorClass}`}
                          cx={x}
                          cy={y}
                          r="3.5"
                        />
                      );
                    }),
                  )}

                {points.map((point, index) => {
                  const step = points.length === 1 ? plotWidth : plotWidth / Math.max(1, points.length);
                  const width = Math.max(8, Math.min(24, step * 0.7));
                  const x = points.length === 1 ? (plotWidth - width) / 2 : (index / points.length) * plotWidth + (step - width) / 2;
                  const height = Math.max(4, (point.volume / Math.max(volumeMax, 1)) * volumePlotHeight);
                  const isUp =
                    point.close !== null && point.open !== null ? point.close >= point.open : point.volume > 0;

                  return (
                    <rect
                      key={`volume-${point.timestamp}`}
                      className={`market-volume-bar${isUp ? ' is-up' : ' is-down'}`}
                      x={x}
                      y={totalPlotHeight - height}
                      width={width}
                      height={height}
                      rx="3"
                    />
                  );
                })}

                {points
                  .filter((_, index) => index % Math.max(1, Math.ceil(points.length / 6)) === 0 || index === points.length - 1)
                  .map((point, labelIndex, source) => {
                    const dataIndex = points.findIndex((entry) => entry.timestamp === point.timestamp);
                    const x = points.length === 1 ? plotWidth / 2 : (dataIndex / (points.length - 1)) * plotWidth;
                    const anchor =
                      labelIndex === 0 ? 'start' : labelIndex === source.length - 1 ? 'end' : 'middle';

                    return (
                      <text
                        key={`x-${point.timestamp}`}
                        className="market-chart-axis-label"
                        x={x}
                        y={totalPlotHeight + 18}
                        textAnchor={anchor}
                      >
                        {formatChartTimestamp(point.timestamp, domain)}
                      </text>
                    );
                  })}
              </svg>
            )}
          </div>

          <div className="market-chart-legend market-chart-footer">
            <span>Bucket: {bucket}</span>
            <span>Points: {points.length}</span>
            <span>Latest median: {formatPrice(points[points.length - 1]?.median ?? null)}</span>
            <span>Latest lowest: {formatPrice(points[points.length - 1]?.lowest ?? null)}</span>
            <span>Latest volume: {formatNumber(points[points.length - 1]?.volume ?? null, 0)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

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
  const [chartDomain, setChartDomain] = useState<ChartDomainKey>('48h');
  const [chartBucket, setChartBucket] = useState<ChartBucketKey>('1h');

  useEffect(() => {
    pageContentRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [selectedItem?.itemId, selectedMarketVariantKey]);

  useEffect(() => {
    const allowedBuckets = BUCKET_OPTIONS_BY_DOMAIN[chartDomain];
    if (!allowedBuckets.includes(chartBucket)) {
      setChartBucket(allowedBuckets[0]);
    }
  }, [chartDomain, chartBucket]);

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
          chartDomain,
          chartBucket,
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
  }, [selectedItem, selectedMarketVariantKey, refreshNonce, chartDomain, chartBucket]);

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

  if (marketVariantsLoading) {
    return (
      <div className="page-content">
        <EmptyAnalyticsState body="Loading item data and computing the current market snapshot." />
      </div>
    );
  }

  if (marketVariants.length > 1 && !selectedMarketVariantKey) {
    return (
      <div className="page-content">
        <EmptyAnalyticsState body="This item has separate rank markets. Pick the rank variant below before loading analytics so the history and live orders never mix different variants." />
        <div className="market-variant-card card">
          <div className="card-body market-variant-grid">
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
      <StaticAnalyticsChart
        itemName={selectedItem.name}
        analytics={analytics}
        loading={loading}
        errorMessage={errorMessage}
        domain={chartDomain}
        bucket={chartBucket}
        onDomainChange={setChartDomain}
        onBucketChange={setChartBucket}
      />
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
