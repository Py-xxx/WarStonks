import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ensureMarketTracking, getItemAnalytics, stopMarketTracking } from '../../lib/tauriClient';
import { useAppStore } from '../../stores/useAppStore';
import type {
  AnalyticsBucketSizeKey,
  AnalyticsChartPoint,
  AnalyticsDomainKey,
  ItemAnalyticsResponse,
} from '../../types';

const DOMAIN_OPTIONS: { key: AnalyticsDomainKey; label: string }[] = [
  { key: '48h', label: '48 hours' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
];

const BUCKET_OPTIONS: { key: AnalyticsBucketSizeKey; label: string }[] = [
  { key: '1h', label: '60 min' },
  { key: '3h', label: '180 min' },
  { key: '12h', label: '12 h' },
  { key: '18h', label: '18 h' },
  { key: '24h', label: '24 h' },
  { key: '7d', label: '7 d' },
  { key: '14d', label: '14 d' },
];

const SUPPORTED_BUCKETS: Record<AnalyticsDomainKey, AnalyticsBucketSizeKey[]> = {
  '48h': ['1h', '3h', '12h', '18h', '24h'],
  '7d': ['24h', '7d'],
  '30d': ['24h', '7d', '14d'],
  '90d': ['24h', '7d', '14d'],
};

const HISTORY_SERIES = [
  { key: 'median', label: 'Median', colorClass: 'median' },
  { key: 'lowest', label: 'Lowest', colorClass: 'lowest' },
  { key: 'moving', label: 'SMA', colorClass: 'moving' },
  { key: 'weighted', label: 'Weighted', colorClass: 'weighted' },
  { key: 'entry', label: 'Entry Zone', colorClass: 'entry' },
  { key: 'exit', label: 'Exit Zone', colorClass: 'exit' },
] as const;

type HistorySeriesKey = (typeof HISTORY_SERIES)[number]['key'];

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

function formatTimelineLabel(value: string, includeDate = false): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: includeDate ? 'short' : undefined,
    day: includeDate ? 'numeric' : undefined,
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

function formatDomainLabel(domainKey: AnalyticsDomainKey): string {
  return DOMAIN_OPTIONS.find((option) => option.key === domainKey)?.label ?? domainKey;
}

function formatBucketLabel(bucketKey: AnalyticsBucketSizeKey): string {
  return BUCKET_OPTIONS.find((option) => option.key === bucketKey)?.label ?? bucketKey;
}

function buildLinePath(
  values: Array<number | null>,
  width: number,
  height: number,
  minValue: number,
  maxValue: number,
): Array<Array<{ x: number; y: number; value: number }>> {
  const range = maxValue - minValue || 1;
  const step = values.length <= 1 ? 0 : width / Math.max(values.length - 1, 1);
  const segments: Array<Array<{ x: number; y: number; value: number }>> = [];
  let currentSegment: Array<{ x: number; y: number; value: number }> = [];

  values.forEach((value, index) => {
    if (value === null) {
      if (currentSegment.length > 0) {
        segments.push(currentSegment);
        currentSegment = [];
      }
      return;
    }

    const x = values.length <= 1 ? width / 2 : index * step;
    const y = height - ((value - minValue) / range) * height;
    currentSegment.push({ x, y, value });
  });

  if (currentSegment.length > 0) {
    segments.push(currentSegment);
  }

  return segments;
}

function buildHistorySeriesValues(
  points: AnalyticsChartPoint[],
  analytics: ItemAnalyticsResponse | null,
): Record<HistorySeriesKey, Array<number | null>> {
  const entryMidpoint =
    analytics?.entryExitZoneOverview.entryZoneLow !== null &&
    analytics?.entryExitZoneOverview.entryZoneLow !== undefined &&
    analytics?.entryExitZoneOverview.entryZoneHigh !== null &&
    analytics?.entryExitZoneOverview.entryZoneHigh !== undefined
      ? (analytics.entryExitZoneOverview.entryZoneLow + analytics.entryExitZoneOverview.entryZoneHigh) / 2
      : null;
  const exitMidpoint =
    analytics?.entryExitZoneOverview.exitZoneLow !== null &&
    analytics?.entryExitZoneOverview.exitZoneLow !== undefined &&
    analytics?.entryExitZoneOverview.exitZoneHigh !== null &&
    analytics?.entryExitZoneOverview.exitZoneHigh !== undefined
      ? (analytics.entryExitZoneOverview.exitZoneLow + analytics.entryExitZoneOverview.exitZoneHigh) / 2
      : null;

  return {
    median: points.map((point) => point.medianSell),
    lowest: points.map((point) => point.lowestSell),
    moving: points.map((point) => point.movingAvg),
    weighted: points.map((point) => point.weightedAvg),
    entry: points.map(() => entryMidpoint),
    exit: points.map(() => exitMidpoint),
  };
}

function HistoryPanel({
  selectedItemName,
  domainKey,
  bucketSizeKey,
  onDomainChange,
  onBucketChange,
  supportedBuckets,
  toggles,
  onToggle,
  analytics,
  loading,
  errorMessage,
}: {
  selectedItemName: string;
  domainKey: AnalyticsDomainKey;
  bucketSizeKey: AnalyticsBucketSizeKey;
  onDomainChange: (value: AnalyticsDomainKey) => void;
  onBucketChange: (value: AnalyticsBucketSizeKey) => void;
  supportedBuckets: AnalyticsBucketSizeKey[];
  toggles: Record<HistorySeriesKey, boolean>;
  onToggle: (key: HistorySeriesKey) => void;
  analytics: ItemAnalyticsResponse | null;
  loading: boolean;
  errorMessage: string | null;
}) {
  const points = analytics?.chartPoints ?? [];
  const seriesValues = buildHistorySeriesValues(points, analytics);
  const enabledValues = Object.entries(seriesValues).flatMap(([key, values]) =>
    toggles[key as HistorySeriesKey] ? values : [],
  );
  const definedValues = enabledValues.filter((value): value is number => value !== null);
  const baseMinValue = definedValues.length > 0 ? Math.min(...definedValues) : 0;
  const baseMaxValue = definedValues.length > 0 ? Math.max(...definedValues) : 1;
  const baseRange = baseMaxValue - baseMinValue;
  const chartPadding =
    definedValues.length === 0
      ? 1
      : baseRange === 0
        ? Math.max(1, Math.abs(baseMinValue) * 0.04)
        : baseRange * 0.08;
  const minValue = baseMinValue - chartPadding;
  const maxValue = baseMaxValue + chartPadding;
  const yTicks = Array.from({ length: 5 }, (_, index) => maxValue - ((maxValue - minValue || 1) * index) / 4);
  const tickIndexes = points.length > 1
    ? Array.from(new Set([0, Math.floor((points.length - 1) * 0.25), Math.floor((points.length - 1) * 0.5), Math.floor((points.length - 1) * 0.75), points.length - 1]))
    : [0];

  const chartStatusMessage = loading
    ? 'Loading item history and refreshing the current market snapshot.'
    : errorMessage
      ? errorMessage
      : points.length === 0
        ? 'No historical rows are available for the active selection yet.'
        : null;
  const latestPoint = points.length > 0 ? points[points.length - 1] : null;

  return (
    <div className="card market-history-panel">
      <div className="card-body">
        <div className="market-history-topbar">
          <div className="market-history-item-pill">Selected item: <strong>{selectedItemName}</strong></div>
          <div className="market-history-controls">
            <label className="market-history-select-wrap">
              <span>Domain</span>
              <select value={domainKey} onChange={(event) => onDomainChange(event.target.value as AnalyticsDomainKey)}>
                {DOMAIN_OPTIONS.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="market-history-select-wrap">
              <span>Bucket</span>
              <select value={bucketSizeKey} onChange={(event) => onBucketChange(event.target.value as AnalyticsBucketSizeKey)}>
                {BUCKET_OPTIONS.map((option) => (
                  <option key={option.key} value={option.key} disabled={!supportedBuckets.includes(option.key)}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="market-history-header">
          <div className="market-history-title-group">
            <span className="panel-title-eyebrow">Item Price History</span>
            <span className="market-history-subtitle">
              {formatDomainLabel(domainKey)} · {formatBucketLabel(bucketSizeKey)} buckets
            </span>
          </div>
          <div className="market-history-legend">
            {HISTORY_SERIES.map((series) => (
              <button
                key={series.key}
                type="button"
                className={`market-history-toggle${toggles[series.key] ? ' active' : ''}`}
                onClick={() => onToggle(series.key)}
              >
                <span className={`market-history-dot ${series.colorClass}`} />
                {series.label}
              </button>
            ))}
          </div>
        </div>

        <div className="market-history-chart-shell">
          {chartStatusMessage ? (
            <div className={`market-chart-status${errorMessage ? ' is-error' : ''}`}>
              {chartStatusMessage}
            </div>
          ) : null}

          <div className="market-history-plot">
            <div className="market-history-y-axis">
              {yTicks.map((tick) => (
                <span key={tick}>{formatPrice(tick)}</span>
              ))}
            </div>
            <div className="market-history-plot-main">
              <svg
                viewBox="0 0 1000 320"
                width="1000"
                height="320"
                className="market-history-svg"
                preserveAspectRatio="none"
                aria-label="Item price history"
              >
                <rect x="0" y="0" width="1000" height="320" className="market-history-surface" />
                {[0, 0.25, 0.5, 0.75, 1].map((position) => (
                  <line
                    key={`h-${position}`}
                    x1="0"
                    y1={16 + position * 288}
                    x2="1000"
                    y2={16 + position * 288}
                    className="market-history-gridline"
                  />
                ))}
                {tickIndexes.map((tickIndex) => {
                  const x = points.length <= 1 ? 500 : (tickIndex / Math.max(points.length - 1, 1)) * 1000;
                  return (
                    <line
                      key={`v-${tickIndex}`}
                      x1={x}
                      y1="16"
                      x2={x}
                      y2="304"
                      className="market-history-gridline market-history-gridline-vertical"
                    />
                  );
                })}
                {HISTORY_SERIES.map((series) => {
                  if (!toggles[series.key]) {
                    return null;
                  }

                  const segments = buildLinePath(seriesValues[series.key], 1000, 288, minValue, maxValue);
                  if (segments.length === 0) {
                    return null;
                  }

                  return (
                    <g key={series.key}>
                      {segments.map((segment, index) => (
                        <polyline
                          key={`${series.key}-segment-${index}`}
                          points={segment.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')}
                          className={`market-history-line ${series.colorClass}`}
                        />
                      ))}
                      {segments.flatMap((segment, segmentIndex) =>
                        segment.map((point, pointIndex) => (
                          <circle
                            key={`${series.key}-point-${segmentIndex}-${pointIndex}`}
                            cx={point.x}
                            cy={point.y}
                            r={series.key === 'entry' || series.key === 'exit' ? 2.4 : 2.8}
                            className={`market-history-point ${series.colorClass}`}
                          />
                        )),
                      )}
                    </g>
                  );
                })}
              </svg>
              <div className="market-history-x-axis">
                {tickIndexes.map((tickIndex, renderIndex) => (
                  <span key={`${tickIndex}-${renderIndex}`}>
                    {points[tickIndex] ? formatTimelineLabel(points[tickIndex].bucketAt, domainKey !== '48h') : '—'}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="market-history-footer">
          <span>Bucket: {formatBucketLabel(bucketSizeKey)}</span>
          <span>Points: {points.length}</span>
          <span>Latest median: {formatPrice(latestPoint?.medianSell)}</span>
          <span>Latest lowest: {formatPrice(latestPoint?.lowestSell)}</span>
          <span>
            Visible depth: {analytics ? `${formatNumber(analytics.orderbookPressure.exitDepth, 0)} / ${formatNumber(analytics.orderbookPressure.entryDepth, 0)}` : '—'}
          </span>
        </div>
      </div>
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
  const pageContentRef = useRef<HTMLDivElement | null>(null);
  const selectedItem = useAppStore((state) => state.quickView.selectedItem);
  const marketVariants = useAppStore((state) => state.marketVariants);
  const marketVariantsLoading = useAppStore((state) => state.marketVariantsLoading);
  const marketVariantsError = useAppStore((state) => state.marketVariantsError);
  const selectedMarketVariantKey = useAppStore((state) => state.selectedMarketVariantKey);
  const setSelectedMarketVariantKey = useAppStore((state) => state.setSelectedMarketVariantKey);
  const [domainKey, setDomainKey] = useState<AnalyticsDomainKey>('48h');
  const [bucketSizeKey, setBucketSizeKey] = useState<AnalyticsBucketSizeKey>('1h');
  const [analytics, setAnalytics] = useState<ItemAnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [trendTab, setTrendTab] = useState<'lowestSell' | 'medianSell' | 'weightedAvg'>('lowestSell');
  const [historyToggles, setHistoryToggles] = useState<Record<HistorySeriesKey, boolean>>({
    median: true,
    lowest: true,
    moving: true,
    weighted: false,
    entry: true,
    exit: true,
  });

  const supportedBuckets = useMemo(() => SUPPORTED_BUCKETS[domainKey], [domainKey]);

  useEffect(() => {
    if (!supportedBuckets.includes(bucketSizeKey)) {
      setBucketSizeKey(supportedBuckets[0]);
    }
  }, [bucketSizeKey, supportedBuckets]);

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

      <HistoryPanel
        selectedItemName={selectedItem.name}
        domainKey={domainKey}
        bucketSizeKey={bucketSizeKey}
        onDomainChange={setDomainKey}
        onBucketChange={setBucketSizeKey}
        supportedBuckets={supportedBuckets}
        toggles={historyToggles}
        onToggle={(key) =>
          setHistoryToggles((current) => ({
            ...current,
            [key]: !current[key],
          }))
        }
        analytics={analytics}
        loading={loading}
        errorMessage={errorMessage}
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
