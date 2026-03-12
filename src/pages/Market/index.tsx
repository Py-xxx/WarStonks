import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, Dispatch, MutableRefObject, ReactNode, SetStateAction } from 'react';
import {
  ensureMarketTracking,
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
  MarketConfidenceSummary,
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

type PanelTone = 'neutral' | 'blue' | 'green' | 'amber' | 'red';

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

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toUnitInterval(value: number | null | undefined, fallback = 0): number {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return fallback;
  }
  return clampNumber(value > 1 ? value / 100 : value, 0, 1);
}

function ratioToUnitInterval(value: number | null | undefined): number {
  if (value === null || value === undefined || Number.isNaN(value) || value <= 0) {
    return 0;
  }
  return clampNumber(value / (value + 1), 0, 1);
}

function slopeToUnitInterval(value: number | null | undefined): number {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return 0.5;
  }
  return clampNumber(0.5 + value * 4, 0, 1);
}

function getRiskTone(riskLevel: string | null | undefined): PanelTone {
  const normalized = riskLevel?.toLowerCase() ?? '';
  if (normalized.includes('high') || normalized.includes('critical')) {
    return 'red';
  }
  if (normalized.includes('medium') || normalized.includes('elevated')) {
    return 'amber';
  }
  if (normalized.includes('low')) {
    return 'green';
  }
  return 'neutral';
}

function getTrendTone(direction: string | null | undefined): PanelTone {
  const normalized = direction?.toLowerCase() ?? '';
  if (normalized.includes('up') || normalized.includes('bull')) {
    return 'green';
  }
  if (normalized.includes('down') || normalized.includes('bear')) {
    return 'red';
  }
  if (normalized.includes('flat') || normalized.includes('side')) {
    return 'amber';
  }
  return 'blue';
}

function getConfidenceTone(confidence: MarketConfidenceSummary | null | undefined): PanelTone {
  switch (confidence?.level) {
    case 'high':
      return 'green';
    case 'medium':
      return 'amber';
    case 'low':
      return 'red';
    default:
      return 'neutral';
  }
}

function buildAnalysisHeroState(analysis: ItemAnalysisResponse | null) {
  const netMargin = analysis?.headline.netMargin ?? null;
  const liquidityScore = analysis?.headline.liquidityScore ?? null;
  const riskLevel = analysis?.manipulationRisk.riskLevel ?? null;
  const riskTone = getRiskTone(riskLevel);
  const trendTone = getTrendTone(analysis?.trend.direction);
  const confidence = analysis?.trend.confidence ?? null;
  const headlineConfidence = analysis?.headline.confidenceSummary ?? null;
  const confidenceNote = headlineConfidence?.reasons.length
    ? ` ${headlineConfidence.reasons.join(', ')}.`
    : '';

  if (netMargin === null || liquidityScore === null) {
    return {
      label: 'Building Readout',
      tone: 'blue' as PanelTone,
      note: 'The market posture will settle as live orders, observatory tape, and catalog context finish loading.',
    };
  }

  if (riskTone === 'red') {
    return {
      label: 'High Caution',
      tone: 'red' as PanelTone,
      note: `Risk is currently elevated, so any margin on the board should be discounted until the signal stack clears.${confidenceNote}`,
    };
  }

  if (headlineConfidence?.level === 'low') {
    return {
      label: 'Cautious Read',
      tone: 'amber' as PanelTone,
      note: `The current setup has usable context, but confidence is not strong enough to present an assertive posture.${confidenceNote}`,
    };
  }

  if (netMargin > 0 && liquidityScore >= 60 && trendTone === 'green') {
    return {
      label: 'Buy Bias',
      tone: 'green' as PanelTone,
      note: `Current spread supports an entry bias, with ${Math.round(liquidityScore)}% liquidity and ${Math.round(confidence ?? 0)}% trend confidence backing the setup.${confidenceNote}`,
    };
  }

  if (netMargin > 0 && liquidityScore >= 42) {
    return {
      label: 'Selective',
      tone: 'blue' as PanelTone,
      note: `There is usable edge here, but execution quality matters more than aggression because the market is not fully aligned yet.${confidenceNote}`,
    };
  }

  return {
    label: 'Wait',
    tone: 'amber' as PanelTone,
    note: `The current structure is not clean enough to justify forcing a trade. Let price or liquidity improve first.${confidenceNote}`,
  };
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

function formatDropChancePercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }

  if (value === 0) {
    return '<0.0001%';
  }

  const absValue = Math.abs(value);
  let digits = 1;
  if (absValue < 0.001) {
    digits = 4;
  } else if (absValue < 0.01) {
    digits = 3;
  } else if (absValue < 0.1) {
    digits = 2;
  }

  return `${formatNumber(value, digits)}%`;
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

function formatStatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }

  return `${formatNumber(value, digits)}%`;
}

function formatMultiplier(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }

  return `${formatNumber(value, 1)}x`;
}

function formatDurationSeconds(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }

  if (value < 60) {
    return `${formatNumber(value, 0)}s`;
  }

  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}m`;
}

interface ItemDetailField {
  label: string;
  value: string;
}

interface ItemDetailSection {
  title: string;
  fields: ItemDetailField[];
}

type ItemDetailKind =
  | 'mod'
  | 'arcane'
  | 'weapon'
  | 'warframe'
  | 'relic'
  | 'set'
  | 'component'
  | 'resource'
  | 'generic';

function hasMeaningfulDetail(value: string | null | undefined): value is string {
  return Boolean(value && value !== '—');
}

function pushDetailField(fields: ItemDetailField[], label: string, value: string) {
  if (hasMeaningfulDetail(value)) {
    fields.push({ label, value });
  }
}

function classifyItemDetail(detail: ItemDetailSummary | null): ItemDetailKind {
  if (!detail) {
    return 'generic';
  }

  const tags = new Set(detail.tags.map((tag) => tag.toLowerCase()));
  const family = detail.itemFamily?.toLowerCase() ?? '';
  const category = detail.category?.toLowerCase() ?? '';
  const type = detail.itemType?.toLowerCase() ?? '';
  const productCategory = detail.productCategory?.toLowerCase() ?? '';

  if (tags.has('arcane') || family.includes('arcane') || category.includes('arcane') || type.includes('arcane')) {
    return 'arcane';
  }
  if (tags.has('mod') || family.includes('mod') || category.includes('mod') || type.includes('mod')) {
    return 'mod';
  }
  if (family.includes('relic') || type.includes('relic') || category.includes('relic') || detail.relicTier || detail.relicCode) {
    return 'relic';
  }
  if (tags.has('set') || family.includes('set') || detail.name.endsWith(' Set')) {
    return 'set';
  }
  if (family.includes('warframe') || category.includes('warframe') || tags.has('warframe')) {
    return 'warframe';
  }
  if (
    family.includes('weapon')
    || category.includes('weapon')
    || productCategory.includes('weapon')
    || detail.totalDamage !== null
    || detail.criticalChance !== null
  ) {
    return tags.has('component') ? 'component' : 'weapon';
  }
  if (tags.has('component') || family.includes('component') || productCategory.includes('component')) {
    return 'component';
  }
  if (family.includes('resource') || category.includes('resource') || productCategory.includes('resource')) {
    return 'resource';
  }

  return 'generic';
}

function buildItemDetailSections(detail: ItemDetailSummary | null): ItemDetailSection[] {
  if (!detail) {
    return [];
  }

  const detailKind = classifyItemDetail(detail);
  const sections: ItemDetailSection[] = [];
  const overviewFields: ItemDetailField[] = [];

  pushDetailField(overviewFields, 'Category', detail.category ?? '—');
  pushDetailField(overviewFields, 'Rarity', detail.rarity ?? '—');
  pushDetailField(overviewFields, 'Prime', formatNullableBoolean(detail.prime));
  pushDetailField(overviewFields, 'Vaulted', formatNullableBoolean(detail.vaulted));
  if (overviewFields.length > 0) {
    sections.push({ title: 'Overview', fields: overviewFields });
  }

  if (detailKind === 'mod' || detailKind === 'arcane') {
    const upgradeFields: ItemDetailField[] = [];
    pushDetailField(upgradeFields, 'Compatibility', detail.compatName ?? '—');
    pushDetailField(upgradeFields, 'Polarity', detail.polarity ?? '—');
    pushDetailField(upgradeFields, 'Stance Polarity', detail.stancePolarity ?? '—');
    pushDetailField(upgradeFields, 'Mod Set', detail.modSet ?? '—');
    pushDetailField(upgradeFields, 'Base Drain', formatNumber(detail.baseDrain, 0));
    pushDetailField(upgradeFields, 'Fusion Limit', formatNumber(detail.fusionLimit, 0));
    pushDetailField(upgradeFields, 'Max Rank', formatNumber(detail.maxRank, 0));
    pushDetailField(upgradeFields, 'Mastery', formatNumber(detail.masteryReq, 0));
    if (upgradeFields.length > 0) {
      sections.push({ title: detailKind === 'arcane' ? 'Arcane Profile' : 'Mod Profile', fields: upgradeFields });
    }
  }

  if (detailKind === 'weapon' || detailKind === 'component') {
    const combatFields: ItemDetailField[] = [];
    pushDetailField(combatFields, 'Total Damage', formatNumber(detail.totalDamage, 1));
    pushDetailField(combatFields, 'Crit Chance', formatStatPercent(detail.criticalChance));
    pushDetailField(combatFields, 'Crit Mult', formatMultiplier(detail.criticalMultiplier));
    pushDetailField(combatFields, 'Status Chance', formatStatPercent(detail.statusChance));
    pushDetailField(combatFields, 'Fire Rate', formatNumber(detail.fireRate, 2));
    pushDetailField(combatFields, 'Reload', detail.reloadTime !== null ? `${formatNumber(detail.reloadTime, 2)}s` : '—');
    pushDetailField(combatFields, 'Magazine', formatNumber(detail.magazineSize, 0));
    pushDetailField(combatFields, 'Multishot', formatNumber(detail.multishot, 0));
    pushDetailField(combatFields, 'Disposition', formatNumber(detail.disposition, 0));
    pushDetailField(combatFields, 'Range', formatNumber(detail.range, 1));
    if (combatFields.length > 0) {
      sections.push({ title: detailKind === 'component' ? 'Component Combat' : 'Combat Stats', fields: combatFields });
    }

    const handlingFields: ItemDetailField[] = [];
    pushDetailField(handlingFields, 'Trigger', detail.trigger ?? '—');
    pushDetailField(handlingFields, 'Noise', detail.noise ?? '—');
    pushDetailField(handlingFields, 'Follow Through', formatNumber(detail.followThrough, 2));
    pushDetailField(handlingFields, 'Blocking Angle', formatNumber(detail.blockingAngle, 0));
    pushDetailField(handlingFields, 'Combo Duration', formatNumber(detail.comboDuration, 1));
    pushDetailField(handlingFields, 'Heavy Attack', formatNumber(detail.heavyAttackDamage, 0));
    pushDetailField(handlingFields, 'Slam Attack', formatNumber(detail.slamAttack, 0));
    pushDetailField(handlingFields, 'Heavy Slam', formatNumber(detail.heavySlamAttack, 0));
    pushDetailField(handlingFields, 'Wind Up', detail.windUp !== null ? `${formatNumber(detail.windUp, 2)}s` : '—');
    if (handlingFields.length > 0) {
      sections.push({ title: 'Handling', fields: handlingFields });
    }
  }

  if (detailKind === 'warframe') {
    const baseStatFields: ItemDetailField[] = [];
    pushDetailField(baseStatFields, 'Health', formatNumber(detail.health, 0));
    pushDetailField(baseStatFields, 'Shield', formatNumber(detail.shield, 0));
    pushDetailField(baseStatFields, 'Armor', formatNumber(detail.armor, 0));
    pushDetailField(baseStatFields, 'Sprint Speed', formatNumber(detail.sprintSpeed, 2));
    pushDetailField(baseStatFields, 'Power', formatNumber(detail.power, 0));
    pushDetailField(baseStatFields, 'Stamina', formatNumber(detail.stamina, 0));
    pushDetailField(baseStatFields, 'Mastery', formatNumber(detail.masteryReq, 0));
    if (baseStatFields.length > 0) {
      sections.push({ title: 'Base Stats', fields: baseStatFields });
    }

    const kitFields: ItemDetailField[] = [];
    pushDetailField(kitFields, 'Abilities', detail.abilityNames.length > 0 ? detail.abilityNames.join(', ') : '—');
    pushDetailField(kitFields, 'Polarities', detail.polarities.length > 0 ? detail.polarities.join(', ') : '—');
    if (kitFields.length > 0) {
      sections.push({ title: 'Kit', fields: kitFields });
    }
  }

  if (detailKind === 'relic') {
    const relicFields: ItemDetailField[] = [];
    pushDetailField(relicFields, 'Tier', detail.relicTier ?? '—');
    pushDetailField(relicFields, 'Code', detail.relicCode ?? '—');
    pushDetailField(relicFields, 'Release', formatDateCompact(detail.releaseDate));
    pushDetailField(relicFields, 'Est. Vault', formatDateCompact(detail.estimatedVaultDate));
    pushDetailField(relicFields, 'Vault Date', formatDateCompact(detail.vaultDate));
    pushDetailField(relicFields, 'Item Count', formatNumber(detail.itemCount, 0));
    if (relicFields.length > 0) {
      sections.push({ title: 'Relic Profile', fields: relicFields });
    }
  }

  if (detailKind === 'set') {
    const setFields: ItemDetailField[] = [];
    pushDetailField(setFields, 'Item Count', formatNumber(detail.itemCount, 0));
    pushDetailField(setFields, 'Release', formatDateCompact(detail.releaseDate));
    pushDetailField(setFields, 'Est. Vault', formatDateCompact(detail.estimatedVaultDate));
    pushDetailField(setFields, 'Vault Date', formatDateCompact(detail.vaultDate));
    pushDetailField(setFields, 'Ducats', formatNumber(detail.ducats, 0));
    if (setFields.length > 0) {
      sections.push({ title: 'Set Profile', fields: setFields });
    }
  }

  if (detailKind === 'component' || detailKind === 'resource' || detailKind === 'generic') {
    const profileFields: ItemDetailField[] = [];
    pushDetailField(profileFields, 'Product Category', detail.productCategory ?? '—');
    pushDetailField(profileFields, 'Parents', detail.parentNames.length > 0 ? detail.parentNames.join(', ') : '—');
    pushDetailField(profileFields, 'Build Price', formatNumber(detail.buildPrice, 0));
    pushDetailField(profileFields, 'Build Qty', formatNumber(detail.buildQuantity, 0));
    pushDetailField(profileFields, 'Build Time', formatDurationSeconds(detail.buildTime));
    pushDetailField(profileFields, 'Skip Build', formatNumber(detail.skipBuildTimePrice, 0));
    pushDetailField(profileFields, 'Market Cost', formatNumber(detail.marketCost, 0));
    pushDetailField(profileFields, 'Ducats', formatNumber(detail.ducats, 0));
    if (profileFields.length > 0) {
      sections.push({ title: detailKind === 'component' ? 'Component Profile' : 'Item Profile', fields: profileFields });
    }
  }

  if (detail.attackNames.length > 0 && (detailKind === 'weapon' || detailKind === 'component')) {
    sections.push({
      title: 'Attack Modes',
      fields: detail.attackNames.map((name, index) => ({
        label: `${index + 1}`,
        value: name,
      })),
    });
  }

  return sections;
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

function buildEventContextConfidence(entries: EventContextEntry[]): MarketConfidenceSummary {
  if (entries.length === 0) {
    return {
      level: 'low',
      label: 'Low confidence',
      reasons: ['No active context'],
      isDegraded: true,
    };
  }

  const hasDirectRetailHook = entries.some((entry) =>
    ['Void Trader', 'Flash Sale', 'Alert Reward', 'Invasion Reward'].includes(entry.label),
  );

  if (hasDirectRetailHook || entries.length >= 2) {
    return {
      level: 'high',
      label: 'High confidence',
      reasons: [],
      isDegraded: false,
    };
  }

  return {
    level: 'medium',
    label: 'Medium confidence',
    reasons: ['Indirect context'],
    isDegraded: true,
  };
}

function ConfidenceBadge({
  confidence,
}: {
  confidence: MarketConfidenceSummary | null | undefined;
}) {
  if (!confidence) {
    return null;
  }

  return (
    <span className={`market-panel-badge tone-${getConfidenceTone(confidence)}`}>
      {confidence.label}
    </span>
  );
}

function ConfidenceNote({
  confidence,
}: {
  confidence: MarketConfidenceSummary | null | undefined;
}) {
  if (!confidence?.isDegraded || confidence.reasons.length === 0) {
    return null;
  }

  return (
    <div className="market-confidence-note">
      {confidence.reasons.join(' · ')}
    </div>
  );
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
  className = '',
  headerAside = null,
}: {
  title: string;
  eyebrow: string;
  children: ReactNode;
  loading?: boolean;
  errorMessage?: string | null;
  loadingLabel?: string;
  className?: string;
  headerAside?: ReactNode;
}) {
  return (
    <div className={`card market-panel ${className}`.trim()}>
      <div className="card-header">
        <div className="market-panel-header">
          <div className="market-panel-header-copy">
            <span className="panel-title-eyebrow">{eyebrow}</span>
            <span className="card-label">{title}</span>
          </div>
          {headerAside ? <div className="market-panel-header-aside">{headerAside}</div> : null}
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
  const sellerMode = useAppStore((state) => state.sellerMode);
  const selectedMarketVariantKey = useAppStore((state) => state.selectedMarketVariantKey);
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
      sellerMode,
      'analytics',
    )
      .then(() =>
        getItemAnalytics(
          selectedItem.itemId,
          selectedItem.slug,
          selectedMarketVariantKey,
          sellerMode,
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
  }, [selectedItem, selectedMarketVariantKey, refreshNonce, chartDomain, chartBucket, sellerMode]);

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
        <EmptyAnalyticsState body="This item has separate rank markets. Pick the rank variant in the top bar so analytics only loads the selected rank." />
        {marketVariantsError ? <span className="watchlist-form-error">{marketVariantsError}</span> : null}
      </div>
    );
  }

  return (
    <div ref={pageContentRef} className="page-content market-page-content">
      <div className="market-header-actions">
        <div className="market-item-freshness">
          <span>Snapshot {formatRelativeTimestamp(analytics?.sourceSnapshotAt ?? null)}</span>
          <span>Stats {formatRelativeTimestamp(analytics?.sourceStatsFetchedAt ?? null)}</span>
          <span>Computed {formatRelativeTimestamp(analytics?.computedAt ?? null)}</span>
        </div>
        <button
          className="market-refresh-button"
          type="button"
          aria-label="Refresh market analytics"
          title="Refresh market analytics"
          onClick={() => setRefreshNonce((value) => value + 1)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
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
              headerAside={<ConfidenceBadge confidence={analytics?.entryExitZoneOverview.confidenceSummary} />}
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
              <ConfidenceNote confidence={analytics?.entryExitZoneOverview.confidenceSummary} />
            </AnalyticsPanel>

            <AnalyticsPanel
              title="Orderbook Pressure"
              eyebrow="Execution"
              loading={!revealedPanels.pressure && !errorMessage}
              errorMessage={!revealedPanels.pressure ? errorMessage : null}
              loadingLabel="Reading current orderbook pressure"
              headerAside={<ConfidenceBadge confidence={analytics?.orderbookPressure.confidenceSummary} />}
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
              <ConfidenceNote confidence={analytics?.orderbookPressure.confidenceSummary} />
            </AnalyticsPanel>

            <AnalyticsPanel
              title="Trend Quality Breakdown"
              eyebrow="Structure"
              loading={!revealedPanels.trend && !errorMessage}
              errorMessage={!revealedPanels.trend ? errorMessage : null}
              loadingLabel="Scoring short-term trend quality"
              headerAside={<ConfidenceBadge confidence={analytics?.trendQualityBreakdown.confidenceSummary} />}
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
              <ConfidenceNote confidence={analytics?.trendQualityBreakdown.confidenceSummary} />
            </AnalyticsPanel>

            <AnalyticsPanel
              title="Action Card"
              eyebrow="Readout"
              loading={!revealedPanels.action && !errorMessage}
              errorMessage={!revealedPanels.action ? errorMessage : null}
              loadingLabel="Building the market readout"
              headerAside={<ConfidenceBadge confidence={analytics?.actionCard.confidenceSummary} />}
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
                <ConfidenceNote confidence={analytics?.actionCard.confidenceSummary} />
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
  const analysis = useAppStore((state) => state.selectedMarketAnalysis);
  const analysisLoading = useAppStore((state) => state.selectedMarketAnalysisLoading);
  const analysisError = useAppStore((state) => state.selectedMarketAnalysisError);
  const loadSelectedMarketAnalysis = useAppStore((state) => state.loadSelectedMarketAnalysis);
  const addExplicitItemToWatchlist = useAppStore((state) => state.addExplicitItemToWatchlist);
  const worldStateAlerts = useAppStore((state) => state.worldStateAlerts);
  const worldStateEvents = useAppStore((state) => state.worldStateEvents);
  const worldStateInvasions = useAppStore((state) => state.worldStateInvasions);
  const worldStateSyndicateMissions = useAppStore((state) => state.worldStateSyndicateMissions);
  const worldStateVoidTrader = useAppStore((state) => state.worldStateVoidTrader);
  const worldStateFlashSales = useAppStore((state) => state.worldStateFlashSales);
  const [itemDetails, setItemDetails] = useState<ItemDetailSummary | null>(null);
  const [itemDetailsLoading, setItemDetailsLoading] = useState(false);
  const [itemDetailsError, setItemDetailsError] = useState<string | null>(null);
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
      setItemDetails(null);
      setItemDetailsLoading(false);
      setItemDetailsError(null);
      setComponentTargets({});
      setRevealedPanels({
        ...createRevealState(ANALYSIS_PANEL_SEQUENCE),
        itemDetails: false,
      });
      return;
    }

    let isMounted = true;
    clearRevealTimeouts(revealTimeoutsRef);
    setItemDetails(null);
    setItemDetailsLoading(true);
    setItemDetailsError(null);
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

    void loadSelectedMarketAnalysis()
      .then(() => {
        if (!isMounted) {
          return;
        }
        const response = useAppStore.getState().selectedMarketAnalysis;
        if (!response) {
          return;
        }
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
        queuePanelReveal(ANALYSIS_PANEL_SEQUENCE, setRevealedPanels, revealTimeoutsRef);
      })
      .catch((error) => {
        if (!isMounted) {
          return;
        }
        console.error('Failed to load selected market analysis', error);
        clearRevealTimeouts(revealTimeoutsRef);
      });

    return () => {
      isMounted = false;
      clearRevealTimeouts(revealTimeoutsRef);
    };
  }, [selectedItem, selectedMarketVariantKey, loadSelectedMarketAnalysis]);

  const eventContextEntries = buildEventContextEntries(analysis, {
    alerts: worldStateAlerts,
    events: worldStateEvents,
    invasions: worldStateInvasions,
    syndicateMissions: worldStateSyndicateMissions,
    voidTrader: worldStateVoidTrader,
    flashSales: worldStateFlashSales,
  });
  const eventContextConfidence = buildEventContextConfidence(eventContextEntries);

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
        <EmptyAnalyticsState body="Pick the correct rank in the top bar first so analysis never mixes rank-specific orders." />
        {marketVariantsError ? <span className="watchlist-form-error">{marketVariantsError}</span> : null}
      </div>
    );
  }

  const effectiveItemDetails = itemDetails ?? analysis?.itemDetails ?? null;
  const itemImageUrl = resolveWfmAssetUrl(effectiveItemDetails?.imagePath);
  const itemDetailSections = buildItemDetailSections(effectiveItemDetails);
  const heroState = buildAnalysisHeroState(analysis);
  const liquidityMeterValue = toUnitInterval(analysis?.headline.liquidityScore);
  const trendConfidenceValue = toUnitInterval(analysis?.trend.confidence);
  const riskMeterValue = getRiskTone(analysis?.manipulationRisk.riskLevel) === 'red'
    ? 0.92
    : getRiskTone(analysis?.manipulationRisk.riskLevel) === 'amber'
      ? 0.58
      : getRiskTone(analysis?.manipulationRisk.riskLevel) === 'green'
        ? 0.18
        : 0.35;
  const maxTimeOfDayQuantity = Math.max(
    ...(analysis?.timeOfDayLiquidity.buckets ?? []).map((bucket) => bucket.avgVisibleQuantity ?? 0),
    1,
  );

  return (
    <div ref={pageContentRef} className="page-content market-page-content">
      <div className="market-header-actions">
        <div className="market-item-freshness">
          <span>Snapshot {formatRelativeTimestamp(analysis?.sourceSnapshotAt ?? null)}</span>
          <span>Stats {formatRelativeTimestamp(analysis?.sourceStatsFetchedAt ?? null)}</span>
          <span>Computed {formatRelativeTimestamp(analysis?.computedAt ?? null)}</span>
        </div>
        <button
          className="market-refresh-button"
          type="button"
          aria-label="Refresh market analysis"
          title="Refresh market analysis"
          disabled={analysisLoading}
          onClick={() => {
            void loadSelectedMarketAnalysis({ force: true });
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      <div className="market-analysis-layout">
        <div className="market-analysis-column market-analysis-column-main">
          <div className={`market-summary-grid-shell market-hero-shell tone-${heroState.tone}`}>
            <div className="market-hero-strip">
              <div className="market-hero-copy">
                <div className="market-hero-title-row">
                  <span className="market-hero-kicker">Trade Posture</span>
                  <div className="market-badge-stack">
                    <span className={`market-panel-badge tone-${heroState.tone}`}>{heroState.label}</span>
                    <ConfidenceBadge confidence={analysis?.headline.confidenceSummary} />
                  </div>
                </div>
                <span className="market-hero-item-name">{selectedItem.name}</span>
                <p className="market-hero-note">{heroState.note}</p>
              </div>
              <div className="market-hero-meter-grid">
                <div className="market-meter-card">
                  <span className="market-copy-title">Liquidity</span>
                  <div className="market-meter-track">
                    <div
                      className="market-meter-fill tone-blue"
                      style={{ '--meter-fill': `${Math.round(liquidityMeterValue * 100)}%` } as CSSProperties}
                    />
                  </div>
                  <span className="market-meter-value">
                    {formatPercent(analysis?.headline.liquidityScore)} · {analysis?.headline.liquidityLabel ?? '—'}
                  </span>
                </div>
                <div className="market-meter-card">
                  <span className="market-copy-title">Trend Confidence</span>
                  <div className="market-meter-track">
                    <div
                      className="market-meter-fill tone-green"
                      style={{ '--meter-fill': `${Math.round(trendConfidenceValue * 100)}%` } as CSSProperties}
                    />
                  </div>
                  <span className="market-meter-value">
                    {formatPercent(analysis?.trend.confidence)} · {analysis?.trend.direction ?? '—'}
                  </span>
                </div>
                <div className="market-meter-card">
                  <span className="market-copy-title">Risk Posture</span>
                  <div className="market-meter-track">
                    <div
                      className={`market-meter-fill tone-${getRiskTone(analysis?.manipulationRisk.riskLevel)}`}
                      style={{ '--meter-fill': `${Math.round(riskMeterValue * 100)}%` } as CSSProperties}
                    />
                  </div>
                  <span className="market-meter-value">{analysis?.manipulationRisk.riskLevel ?? '—'}</span>
                </div>
              </div>
            </div>
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
              loading={!revealedPanels.headline && !analysisError}
              errorMessage={!revealedPanels.headline ? analysisError : null}
              label="Building headline metrics"
            />
          </div>

          <AnalyticsPanel
            title="Flip Analysis"
            eyebrow="Execution Model"
            loading={!revealedPanels.flip && !analysisError}
            errorMessage={!revealedPanels.flip ? analysisError : null}
            loadingLabel="Calculating flip margins"
            className="market-panel-tone-blue"
            headerAside={
              <div className="market-badge-stack">
                <span className="market-panel-badge tone-blue">
                  {analysis?.flipAnalysis.efficiencyLabel ?? 'Building'}
                </span>
                <ConfidenceBadge confidence={analysis?.flipAnalysis.confidenceSummary} />
              </div>
            }
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
            <ConfidenceNote confidence={analysis?.flipAnalysis.confidenceSummary} />
          </AnalyticsPanel>

          <AnalyticsPanel
            title="Liquidity Detail"
            eyebrow="Market Structure"
            loading={!revealedPanels.liquidity && !analysisError}
            errorMessage={!revealedPanels.liquidity ? analysisError : null}
            loadingLabel="Profiling live liquidity"
            className="market-panel-tone-blue"
            headerAside={
              <div className="market-badge-stack">
                <span className="market-panel-badge tone-blue">
                  {analysis?.liquidityDetail.state ?? 'Profiling'}
                </span>
                <ConfidenceBadge confidence={analysis?.liquidityDetail.confidenceSummary} />
              </div>
            }
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
            <ConfidenceNote confidence={analysis?.liquidityDetail.confidenceSummary} />
            <div className="market-signal-board">
              <div className="market-signal-row">
                <span className="market-signal-label">Demand Ratio</span>
                <div className="market-signal-track">
                  <div
                    className="market-signal-fill tone-blue"
                    style={{ '--signal-fill': `${Math.round(ratioToUnitInterval(analysis?.liquidityDetail.demandRatio) * 100)}%` } as CSSProperties}
                  />
                </div>
              </div>
              <div className="market-signal-row">
                <span className="market-signal-label">Qty-Weighted Demand</span>
                <div className="market-signal-track">
                  <div
                    className="market-signal-fill tone-green"
                    style={{ '--signal-fill': `${Math.round(toUnitInterval(analysis?.liquidityDetail.quantityWeightedDemand) * 100)}%` } as CSSProperties}
                  />
                </div>
              </div>
              <div className="market-signal-row">
                <span className="market-signal-label">Liquidity Score</span>
                <div className="market-signal-track">
                  <div
                    className="market-signal-fill tone-cyan"
                    style={{ '--signal-fill': `${Math.round(toUnitInterval(analysis?.liquidityDetail.liquidityScore) * 100)}%` } as CSSProperties}
                  />
                </div>
              </div>
            </div>
          </AnalyticsPanel>

          <AnalyticsPanel
            title="Trend"
            eyebrow="Analytics Carryover"
            loading={!revealedPanels.trend && !analysisError}
            errorMessage={!revealedPanels.trend ? analysisError : null}
            loadingLabel="Summarizing the current trend"
            className={`market-panel-tone-${getTrendTone(analysis?.trend.direction)}`}
            headerAside={
              <div className="market-badge-stack">
                <span className={`market-panel-badge tone-${getTrendTone(analysis?.trend.direction)}`}>
                  {analysis?.trend.direction ?? 'Building'}
                </span>
                <ConfidenceBadge confidence={analysis?.trend.confidenceSummary} />
              </div>
            }
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
            <div className="market-slope-grid">
              {[
                { label: '1H', value: analysis?.trend.slope1h ?? null },
                { label: '3H', value: analysis?.trend.slope3h ?? null },
                { label: '6H', value: analysis?.trend.slope6h ?? null },
              ].map((slope) => (
                <div key={slope.label} className="market-slope-card">
                  <div className="market-slope-head">
                    <span className="market-copy-title">{slope.label} Slope</span>
                    <span className={`market-slope-value${(slope.value ?? 0) >= 0 ? ' is-up' : ' is-down'}`}>
                      {formatPercent(slope.value)}
                    </span>
                  </div>
                  <div className="market-slope-track">
                    <div
                      className={`market-slope-fill${(slope.value ?? 0) >= 0 ? ' is-up' : ' is-down'}`}
                      style={{ '--slope-fill': `${Math.round(slopeToUnitInterval(slope.value) * 100)}%` } as CSSProperties}
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className="market-copy-block">
              <span className="market-copy-title">Summary</span>
              <p>{analysis?.trend.summary ?? '—'}</p>
            </div>
            <ConfidenceNote confidence={analysis?.trend.confidenceSummary} />
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
            loading={!revealedPanels.supply && !analysisError}
            errorMessage={!revealedPanels.supply ? analysisError : null}
            loadingLabel="Building supply context"
            className="market-panel-tone-amber"
            headerAside={
              <div className="market-badge-stack">
                <span className="market-panel-badge tone-amber">
                  {analysis?.supplyContext.mode === 'set-components'
                    ? 'Set Breakdown'
                    : analysis?.supplyContext.mode === 'drop-sources'
                      ? 'Drop Intel'
                      : 'No Source'}
                </span>
                <ConfidenceBadge confidence={analysis?.supplyContext.confidenceSummary} />
              </div>
            }
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
                    <span>Chance: {formatDropChancePercent(source.chance)}</span>
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
            <ConfidenceNote confidence={analysis?.supplyContext.confidenceSummary} />
          </AnalyticsPanel>
        </div>

        <div className="market-analysis-column market-analysis-column-side">
          <div className="market-analysis-item-details">
              <AnalyticsPanel
                title="Item Details"
                eyebrow="Reference"
                loading={itemDetailsLoading || (!revealedPanels.itemDetails && !itemDetailsError)}
                errorMessage={itemDetailsError}
                loadingLabel="Loading item details from the local catalog"
                className="market-panel-tone-neutral market-item-details-panel"
                headerAside={
                  effectiveItemDetails?.category ? (
                    <div className="market-badge-stack">
                      <span className="market-panel-badge tone-neutral">{effectiveItemDetails.category}</span>
                    </div>
                  ) : null
                }
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
                <div className="market-detail-section-list">
                  {itemDetailSections.map((section) => (
                    <div key={section.title} className="market-detail-section">
                      <span className="market-copy-title">{section.title}</span>
                      <div className="market-detail-grid">
                        {section.fields.map((field) => (
                          <div key={`${section.title}-${field.label}-${field.value}`}>
                            <span className="market-copy-title">{field.label}</span>
                            <span>{field.value}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </AnalyticsPanel>
          </div>

          <AnalyticsPanel
            title="Event Context"
            eyebrow="World State"
            loading={!revealedPanels.eventContext && !analysisError}
            errorMessage={!revealedPanels.eventContext ? analysisError : null}
            loadingLabel="Matching worldstate context"
            className="market-panel-tone-amber"
            headerAside={
              <div className="market-badge-stack">
                <span className="market-panel-badge tone-amber">
                  {eventContextEntries.length} {eventContextEntries.length === 1 ? 'match' : 'matches'}
                </span>
                <ConfidenceBadge confidence={eventContextConfidence} />
              </div>
            }
          >
            {eventContextEntries.length > 0 ? (
              <div className="market-context-list market-context-list-timeline">
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
            <ConfidenceNote confidence={eventContextConfidence} />
          </AnalyticsPanel>

          <AnalyticsPanel
            title="Manipulation Risk"
            eyebrow="Safety"
            loading={!revealedPanels.manipulation && !analysisError}
            errorMessage={!revealedPanels.manipulation ? analysisError : null}
            loadingLabel="Scanning manipulation signals"
            className={`market-panel-tone-${getRiskTone(analysis?.manipulationRisk.riskLevel)}`}
            headerAside={
              <div className="market-badge-stack">
                <span className={`market-panel-badge tone-${getRiskTone(analysis?.manipulationRisk.riskLevel)}`}>
                  {analysis?.manipulationRisk.riskLevel ?? 'Building'}
                </span>
                <ConfidenceBadge confidence={analysis?.manipulationRisk.confidenceSummary} />
              </div>
            }
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
            <div className="market-signal-board">
              <div className="market-signal-row">
                <span className="market-signal-label">Penalty Applied</span>
                <div className="market-signal-track danger">
                  <div
                    className="market-signal-fill tone-red"
                    style={{ '--signal-fill': `${Math.round(toUnitInterval(analysis?.manipulationRisk.efficiencyPenaltyPct) * 100)}%` } as CSSProperties}
                  />
                </div>
              </div>
            </div>
            <ConfidenceNote confidence={analysis?.manipulationRisk.confidenceSummary} />
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
            loading={!revealedPanels.timeOfDay && !analysisError}
            errorMessage={!revealedPanels.timeOfDay ? analysisError : null}
            loadingLabel="Aggregating observatory tape"
            className="market-panel-tone-blue"
            headerAside={
              <div className="market-badge-stack">
                <span className="market-panel-badge tone-blue">
                  {analysis?.timeOfDayLiquidity.strongestWindowLabel ?? 'Building'}
                </span>
                <ConfidenceBadge confidence={analysis?.timeOfDayLiquidity.confidenceSummary} />
              </div>
            }
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
            <div className="market-time-grid market-time-heat-grid">
              {(analysis?.timeOfDayLiquidity.buckets ?? []).map((bucket) => (
                <div
                  key={bucket.hour}
                  className="market-time-card market-time-card-heat"
                  style={{ '--heat-strength': `${Math.round(((bucket.avgVisibleQuantity ?? 0) / maxTimeOfDayQuantity) * 100)}%` } as CSSProperties}
                >
                  <span className="market-copy-title">{bucket.label}</span>
                  <span>{formatNumber(bucket.avgVisibleQuantity, 0)} visible qty</span>
                  <span>{formatNumber(bucket.avgSellOrders, 1)} avg sell orders</span>
                  <span>Spread {formatPercent(bucket.avgSpreadPct)}</span>
                </div>
              ))}
            </div>
            <ConfidenceNote confidence={analysis?.timeOfDayLiquidity.confidenceSummary} />
          </AnalyticsPanel>
        </div>
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
