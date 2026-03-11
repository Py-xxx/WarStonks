import { useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, ReactNode, SetStateAction } from 'react';
import {
  ensureMarketTracking,
  getItemAnalysis,
  getItemAnalytics,
  getItemDetailSummary,
  openExternalUrl,
  stopMarketTracking,
} from '../../lib/tauriClient';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { useAppStore } from '../../stores/useAppStore';
import type {
  AnalyticsChartPoint,
  ItemAnalysisResponse,
  ItemAnalyticsResponse,
  ItemDetailSummary,
  WfmAutocompleteItem,
} from '../../types';

type ChartDomainKey = '48h' | '7d' | '30d' | '90d';
type ChartBucketKey = '1h' | '3h' | '6h' | '12h' | '24h' | '7d' | '14d';
type ChartSeriesKey = 'median' | 'lowest' | 'movingAverage' | 'average' | 'entryZone' | 'exitZone';
type ChartMode = 'line' | 'candlestick';
type AnalyticsPanelKey = 'chart' | 'overview' | 'pressure' | 'trend' | 'action';
type AnalysisPanelKey =
  | 'itemDetails'
  | 'headline'
  | 'flip'
  | 'liquidity'
  | 'trend'
  | 'eventContext'
  | 'manipulation'
  | 'timeOfDay'
  | 'supply';

const PANEL_REVEAL_STEP_MS = 85;
const ANALYTICS_PANEL_SEQUENCE: AnalyticsPanelKey[] = [
  'chart',
  'overview',
  'pressure',
  'trend',
  'action',
];
const ANALYSIS_PANEL_SEQUENCE: AnalysisPanelKey[] = [
  'headline',
  'flip',
  'liquidity',
  'trend',
  'eventContext',
  'manipulation',
  'timeOfDay',
  'supply',
];

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

function createRevealState<T extends string>(keys: readonly T[]): Record<T, boolean> {
  return Object.fromEntries(keys.map((key) => [key, false])) as Record<T, boolean>;
}

function clearRevealTimeouts(timeoutsRef: MutableRefObject<number[]>) {
  timeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
  timeoutsRef.current = [];
}

function queuePanelReveal<T extends string>(
  keys: readonly T[],
  setState: Dispatch<SetStateAction<Record<T, boolean>>>,
  timeoutsRef: MutableRefObject<number[]>,
) {
  clearRevealTimeouts(timeoutsRef);
  keys.forEach((key, index) => {
    const timeoutId = window.setTimeout(() => {
      setState((current) => ({
        ...current,
        [key]: true,
      }));
    }, index * PANEL_REVEAL_STEP_MS);
    timeoutsRef.current.push(timeoutId);
  });
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
  movingAverage: false,
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
        entryZone: point.entryZone,
        exitZone: point.exitZone,
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

function normalizeStatHighlightText(value: string): string[] {
  return value
    .replace(/\\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function renderStatHighlightLine(line: string): ReactNode {
  const changedRangeMatch = line.match(/(\d[\d.,%+\-xX ]*->\s*\d[\d.,%+\-xX ]*)/);
  if (!changedRangeMatch || changedRangeMatch.index === undefined) {
    return <span className="market-detail-highlight-copy">{line}</span>;
  }

  const rangeStart = changedRangeMatch.index;
  const changedText = changedRangeMatch[1].trim();
  const label = line.slice(0, rangeStart);
  const suffix = line.slice(rangeStart + changedRangeMatch[1].length);

  return (
    <>
      {label ? <span className="market-detail-highlight-copy">{label}</span> : null}
      <span className="market-detail-highlight-change">{changedText}</span>
      {suffix ? <span className="market-detail-highlight-copy">{suffix}</span> : null}
    </>
  );
}

async function handleOpenExternalLink(url: string | null | undefined) {
  if (!url) {
    return;
  }

  try {
    await openExternalUrl(url);
  } catch (error) {
    console.error('Failed to open external link', error);
  }
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

function buildZoneBandRect(
  low: number | null | undefined,
  high: number | null | undefined,
  chartHeight: number,
  minValue: number,
  maxValue: number,
) {
  if (low === null || low === undefined || high === null || high === undefined) {
    return null;
  }

  const top = renderChartY(high, chartHeight, minValue, maxValue);
  const bottom = renderChartY(low, chartHeight, minValue, maxValue);
  return {
    y: Math.min(top, bottom),
    height: Math.max(8, Math.abs(bottom - top)),
  };
}

function StaticAnalyticsChart({
  itemName,
  analytics,
  loading,
  revealed,
  errorMessage,
  domain,
  bucket,
  onDomainChange,
  onBucketChange,
}: {
  itemName: string;
  analytics: ItemAnalyticsResponse | null;
  loading: boolean;
  revealed: boolean;
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
  const visibleLineSeries = visibleSeries.filter(
    (series) => series.key !== 'entryZone' && series.key !== 'exitZone',
  );
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
  const entryBand = buildZoneBandRect(
    analytics?.entryExitZoneOverview.entryZoneLow,
    analytics?.entryExitZoneOverview.entryZoneHigh,
    pricePlotHeight,
    minValue,
    maxValue,
  );
  const chartLoading = loading || !revealed;
  const exitBand = buildZoneBandRect(
    analytics?.entryExitZoneOverview.exitZoneLow,
    analytics?.entryExitZoneOverview.exitZoneHigh,
    pricePlotHeight,
    minValue,
    maxValue,
  );

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
      <div className="card-body market-panel-body">
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
            {errorMessage && !chartLoading ? (
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

                {seriesToggles.entryZone && entryBand ? (
                  <rect
                    className="market-chart-band market-chart-band-entry"
                    x="0"
                    y={entryBand.y}
                    width={plotWidth}
                    height={entryBand.height}
                    rx="8"
                  />
                ) : null}
                {seriesToggles.exitZone && exitBand ? (
                  <rect
                    className="market-chart-band market-chart-band-exit"
                    x="0"
                    y={exitBand.y}
                    width={plotWidth}
                    height={exitBand.height}
                    rx="8"
                  />
                ) : null}

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

                {visibleLineSeries.map((series) => (
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
        <PanelOverlay
          loading={chartLoading}
          errorMessage={!chartLoading ? errorMessage : null}
          label="Loading chart history"
        />
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
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }

  return `${Math.round(value)} pt`;
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

function formatDateCompact(value: string | null | undefined): string {
  if (!value) {
    return '—';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(parsed);
}

function formatNullableBoolean(value: boolean | null | undefined): string {
  if (value === null || value === undefined) {
    return '—';
  }

  return value ? 'Yes' : 'No';
}

function normalizeMatchValue(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');

  return normalized || null;
}

function containsItemMatch(haystack: string | null | undefined, needles: string[]): boolean {
  const normalizedHaystack = normalizeMatchValue(haystack);
  if (!normalizedHaystack) {
    return false;
  }

  return needles.some((needle) => normalizedHaystack.includes(needle));
}

interface EventContextEntry {
  label: string;
  impact: string;
}

function buildEventContextEntries(
  analysis: ItemAnalysisResponse | null,
  eventData: {
    alerts: ReturnType<typeof useAppStore.getState>['worldStateAlerts'];
    events: ReturnType<typeof useAppStore.getState>['worldStateEvents'];
    invasions: ReturnType<typeof useAppStore.getState>['worldStateInvasions'];
    syndicateMissions: ReturnType<typeof useAppStore.getState>['worldStateSyndicateMissions'];
    voidTrader: ReturnType<typeof useAppStore.getState>['worldStateVoidTrader'];
    flashSales: ReturnType<typeof useAppStore.getState>['worldStateFlashSales'];
  },
): EventContextEntry[] {
  if (!analysis) {
    return [];
  }

  const matchNeedles = [
    normalizeMatchValue(analysis.itemDetails.name),
    normalizeMatchValue(analysis.itemDetails.slug.replace(/_/g, ' ')),
  ].filter((value): value is string => Boolean(value));

  const entries: EventContextEntry[] = [];

  for (const alert of eventData.alerts) {
    const rewardItems = alert.mission?.reward?.items ?? [];
    if (rewardItems.some((item) => containsItemMatch(item, matchNeedles))) {
      entries.push({
        label: 'Alert Reward',
        impact: `${alert.mission?.node ?? 'Unknown node'} is currently rewarding this item.`,
      });
    }
  }

  for (const event of eventData.events) {
    const rewardItems = event.rewards.flatMap((reward) => reward.items);
    if (rewardItems.some((item) => containsItemMatch(item, matchNeedles))) {
      entries.push({
        label: 'Active Event',
        impact: `${event.description} currently includes this item in its reward pool.`,
      });
    }
  }

  for (const invasion of eventData.invasions) {
    const rewardItems = [
      ...(invasion.attacker.reward?.items ?? []),
      ...(invasion.defender.reward?.items ?? []),
    ];
    if (rewardItems.some((item) => containsItemMatch(item, matchNeedles))) {
      entries.push({
        label: 'Invasion Reward',
        impact: `${invasion.node ?? 'Unknown node'} currently offers this item through invasion rewards.`,
      });
    }
  }

  for (const mission of eventData.syndicateMissions) {
    const rewardItems = mission.jobs.flatMap((job) => job.rewardPool);
    if (rewardItems.some((item) => containsItemMatch(item, matchNeedles))) {
      entries.push({
        label: 'Syndicate Mission',
        impact: `${mission.syndicate ?? 'Syndicate'} currently has a mission reward pool that includes this item.`,
      });
    }
  }

  if (
    eventData.voidTrader?.inventory.some((entry) =>
      containsItemMatch(entry.item, matchNeedles),
    )
  ) {
    entries.push({
      label: 'Void Trader',
      impact: 'Baro Ki’Teer is currently selling this item, which can pressure short-term pricing.',
    });
  }

  if (
    eventData.flashSales.some((entry) =>
      containsItemMatch(entry.item, matchNeedles),
    )
  ) {
    entries.push({
      label: 'Flash Sale',
      impact: 'A flash sale is active for this item, which can distort short-term market behavior.',
    });
  }

  return entries;
}

function EmptyAnalyticsState({ body }: { body: string }) {
  return (
    <div className="market-empty-state">
      <span className="empty-primary">Analytics is ready when the market selection is ready</span>
      <span className="empty-sub">{body}</span>
    </div>
  );
}

function PanelOverlay({
  loading,
  errorMessage,
  label,
}: {
  loading: boolean;
  errorMessage?: string | null;
  label: string;
}) {
  if (!loading && !errorMessage) {
    return null;
  }

  return (
    <div className={`market-panel-overlay${errorMessage ? ' is-error' : ''}`}>
      {loading ? <span className="market-panel-spinner" aria-hidden="true" /> : null}
      <span className="market-panel-overlay-copy">
        {errorMessage ?? label}
      </span>
    </div>
  );
}

function AnalyticsPanel({
  title,
  eyebrow,
  children,
  loading = false,
  errorMessage = null,
  loadingLabel = 'Loading panel',
}: {
  title: string;
  eyebrow: string;
  children: ReactNode;
  loading?: boolean;
  errorMessage?: string | null;
  loadingLabel?: string;
}) {
  return (
    <div className="card market-panel">
      <div className="card-header">
        <div className="market-panel-header">
          <span className="panel-title-eyebrow">{eyebrow}</span>
          <span className="card-label">{title}</span>
        </div>
      </div>
      <div className="card-body market-panel-body">
        {children}
        <PanelOverlay loading={loading} errorMessage={errorMessage} label={loadingLabel} />
      </div>
    </div>
  );
}

function AnalyticsTab() {
  const pageContentRef = useRef<HTMLDivElement | null>(null);
  const revealTimeoutsRef = useRef<number[]>([]);
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
  const [revealedPanels, setRevealedPanels] = useState<Record<AnalyticsPanelKey, boolean>>(
    () => createRevealState(ANALYTICS_PANEL_SEQUENCE),
  );

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
    if (!selectedItem || !selectedMarketVariantKey) {
      clearRevealTimeouts(revealTimeoutsRef);
      setAnalytics(null);
      setLoading(false);
      setErrorMessage(null);
      setRevealedPanels(createRevealState(ANALYTICS_PANEL_SEQUENCE));
      return;
    }

    let isMounted = true;
    clearRevealTimeouts(revealTimeoutsRef);
    setLoading(true);
    setErrorMessage(null);
    setAnalytics(null);
    setRevealedPanels(createRevealState(ANALYTICS_PANEL_SEQUENCE));

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
        queuePanelReveal(ANALYTICS_PANEL_SEQUENCE, setRevealedPanels, revealTimeoutsRef);
      })
      .catch((error) => {
        if (!isMounted) {
          return;
        }
        setAnalytics(null);
        setLoading(false);
        setErrorMessage(error instanceof Error ? error.message : String(error));
        clearRevealTimeouts(revealTimeoutsRef);
      });

    return () => {
      isMounted = false;
      clearRevealTimeouts(revealTimeoutsRef);
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
        revealed={revealedPanels.chart}
        errorMessage={errorMessage}
        domain={chartDomain}
        bucket={chartBucket}
        onDomainChange={setChartDomain}
        onBucketChange={setChartBucket}
      />
      <div className="market-analytics-grid">
            <AnalyticsPanel
              title="Entry / Exit Zone Overview"
              eyebrow="Market State"
              loading={!revealedPanels.overview && !errorMessage}
              errorMessage={!revealedPanels.overview ? errorMessage : null}
              loadingLabel="Calculating entry and exit zones"
            >
              <div className="market-metric-grid">
                <div className="market-metric-card">
                  <span className="market-metric-label">Current Lowest</span>
                  <span className="market-metric-value">{formatPrice(analytics?.entryExitZoneOverview.currentLowestPrice)}</span>
                </div>
                <div className="market-metric-card">
                  <span className="market-metric-label">Median Lowest</span>
                  <span className="market-metric-value">{formatPrice(analytics?.entryExitZoneOverview.currentMedianLowestPrice)}</span>
                </div>
                <div className="market-metric-card">
                  <span className="market-metric-label">Fair Value Band</span>
                  <span className="market-metric-value">
                    {formatPrice(analytics?.entryExitZoneOverview.fairValueLow)} - {formatPrice(analytics?.entryExitZoneOverview.fairValueHigh)}
                  </span>
                </div>
                <div className="market-metric-card">
                  <span className="market-metric-label">Zone Quality</span>
                  <span className="market-metric-value">{analytics?.entryExitZoneOverview.zoneQuality ?? '—'}</span>
                </div>
              </div>
              <div className="market-copy-block">
                <span className="market-copy-title">Entry Zone</span>
                <span>
                  {formatPrice(analytics?.entryExitZoneOverview.entryZoneLow)} - {formatPrice(analytics?.entryExitZoneOverview.entryZoneHigh)}
                </span>
                <p>{analytics?.entryExitZoneOverview.entryRationale ?? '—'}</p>
              </div>
              <div className="market-copy-block">
                <span className="market-copy-title">Exit Zone</span>
                <span>
                  {formatPrice(analytics?.entryExitZoneOverview.exitZoneLow)} - {formatPrice(analytics?.entryExitZoneOverview.exitZoneHigh)}
                </span>
                <p>{analytics?.entryExitZoneOverview.exitRationale ?? '—'}</p>
              </div>
            </AnalyticsPanel>

            <AnalyticsPanel
              title="Orderbook Pressure"
              eyebrow="Execution"
              loading={!revealedPanels.pressure && !errorMessage}
              errorMessage={!revealedPanels.pressure ? errorMessage : null}
              loadingLabel="Reading current orderbook pressure"
            >
              <div className="market-metric-grid">
                <div className="market-metric-card">
                  <span className="market-metric-label">Cheapest Sell</span>
                  <span className="market-metric-value">{formatPrice(analytics?.orderbookPressure.cheapestSell)}</span>
                </div>
                <div className="market-metric-card">
                  <span className="market-metric-label">Highest Buy</span>
                  <span className="market-metric-value">{formatPrice(analytics?.orderbookPressure.highestBuy)}</span>
                </div>
                <div className="market-metric-card">
                  <span className="market-metric-label">Spread</span>
                  <span className="market-metric-value">
                    {formatPrice(analytics?.orderbookPressure.spread)} · {formatPercent(analytics?.orderbookPressure.spreadPct)}
                  </span>
                </div>
                <div className="market-metric-card">
                  <span className="market-metric-label">Pressure</span>
                  <span className="market-metric-value">{analytics?.orderbookPressure.pressureLabel ?? '—'}</span>
                </div>
              </div>
              <div className="market-pressure-row">
                <div>
                  <span className="market-copy-title">Entry Depth</span>
                  <span>{formatNumber(analytics?.orderbookPressure.entryDepth, 0)} visible quantity</span>
                </div>
                <div>
                  <span className="market-copy-title">Exit Depth</span>
                  <span>{formatNumber(analytics?.orderbookPressure.exitDepth, 0)} visible quantity</span>
                </div>
                <div>
                  <span className="market-copy-title">Pressure Ratio</span>
                  <span>{formatNumber(analytics?.orderbookPressure.pressureRatio, 2)}</span>
                </div>
              </div>
            </AnalyticsPanel>

            <AnalyticsPanel
              title="Trend Quality Breakdown"
              eyebrow="Structure"
              loading={!revealedPanels.trend && !errorMessage}
              errorMessage={!revealedPanels.trend ? errorMessage : null}
              loadingLabel="Scoring short-term trend quality"
            >
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
              <div className="market-metric-grid">
                <div className="market-metric-card">
                  <span className="market-metric-label">1H Slope</span>
                  <span className="market-metric-value">{formatPercent(trendMetrics?.slope1h)}</span>
                </div>
                <div className="market-metric-card">
                  <span className="market-metric-label">3H Slope</span>
                  <span className="market-metric-value">{formatPercent(trendMetrics?.slope3h)}</span>
                </div>
                <div className="market-metric-card">
                  <span className="market-metric-label">6H Slope</span>
                  <span className="market-metric-value">{formatPercent(trendMetrics?.slope6h)}</span>
                </div>
                <div className="market-metric-card">
                  <span className="market-metric-label">Confidence</span>
                  <span className="market-metric-value">{formatPercent(trendMetrics?.confidence)}</span>
                </div>
              </div>
              <div className="market-copy-block">
                <span className="market-copy-title">Cross Signal</span>
                <p>{trendMetrics?.crossSignal ?? '—'}</p>
              </div>
              <div className="market-copy-block">
                <span className="market-copy-title">Reversal</span>
                <p>{trendMetrics?.reversal ?? '—'}</p>
              </div>
              <div className="market-signal-list">
                {(trendMetrics?.confirmingSignals ?? []).map((signal) => (
                  <span key={signal} className="market-signal-pill">{signal}</span>
                ))}
              </div>
              <div className="market-pressure-row">
                <div>
                  <span className="market-copy-title">Stability</span>
                  <span>{formatPercent(analytics?.trendQualityBreakdown.stability)}</span>
                </div>
                <div>
                  <span className="market-copy-title">Volatility</span>
                  <span>{formatPercent(analytics?.trendQualityBreakdown.volatility)}</span>
                </div>
                <div>
                  <span className="market-copy-title">Noise</span>
                  <span>{formatPercent(analytics?.trendQualityBreakdown.noise)}</span>
                </div>
              </div>
            </AnalyticsPanel>

            <AnalyticsPanel
              title="Action Card"
              eyebrow="Readout"
              loading={!revealedPanels.action && !errorMessage}
              errorMessage={!revealedPanels.action ? errorMessage : null}
              loadingLabel="Building the market readout"
            >
              <div className={`market-action-card tone-${analytics?.actionCard.tone ?? 'neutral'}`}>
                <div className="market-action-header">
                  <span className="market-action-label">Suggested Action</span>
                  <span className="market-action-value">{analytics?.actionCard.suggestedAction ?? '—'}</span>
                </div>
                <div className="market-metric-grid">
                  <div className="market-metric-card">
                    <span className="market-metric-label">Zone Quality</span>
                    <span className="market-metric-value">{analytics?.actionCard.zoneQuality ?? '—'}</span>
                  </div>
                  <div className="market-metric-card">
                    <span className="market-metric-label">Zone Adjusted Edge</span>
                    <span className="market-metric-value">{formatPrice(analytics?.actionCard.zoneAdjustedEdge)}</span>
                  </div>
                  <div className="market-metric-card">
                    <span className="market-metric-label">Spread</span>
                    <span className="market-metric-value">
                      {formatPrice(analytics?.actionCard.spread)} · {formatPercent(analytics?.actionCard.spreadPct)}
                    </span>
                  </div>
                  <div className="market-metric-card">
                    <span className="market-metric-label">Book Bias</span>
                    <span className="market-metric-value">{analytics?.actionCard.pressureLabel ?? '—'}</span>
                  </div>
                </div>
                <p className="market-action-rationale">{analytics?.actionCard.rationale ?? '—'}</p>
                <div className="market-signal-list">
                  {(analytics?.actionCard.alignedSignals ?? []).map((signal) => (
                    <span key={signal} className="market-signal-pill">{signal}</span>
                  ))}
                </div>
              </div>
            </AnalyticsPanel>
          </div>
    </div>
  );
}

function AnalysisTab() {
  const pageContentRef = useRef<HTMLDivElement | null>(null);
  const revealTimeoutsRef = useRef<number[]>([]);
  const selectedItem = useAppStore((state) => state.quickView.selectedItem);
  const marketVariants = useAppStore((state) => state.marketVariants);
  const marketVariantsLoading = useAppStore((state) => state.marketVariantsLoading);
  const marketVariantsError = useAppStore((state) => state.marketVariantsError);
  const selectedMarketVariantKey = useAppStore((state) => state.selectedMarketVariantKey);
  const setSelectedMarketVariantKey = useAppStore((state) => state.setSelectedMarketVariantKey);
  const addExplicitItemToWatchlist = useAppStore((state) => state.addExplicitItemToWatchlist);
  const worldStateAlerts = useAppStore((state) => state.worldStateAlerts);
  const worldStateEvents = useAppStore((state) => state.worldStateEvents);
  const worldStateInvasions = useAppStore((state) => state.worldStateInvasions);
  const worldStateSyndicateMissions = useAppStore((state) => state.worldStateSyndicateMissions);
  const worldStateVoidTrader = useAppStore((state) => state.worldStateVoidTrader);
  const worldStateFlashSales = useAppStore((state) => state.worldStateFlashSales);
  const [analysis, setAnalysis] = useState<ItemAnalysisResponse | null>(null);
  const [itemDetails, setItemDetails] = useState<ItemDetailSummary | null>(null);
  const [itemDetailsLoading, setItemDetailsLoading] = useState(false);
  const [itemDetailsError, setItemDetailsError] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [componentTargets, setComponentTargets] = useState<Record<string, string>>({});
  const [revealedPanels, setRevealedPanels] = useState<Record<AnalysisPanelKey, boolean>>(
    () => ({
      ...createRevealState(ANALYSIS_PANEL_SEQUENCE),
      itemDetails: false,
    }),
  );

  useEffect(() => {
    pageContentRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [selectedItem?.itemId, selectedMarketVariantKey]);

  useEffect(() => {
    if (!selectedItem || !selectedMarketVariantKey) {
      clearRevealTimeouts(revealTimeoutsRef);
      setAnalysis(null);
      setItemDetails(null);
      setItemDetailsLoading(false);
      setItemDetailsError(null);
      setErrorMessage(null);
      setComponentTargets({});
      setRevealedPanels({
        ...createRevealState(ANALYSIS_PANEL_SEQUENCE),
        itemDetails: false,
      });
      return;
    }

    let isMounted = true;
    clearRevealTimeouts(revealTimeoutsRef);
    setAnalysis(null);
    setItemDetails(null);
    setItemDetailsLoading(true);
    setItemDetailsError(null);
    setErrorMessage(null);
    setComponentTargets({});
    setRevealedPanels({
      ...createRevealState(ANALYSIS_PANEL_SEQUENCE),
      itemDetails: false,
    });

    void getItemDetailSummary(selectedItem.itemId, selectedItem.slug)
      .then((response) => {
        if (!isMounted) {
          return;
        }
        setItemDetails(response);
        setItemDetailsLoading(false);
        setItemDetailsError(null);
        setRevealedPanels((current) => ({
          ...current,
          itemDetails: true,
        }));
      })
      .catch((error) => {
        if (!isMounted) {
          return;
        }
        setItemDetails(null);
        setItemDetailsLoading(false);
        setItemDetailsError(error instanceof Error ? error.message : String(error));
      });

    void ensureMarketTracking(
      selectedItem.itemId,
      selectedItem.slug,
      selectedMarketVariantKey,
      'analytics',
    )
      .then(() => getItemAnalysis(selectedItem.itemId, selectedItem.slug, selectedMarketVariantKey))
      .then((response) => {
        if (!isMounted) {
          return;
        }

        setAnalysis(response);
        if (!itemDetails) {
          setItemDetails(response.itemDetails);
          setItemDetailsLoading(false);
          setItemDetailsError(null);
          setRevealedPanels((current) => ({
            ...current,
            itemDetails: true,
          }));
        }
        setComponentTargets(
          Object.fromEntries(
            response.supplyContext.components.map((component) => [
              component.slug,
              `${Math.round(component.recommendedEntryPrice ?? component.currentLowestPrice ?? 0)}`,
            ]),
          ),
        );
        setErrorMessage(null);
        queuePanelReveal(ANALYSIS_PANEL_SEQUENCE, setRevealedPanels, revealTimeoutsRef);
      })
      .catch((error) => {
        if (!isMounted) {
          return;
        }
        setAnalysis(null);
        setErrorMessage(error instanceof Error ? error.message : String(error));
        clearRevealTimeouts(revealTimeoutsRef);
      });

    return () => {
      isMounted = false;
      clearRevealTimeouts(revealTimeoutsRef);
    };
  }, [selectedItem, selectedMarketVariantKey, refreshNonce]);

  const eventContextEntries = buildEventContextEntries(analysis, {
    alerts: worldStateAlerts,
    events: worldStateEvents,
    invasions: worldStateInvasions,
    syndicateMissions: worldStateSyndicateMissions,
    voidTrader: worldStateVoidTrader,
    flashSales: worldStateFlashSales,
  });

  if (!selectedItem) {
    return (
      <div className="page-content">
        <EmptyAnalyticsState body="Use the global search to select a WFM item, then this page will build a trading analysis from live orders, observatory snapshots, and item-catalog context." />
      </div>
    );
  }

  if (marketVariantsLoading) {
    return (
      <div className="page-content">
        <EmptyAnalyticsState body="Loading market variants before building the analysis model." />
      </div>
    );
  }

  if (marketVariants.length > 1 && !selectedMarketVariantKey) {
    return (
      <div className="page-content">
        <EmptyAnalyticsState body="Pick the correct market variant first so the analysis never mixes rank-specific orders." />
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

  const effectiveItemDetails = itemDetails ?? analysis?.itemDetails ?? null;
  const itemImageUrl = resolveWfmAssetUrl(effectiveItemDetails?.imagePath);

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
          <span>Snapshot {formatRelativeTimestamp(analysis?.sourceSnapshotAt ?? null)}</span>
          <span>Stats {formatRelativeTimestamp(analysis?.sourceStatsFetchedAt ?? null)}</span>
          <span>Computed {formatRelativeTimestamp(analysis?.computedAt ?? null)}</span>
        </div>
      </div>
      <div className="market-analysis-shell">
          <div className="market-analysis-main">
            <div className="market-summary-grid-shell">
              <div className="market-analysis-summary-grid">
              <div className="market-summary-card">
                <span className="market-summary-label">Entry Price</span>
                <span className="market-summary-value">{formatPrice(analysis?.headline.entryPrice)}</span>
              </div>
              <div className="market-summary-card">
                <span className="market-summary-label">Exit Price ({analysis?.headline.exitPercentileLabel ?? 'P60'})</span>
                <span className="market-summary-value">{formatPrice(analysis?.headline.exitPrice)}</span>
              </div>
              <div className="market-summary-card">
                <span className="market-summary-label">Net Margin</span>
                <span className="market-summary-value">{formatPrice(analysis?.headline.netMargin)}</span>
              </div>
              <div className="market-summary-card">
                <span className="market-summary-label">Liquidity</span>
                <span className="market-summary-value">
                  {formatPercent(analysis?.headline.liquidityScore)} · {analysis?.headline.liquidityLabel ?? '—'}
                </span>
              </div>
            </div>
              <PanelOverlay
                loading={!revealedPanels.headline && !errorMessage}
                errorMessage={!revealedPanels.headline ? errorMessage : null}
                label="Building headline metrics"
              />
            </div>

            <div className="market-analysis-grid">
              <AnalyticsPanel
                title="Flip Analysis"
                eyebrow="Execution Model"
                loading={!revealedPanels.flip && !errorMessage}
                errorMessage={!revealedPanels.flip ? errorMessage : null}
                loadingLabel="Calculating flip margins"
              >
                <div className="market-metric-grid">
                  <div className="market-metric-card">
                    <span className="market-metric-label">Entry Price</span>
                    <span className="market-metric-value">{formatPrice(analysis?.flipAnalysis.entryPrice)}</span>
                  </div>
                  <div className="market-metric-card">
                    <span className="market-metric-label">Exit Price</span>
                    <span className="market-metric-value">{formatPrice(analysis?.flipAnalysis.exitPrice)}</span>
                  </div>
                  <div className="market-metric-card">
                    <span className="market-metric-label">Gross Margin</span>
                    <span className="market-metric-value">{formatPrice(analysis?.flipAnalysis.grossMargin)}</span>
                  </div>
                  <div className="market-metric-card">
                    <span className="market-metric-label">Net Margin</span>
                    <span className="market-metric-value">{formatPrice(analysis?.flipAnalysis.netMargin)}</span>
                  </div>
                  <div className="market-metric-card">
                    <span className="market-metric-label">Efficiency Score</span>
                    <span className="market-metric-value">
                      {formatPercent(analysis?.flipAnalysis.efficiencyScore)} · {analysis?.flipAnalysis.efficiencyLabel ?? '—'}
                    </span>
                  </div>
                </div>
              </AnalyticsPanel>

              <AnalyticsPanel
                title="Liquidity Detail"
                eyebrow="Market Structure"
                loading={!revealedPanels.liquidity && !errorMessage}
                errorMessage={!revealedPanels.liquidity ? errorMessage : null}
                loadingLabel="Profiling live liquidity"
              >
                <div className="market-metric-grid">
                  <div className="market-metric-card">
                    <span className="market-metric-label">Demand Ratio</span>
                    <span className="market-metric-value">{formatNumber(analysis?.liquidityDetail.demandRatio, 2)}</span>
                  </div>
                  <div className="market-metric-card">
                    <span className="market-metric-label">State</span>
                    <span className="market-metric-value">{analysis?.liquidityDetail.state ?? '—'}</span>
                  </div>
                  <div className="market-metric-card">
                    <span className="market-metric-label">Sellers Within +2pt</span>
                    <span className="market-metric-value">{formatNumber(analysis?.liquidityDetail.sellersWithinTwoPt, 0)}</span>
                  </div>
                  <div className="market-metric-card">
                    <span className="market-metric-label">Undercut Velocity</span>
                    <span className="market-metric-value">{formatNumber(analysis?.liquidityDetail.undercutVelocity, 2)} / h</span>
                  </div>
                  <div className="market-metric-card">
                    <span className="market-metric-label">Qty-Weighted Demand</span>
                    <span className="market-metric-value">{formatPercent(analysis?.liquidityDetail.quantityWeightedDemand)}</span>
                  </div>
                  <div className="market-metric-card">
                    <span className="market-metric-label">Liquidity</span>
                    <span className="market-metric-value">{formatPercent(analysis?.liquidityDetail.liquidityScore)}</span>
                  </div>
                </div>
              </AnalyticsPanel>

              <AnalyticsPanel
                title="Trend"
                eyebrow="Analytics Carryover"
                loading={!revealedPanels.trend && !errorMessage}
                errorMessage={!revealedPanels.trend ? errorMessage : null}
                loadingLabel="Summarizing the current trend"
              >
                <div className="market-metric-grid">
                  <div className="market-metric-card">
                    <span className="market-metric-label">Direction</span>
                    <span className="market-metric-value">{analysis?.trend.direction ?? '—'}</span>
                  </div>
                  <div className="market-metric-card">
                    <span className="market-metric-label">Confidence</span>
                    <span className="market-metric-value">{formatPercent(analysis?.trend.confidence)}</span>
                  </div>
                  <div className="market-metric-card">
                    <span className="market-metric-label">1H Slope</span>
                    <span className="market-metric-value">{formatPercent(analysis?.trend.slope1h)}</span>
                  </div>
                  <div className="market-metric-card">
                    <span className="market-metric-label">3H Slope</span>
                    <span className="market-metric-value">{formatPercent(analysis?.trend.slope3h)}</span>
                  </div>
                  <div className="market-metric-card">
                    <span className="market-metric-label">6H Slope</span>
                    <span className="market-metric-value">{formatPercent(analysis?.trend.slope6h)}</span>
                  </div>
                </div>
                <div className="market-copy-block">
                  <span className="market-copy-title">Summary</span>
                  <p>{analysis?.trend.summary ?? '—'}</p>
                </div>
              </AnalyticsPanel>

              <AnalyticsPanel
                title="Event Context"
                eyebrow="World State"
                loading={!revealedPanels.eventContext && !errorMessage}
                errorMessage={!revealedPanels.eventContext ? errorMessage : null}
                loadingLabel="Matching worldstate context"
              >
                {eventContextEntries.length > 0 ? (
                  <div className="market-context-list">
                    {eventContextEntries.map((entry) => (
                      <div key={`${entry.label}-${entry.impact}`} className="market-context-card">
                        <span className="market-copy-title">{entry.label}</span>
                        <p>{entry.impact}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="market-copy-block">
                    <span className="market-copy-title">No active context</span>
                    <p>No current worldstate rewards or live event hooks are matching this item right now.</p>
                  </div>
                )}
              </AnalyticsPanel>

              <AnalyticsPanel
                title="Manipulation Risk"
                eyebrow="Safety"
                loading={!revealedPanels.manipulation && !errorMessage}
                errorMessage={!revealedPanels.manipulation ? errorMessage : null}
                loadingLabel="Scanning manipulation signals"
              >
                <div className="market-metric-grid">
                  <div className="market-metric-card">
                    <span className="market-metric-label">Risk Level</span>
                    <span className="market-metric-value">{analysis?.manipulationRisk.riskLevel ?? '—'}</span>
                  </div>
                  <div className="market-metric-card">
                    <span className="market-metric-label">Active Signals</span>
                    <span className="market-metric-value">{formatNumber(analysis?.manipulationRisk.activeSignals, 0)}</span>
                  </div>
                  <div className="market-metric-card">
                    <span className="market-metric-label">Efficiency Penalty</span>
                    <span className="market-metric-value">{formatPercent(analysis?.manipulationRisk.efficiencyPenaltyPct)}</span>
                  </div>
                </div>
                <div className="market-analysis-signal-list">
                  {(analysis?.manipulationRisk.signals ?? []).map((signal) => (
                    <div
                      key={signal.key}
                      className={`market-analysis-signal-card${signal.active ? ' active' : ''}`}
                    >
                      <span className="market-copy-title">{signal.label}</span>
                      <span className="market-analysis-signal-state">
                        {signal.active ? 'Active' : 'Clear'}
                      </span>
                      <p>{signal.detail}</p>
                    </div>
                  ))}
                </div>
              </AnalyticsPanel>

              <AnalyticsPanel
                title="Time of Day Liquidity"
                eyebrow="Observatory Tape"
                loading={!revealedPanels.timeOfDay && !errorMessage}
                errorMessage={!revealedPanels.timeOfDay ? errorMessage : null}
                loadingLabel="Aggregating observatory tape"
              >
                <div className="market-pressure-row">
                  <div>
                    <span className="market-copy-title">Current Hour</span>
                    <span>{analysis?.timeOfDayLiquidity.currentHourLabel ?? '—'}</span>
                  </div>
                  <div>
                    <span className="market-copy-title">Strongest Window</span>
                    <span>{analysis?.timeOfDayLiquidity.strongestWindowLabel ?? '—'}</span>
                  </div>
                  <div>
                    <span className="market-copy-title">Weakest Window</span>
                    <span>{analysis?.timeOfDayLiquidity.weakestWindowLabel ?? '—'}</span>
                  </div>
                </div>
                <div className="market-time-grid">
                  {(analysis?.timeOfDayLiquidity.buckets ?? []).map((bucket) => (
                    <div key={bucket.hour} className="market-time-card">
                      <span className="market-copy-title">{bucket.label}</span>
                      <span>{formatNumber(bucket.avgVisibleQuantity, 0)} visible qty</span>
                      <span>{formatNumber(bucket.avgSellOrders, 1)} avg sell orders</span>
                      <span>Spread {formatPercent(bucket.avgSpreadPct)}</span>
                    </div>
                  ))}
                </div>
              </AnalyticsPanel>

              <AnalyticsPanel
                title={
                  analysis?.supplyContext.mode === 'set-components'
                    ? 'Set Components'
                    : analysis?.supplyContext.mode === 'drop-sources'
                      ? 'Drop Sources'
                      : 'Drop Sources / Set Components'
                }
                eyebrow="Supply Context"
                loading={!revealedPanels.supply && !errorMessage}
                errorMessage={!revealedPanels.supply ? errorMessage : null}
                loadingLabel="Building supply context"
              >
                {analysis?.supplyContext.mode === 'set-components' ? (
                  <div className="market-component-list">
                    {(analysis?.supplyContext.components ?? []).map((component) => {
                      const imageUrl = resolveWfmAssetUrl(component.imagePath);
                      const targetValue = componentTargets[component.slug] ?? '';
                      const watchlistItem: WfmAutocompleteItem | null =
                        component.itemId !== null
                          ? {
                              itemId: component.itemId,
                              name: component.name,
                              slug: component.slug,
                              maxRank: null,
                              itemFamily: null,
                              imagePath: component.imagePath,
                            }
                          : null;

                      return (
                        <div key={component.slug} className="market-component-card">
                          <div className="market-component-main">
                            {imageUrl ? (
                              <img
                                className="market-component-image"
                                src={imageUrl}
                                alt={component.name}
                              />
                            ) : (
                              <div className="market-component-image placeholder" />
                            )}
                            <div className="market-component-copy">
                              <span className="market-copy-title">{component.name}</span>
                              <span>Current lowest: {formatPrice(component.currentLowestPrice)}</span>
                              <span>Recommended entry: {formatPrice(component.recommendedEntryPrice)}</span>
                            </div>
                          </div>
                          <div className="market-component-actions">
                            <input
                              className="price-input"
                              type="number"
                              min="0"
                              step="1"
                              value={targetValue}
                              onChange={(event) =>
                                setComponentTargets((current) => ({
                                  ...current,
                                  [component.slug]: event.target.value,
                                }))
                              }
                            />
                            <button
                              className="btn-sm"
                              type="button"
                              disabled={!watchlistItem}
                              onClick={() => {
                                if (!watchlistItem) {
                                  return;
                                }
                                addExplicitItemToWatchlist(
                                  watchlistItem,
                                  component.variantKey,
                                  component.variantLabel,
                                  Number.parseInt(targetValue || '0', 10),
                                );
                              }}
                            >
                              Add to Watchlist
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : analysis?.supplyContext.mode === 'drop-sources' ? (
                  <div className="market-drop-list">
                    {(analysis?.supplyContext.dropSources ?? []).map((source) => (
                      <div key={`${source.location}-${source.sourceType ?? 'none'}`} className="market-drop-card">
                        <span className="market-copy-title">{source.location}</span>
                        <span>Chance: {formatPercent(source.chance)}</span>
                        <span>Rarity: {source.rarity ?? '—'}</span>
                        <span>Type: {source.sourceType ?? '—'}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="market-copy-block">
                    <span className="market-copy-title">No supply context</span>
                    <p>This item does not currently have set-component or catalog drop-source data available.</p>
                  </div>
                )}
              </AnalyticsPanel>
            </div>
          </div>

          <aside className="market-analysis-sidebar">
            <AnalyticsPanel
              title="Item Details"
              eyebrow="Reference"
              loading={itemDetailsLoading || (!revealedPanels.itemDetails && !itemDetailsError)}
              errorMessage={itemDetailsError}
              loadingLabel="Loading item details from the local catalog"
            >
              <div className="market-item-detail-card">
                {itemImageUrl ? (
                  <img
                    className="market-item-detail-image"
                    src={itemImageUrl}
                    alt={effectiveItemDetails?.name ?? selectedItem.name}
                  />
                ) : (
                  <div className="market-item-detail-image placeholder" />
                )}
                <div className="market-item-detail-copy">
                  <span className="market-item-detail-name">{effectiveItemDetails?.name ?? selectedItem.name}</span>
                  <span className="market-item-detail-slug">{effectiveItemDetails?.slug ?? selectedItem.slug}</span>
                  {effectiveItemDetails?.wikiLink ? (
                    <button
                      type="button"
                      className="market-item-detail-link"
                      onClick={() => {
                        void handleOpenExternalLink(effectiveItemDetails.wikiLink);
                      }}
                    >
                      Open Wiki
                  </button>
                  ) : null}
                </div>
              </div>
              {effectiveItemDetails?.description ? (
                <div className="market-copy-block">
                  <span className="market-copy-title">Description</span>
                  <p>{effectiveItemDetails.description}</p>
                </div>
              ) : null}
              {(effectiveItemDetails?.statHighlights.length ?? 0) > 0 ? (
                <div className="market-copy-block">
                  <span className="market-copy-title">
                    {effectiveItemDetails?.rankScaleLabel ?? 'Rank Scaling'}
                  </span>
                  <div className="market-detail-highlight-list">
                    {(effectiveItemDetails?.statHighlights ?? []).map((line) => (
                      <div key={line} className="market-detail-highlight">
                        {normalizeStatHighlightText(line).map((segment, segmentIndex) => (
                          <div key={`${line}-${segmentIndex}`} className="market-detail-highlight-line">
                            {renderStatHighlightLine(segment)}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="market-detail-grid">
                <div><span className="market-copy-title">Family</span><span>{effectiveItemDetails?.itemFamily ?? '—'}</span></div>
                <div><span className="market-copy-title">Category</span><span>{effectiveItemDetails?.category ?? '—'}</span></div>
                <div><span className="market-copy-title">Type</span><span>{effectiveItemDetails?.itemType ?? '—'}</span></div>
                <div><span className="market-copy-title">Rarity</span><span>{effectiveItemDetails?.rarity ?? '—'}</span></div>
                <div><span className="market-copy-title">Mastery</span><span>{formatNumber(effectiveItemDetails?.masteryReq, 0)}</span></div>
                <div><span className="market-copy-title">Max Rank</span><span>{formatNumber(effectiveItemDetails?.maxRank, 0)}</span></div>
                <div><span className="market-copy-title">Tradable</span><span>{formatNullableBoolean(effectiveItemDetails?.tradable)}</span></div>
                <div><span className="market-copy-title">Prime</span><span>{formatNullableBoolean(effectiveItemDetails?.prime)}</span></div>
                <div><span className="market-copy-title">Vaulted</span><span>{formatNullableBoolean(effectiveItemDetails?.vaulted)}</span></div>
                <div><span className="market-copy-title">Ducats</span><span>{formatNumber(effectiveItemDetails?.ducats, 0)}</span></div>
                <div><span className="market-copy-title">Release</span><span>{formatDateCompact(effectiveItemDetails?.releaseDate)}</span></div>
                <div><span className="market-copy-title">Est. Vault</span><span>{formatDateCompact(effectiveItemDetails?.estimatedVaultDate)}</span></div>
              </div>
              {(effectiveItemDetails?.tags.length ?? 0) > 0 ? (
                <div className="market-signal-list">
                  {(effectiveItemDetails?.tags ?? []).map((tag) => (
                    <span key={tag} className="market-signal-pill">{tag}</span>
                  ))}
                </div>
              ) : null}
            </AnalyticsPanel>
          </aside>
        </div>
    </div>
  );
}

export function MarketPage() {
  const marketSubTab = useAppStore((s) => s.marketSubTab);
  const setMarketSubTab = useAppStore((s) => s.setMarketSubTab);

  useEffect(() => {
    setMarketSubTab('analysis');
  }, [setMarketSubTab]);

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
