import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ensureMarketTracking, getItemAnalytics, stopMarketTracking } from '../../lib/tauriClient';
import { useAppStore } from '../../stores/useAppStore';
import type { ItemAnalyticsResponse } from '../../types';

type ChartDomainKey = '48h' | '7d' | '30d' | '90d';
type ChartBucketKey = '1h' | '3h' | '6h' | '12h' | '24h' | '7d' | '14d';
type ChartSeriesKey = 'median' | 'lowest' | 'movingAverage' | 'average' | 'entryZone' | 'exitZone';
type ChartMode = 'line' | 'candlestick';

interface MockHourlyPoint {
  timestamp: number;
  lowest: number;
  median: number;
  average: number;
  weighted: number;
  volume: number;
}

interface MockBucketPoint {
  timestamp: number;
  open: number;
  close: number;
  low: number;
  high: number;
  lowest: number;
  median: number;
  average: number;
  weighted: number;
  movingAverage: number;
  entryZone: number;
  exitZone: number;
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

const MOCK_HISTORY: MockHourlyPoint[] = buildMockHourlyHistory();

function buildMockHourlyHistory(): MockHourlyPoint[] {
  const pointCount = 24 * 90;
  const now = Date.now();
  const roundedNow = now - (now % (60 * 60 * 1000));
  const start = roundedNow - (pointCount - 1) * 60 * 60 * 1000;

  return Array.from({ length: pointCount }, (_, index) => {
    const timestamp = start + index * 60 * 60 * 1000;
    const longWave = Math.sin(index / 18) * 5.2;
    const midWave = Math.cos(index / 7.5) * 2.7;
    const shortWave = Math.sin(index / 2.9) * 1.1;
    const drift = (index / pointCount) * 9.5;
    const base = 72 + longWave + midWave + shortWave + drift;
    const lowest = Math.max(12, base - 4.6 + Math.cos(index / 5.5) * 0.85);
    const median = lowest + 3.2 + Math.sin(index / 9) * 1.35;
    const average = median + 0.85 + Math.cos(index / 14) * 0.55;
    const weighted = average + Math.sin(index / 15) * 0.45;
    const volume = Math.max(10, 46 + Math.sin(index / 8) * 14 + Math.cos(index / 19) * 8 + ((index % 24) / 24) * 10);

    return {
      timestamp,
      lowest: roundTo(lowest, 1),
      median: roundTo(median, 1),
      average: roundTo(average, 1),
      weighted: roundTo(weighted, 1),
      volume: roundTo(volume, 0),
    };
  });
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function getDomainHours(domain: ChartDomainKey): number {
  return DOMAIN_OPTIONS.find((option) => option.key === domain)?.hours ?? 48;
}

function getBucketHours(bucket: ChartBucketKey): number {
  switch (bucket) {
    case '1h':
      return 1;
    case '3h':
      return 3;
    case '6h':
      return 6;
    case '12h':
      return 12;
    case '24h':
      return 24;
    case '7d':
      return 24 * 7;
    case '14d':
      return 24 * 14;
    default:
      return 1;
  }
}

function movingAverage(values: number[], index: number, windowSize: number): number {
  const start = Math.max(0, index - windowSize + 1);
  const window = values.slice(start, index + 1);
  return roundTo(window.reduce((sum, value) => sum + value, 0) / window.length, 1);
}

function buildMockBucketHistory(domain: ChartDomainKey, bucket: ChartBucketKey): MockBucketPoint[] {
  const domainHours = getDomainHours(domain);
  const bucketHours = getBucketHours(bucket);
  const cutoffTimestamp = MOCK_HISTORY[MOCK_HISTORY.length - 1].timestamp - (domainHours - 1) * 60 * 60 * 1000;
  const rawPoints = MOCK_HISTORY.filter((point) => point.timestamp >= cutoffTimestamp);
  const groupedPoints: MockBucketPoint[] = [];

  for (let index = 0; index < rawPoints.length; index += bucketHours) {
    const slice = rawPoints.slice(index, index + bucketHours);
    if (!slice.length) {
      continue;
    }

    const lowestValues = slice.map((point) => point.lowest);
    const medianValues = slice.map((point) => point.median);
    const averageValues = slice.map((point) => point.average);
    const weightedValues = slice.map((point) => point.weighted);
    const close = lowestValues[lowestValues.length - 1];
    const weighted = weightedValues.reduce((sum, value) => sum + value, 0) / weightedValues.length;

    groupedPoints.push({
      timestamp: slice[slice.length - 1].timestamp,
      open: lowestValues[0],
      close,
      low: Math.min(...lowestValues),
      high: Math.max(...medianValues, ...lowestValues, ...averageValues),
      lowest: roundTo(lowestValues.reduce((sum, value) => sum + value, 0) / lowestValues.length, 1),
      median: roundTo(medianValues.reduce((sum, value) => sum + value, 0) / medianValues.length, 1),
      average: roundTo(averageValues.reduce((sum, value) => sum + value, 0) / averageValues.length, 1),
      weighted: roundTo(weighted, 1),
      movingAverage: 0,
      entryZone: roundTo(weighted - 3.1, 1),
      exitZone: roundTo(weighted + 4.3, 1),
      volume: roundTo(slice.reduce((sum, point) => sum + point.volume, 0), 0),
    });
  }

  const lowestSeries = groupedPoints.map((point) => point.lowest);
  return groupedPoints.map((point, index) => ({
    ...point,
    movingAverage: movingAverage(lowestSeries, index, Math.min(6, Math.max(2, Math.ceil(24 / bucketHours)))),
  }));
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
  if (!points.length) {
    return '';
  }

  const valueRange = Math.max(1, maxValue - minValue);
  return points
    .map((point, index) => {
      const x = points.length === 1 ? chartWidth / 2 : (index / (points.length - 1)) * chartWidth;
      const y = chartHeight - (((point[valueKey] as number) - minValue) / valueRange) * chartHeight;
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
}

function StaticAnalyticsChart({
  itemName,
}: {
  itemName: string;
}) {
  const [domain, setDomain] = useState<ChartDomainKey>('48h');
  const [bucket, setBucket] = useState<ChartBucketKey>('1h');
  const [chartMode, setChartMode] = useState<ChartMode>('line');
  const [seriesToggles, setSeriesToggles] = useState<Record<ChartSeriesKey, boolean>>(DEFAULT_SERIES_TOGGLES);

  useEffect(() => {
    const allowedBuckets = BUCKET_OPTIONS_BY_DOMAIN[domain];
    if (!allowedBuckets.includes(bucket)) {
      setBucket(allowedBuckets[0]);
    }
  }, [domain, bucket]);

  const bucketOptions = BUCKET_OPTIONS_BY_DOMAIN[domain];
  const points = buildMockBucketHistory(domain, bucket);
  const plotWidth = 900;
  const plotHeight = 240;
  const displayedValues = points.flatMap((point) => [
    point.low,
    point.high,
    point.entryZone,
    point.exitZone,
    point.movingAverage,
    point.average,
  ]);
  const rawMin = Math.min(...displayedValues);
  const rawMax = Math.max(...displayedValues);
  const padding = Math.max(2, (rawMax - rawMin) * 0.12);
  const minValue = rawMin - padding;
  const maxValue = rawMax + padding;
  const valueRange = Math.max(1, maxValue - minValue);
  const tickValues = Array.from({ length: 5 }, (_, index) =>
    roundTo(maxValue - (index / 4) * valueRange, 1),
  );
  const visibleSeries = SERIES_OPTIONS.filter((option) => seriesToggles[option.key]);
  const volumeMax = Math.max(...points.map((point) => point.volume), 1);

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
            <span className="panel-title-eyebrow">Preview Graph</span>
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
                  onChange={(event) => setDomain(event.target.value as ChartDomainKey)}
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
                  onChange={(event) => setBucket(event.target.value as ChartBucketKey)}
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
            <span className="market-chart-note">
              Static preview data. Backend graph wiring will be connected later.
            </span>
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
            <svg
              className="market-chart-svg"
              viewBox={`0 0 ${plotWidth} ${plotHeight + 28}`}
              preserveAspectRatio="none"
              aria-label="Static market price graph"
            >
              {Array.from({ length: 5 }, (_, index) => {
                const y = (index / 4) * plotHeight;
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
                    y2={plotHeight}
                  />
                );
              })}

              {chartMode === 'candlestick'
                ? points.map((point, index) => {
                    const step = points.length === 1 ? plotWidth : plotWidth / Math.max(1, points.length - 1);
                    const candleWidth = Math.max(6, Math.min(22, step * 0.45));
                    const x = points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth;
                    const openY = plotHeight - ((point.open - minValue) / valueRange) * plotHeight;
                    const closeY = plotHeight - ((point.close - minValue) / valueRange) * plotHeight;
                    const highY = plotHeight - ((point.high - minValue) / valueRange) * plotHeight;
                    const lowY = plotHeight - ((point.low - minValue) / valueRange) * plotHeight;
                    const bodyY = Math.min(openY, closeY);
                    const bodyHeight = Math.max(3, Math.abs(closeY - openY));
                    const isUp = point.close <= point.open;

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
                  d={buildSeriesPath(points, series.key, plotWidth, plotHeight, minValue, maxValue)}
                />
              ))}

              {visibleSeries
                .filter((series) => series.key === 'median' || series.key === 'lowest')
                .flatMap((series) =>
                  points.map((point, index) => {
                    const value = point[series.key];
                    const x = points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth;
                    const y = plotHeight - ((value - minValue) / valueRange) * plotHeight;
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
                      y={plotHeight + 20}
                      textAnchor={anchor}
                    >
                      {formatChartTimestamp(point.timestamp, domain)}
                    </text>
                  );
                })}
            </svg>
          </div>

          <div className="market-chart-legend market-chart-footer">
            <span>Bucket: {bucket}</span>
            <span>Points: {points.length}</span>
            <span>Latest median: {formatPrice(points[points.length - 1]?.median ?? null)}</span>
            <span>Latest lowest: {formatPrice(points[points.length - 1]?.lowest ?? null)}</span>
            <span>Latest volume: {formatNumber(points[points.length - 1]?.volume ?? null, 0)}</span>
          </div>
        </div>

        <div className="market-volume-card">
          <div className="market-volume-header">
            <div className="market-panel-header">
              <span className="panel-title-eyebrow">Participation</span>
              <span className="card-label">Volume</span>
            </div>
            <span className="market-volume-subtitle">Bucket-aligned static preview volume</span>
          </div>
          <svg
            className="market-volume-svg"
            viewBox={`0 0 ${plotWidth} 120`}
            preserveAspectRatio="none"
            aria-label="Static market volume graph"
          >
            {Array.from({ length: 4 }, (_, index) => {
              const y = 12 + index * 26;
              return (
                <line
                  key={`volume-grid-${index}`}
                  className="market-chart-gridline"
                  x1="0"
                  y1={y}
                  x2={plotWidth}
                  y2={y}
                />
              );
            })}
            {points.map((point, index) => {
              const step = points.length === 1 ? plotWidth : plotWidth / Math.max(1, points.length);
              const width = Math.max(8, Math.min(24, step * 0.7));
              const x = points.length === 1 ? (plotWidth - width) / 2 : (index / points.length) * plotWidth + (step - width) / 2;
              const height = Math.max(4, (point.volume / volumeMax) * 92);
              return (
                <rect
                  key={point.timestamp}
                  className="market-volume-bar"
                  x={x}
                  y={104 - height}
                  width={width}
                  height={height}
                  rx="3"
                />
              );
            })}
          </svg>
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
      <StaticAnalyticsChart itemName={selectedItem.name} />
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
