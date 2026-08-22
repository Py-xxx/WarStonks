import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import {
  getWfmAutocompleteItems,
  getItemAnalytics,
  getItemDetailSummary,
  getBacktestSummary,
  openExternalUrl,
  stopMarketTracking,
} from '../../lib/tauriClient';
import { formatShortLocalDate, formatShortLocalDateTime } from '../../lib/dateTime';
import {
  clearWatchlistAddFeedbackTimeouts,
  markWatchlistAddFeedback,
} from '../../lib/watchlistAddFeedback';
import { formatMarketErrorMessage } from '../../lib/marketErrorHandling';
import { resolveRelicAssetUrl, resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  getConfidenceTone,
  getRiskTone,
  getTrendTone,
  ratioToUnitInterval,
  slopeToUnitInterval,
  toUnitInterval,
  clampNumber,
} from './posture';
import { Metric, MetricGrid } from '@/components/ui/metric';
import { Skeleton } from '@/components/ui/skeleton';
import { Panel, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { InfoHint } from '../../components/InfoHint';
import { PageHeading } from '../../components/PageHeading';
import { tActive, useTranslation } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { resolveLocalizedName } from '../../lib/itemNames';
import { parseWarframeMarkupLines, splitWarframeMarkupLines } from '../../lib/warframeMarkup';
import { parseVaultTraderPayload } from '../../lib/worldState';
import {
  tActionRationale,
  tConfidence,
  tEntryRationale,
  tExitRationale,
  tHealth,
  tSignalDetail,
  tTrendSummary,
} from '../../lib/healthLabels';
import type { TranslationKey } from '../../i18n/en';
import { translate } from '../../i18n';
import { useAppStore } from '../../stores/useAppStore';
import { QuickViewCard } from './DashboardPanels';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import type {
  AnalyticsChartPoint,
  BacktestSummary,
  ItemAnalysisResponse,
  ItemAnalyticsResponse,
  ItemDetailSummary,
  MarketConfidenceSummary,
  TimeOfDayLiquidityBucket,
  WfmAutocompleteItem,
} from '../../types';

type ChartDomainKey = '48h' | '7d' | '30d' | '90d';
type ChartBucketKey = '1h' | '3h' | '6h' | '12h' | '24h' | '7d' | '14d';
type ChartSeriesKey = 'median' | 'lowest' | 'movingAverage' | 'average' | 'entryZone' | 'exitZone';
type ChartMode = 'line' | 'candlestick';

/**
 * A chart-shaped placeholder for the plot area.
 *
 * Deliberately not the `Skeleton` primitive's generic blocks: this stands in for a line chart, and
 * a stack of grey bars reads as a table loading, not a chart. It renders the same gridlines and a
 * pulsing area silhouette so the shape on screen is the shape that arrives.
 *
 * It sits INSIDE the plot only. The previous version was `absolute inset-0` over the whole card,
 * so it greyed out the range/bucket selects and the series toggles — controls that are usable
 * while the chart loads, and that you often want to change *because* it is loading.
 */
function ChartSkeleton() {
  return (
    <div className="market-chart-skeleton" aria-hidden="true">
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="market-chart-skeleton-svg">
        {[8, 16, 24, 32].map((y) => (
          <line key={y} x1="0" y1={y} x2="100" y2={y} className="market-chart-skeleton-grid" />
        ))}
        <path
          d="M0 30 L12 26 L24 28 L36 18 L48 21 L60 12 L72 15 L84 8 L100 11 L100 40 L0 40 Z"
          className="market-chart-skeleton-area"
        />
        <path
          d="M0 30 L12 26 L24 28 L36 18 L48 21 L60 12 L72 15 L84 8 L100 11"
          className="market-chart-skeleton-line"
        />
      </svg>
    </div>
  );
}

const RefreshIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" />
  </svg>
);




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
  label: TranslationKey;
  colorClass: string;
}



function buildMarketSelectionIdentity(
  itemId: number | null,
  variantKey: string | null,
  sellerMode: string,
) {
  if (!itemId || !variantKey) {
    return null;
  }

  return `${itemId}:${variantKey}:${sellerMode}`;
}

const DOMAIN_OPTIONS: Array<{ key: ChartDomainKey; label: TranslationKey; hours: number }> = [
  { key: '48h', label: 'mkt.domain48h', hours: 48 },
  { key: '7d', label: 'mkt.domain7d', hours: 24 * 7 },
  { key: '30d', label: 'mkt.domain30d', hours: 24 * 30 },
  { key: '90d', label: 'mkt.domain90d', hours: 24 * 90 },
];

const BUCKET_OPTIONS_BY_DOMAIN: Record<ChartDomainKey, ChartBucketKey[]> = {
  '48h': ['1h', '3h', '6h', '12h', '24h'],
  '7d': ['3h', '6h', '12h', '24h'],
  '30d': ['12h', '24h', '7d'],
  '90d': ['24h', '7d', '14d'],
};

const SERIES_OPTIONS: ChartSeriesOption[] = [
  { key: 'median', label: 'mkt.median', colorClass: 'secondary' },
  { key: 'lowest', label: 'mkt.lowest', colorClass: 'primary' },
  { key: 'movingAverage', label: 'mkt.sma', colorClass: 'moving' },
  { key: 'average', label: 'mkt.series.avgPrice', colorClass: 'average' },
  { key: 'entryZone', label: 'mkt.entryZone', colorClass: 'entry' },
  { key: 'exitZone', label: 'mkt.exitZone', colorClass: 'exit' },
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

function formatChartTimestamp(timestamp: number, _domain: ChartDomainKey): string {
  return formatShortLocalDateTime(new Date(timestamp).toISOString());
}

function renderStatHighlightLine(line: string): ReactNode {
  const changedRangeMatch = line.match(/(\d[\d.,%+\-xX ]*->\s*\d[\d.,%+\-xX ]*)/);

  // Render Warframe's own color markup (e.g. `<DT_FIRE_COLOR>Heat</DT_FIRE_COLOR>`) as colored
  // text instead of leaking the raw tag onto the screen — see lib/warframeMarkup.
  const renderSegments = (text: string, keyPrefix: string): ReactNode =>
    parseWarframeMarkupLines(text)[0]?.map((segment, index) =>
      segment.color ? (
        <span key={`${keyPrefix}-${index}`} style={{ color: segment.color }}>
          {segment.text}
        </span>
      ) : (
        <span key={`${keyPrefix}-${index}`} className="market-detail-highlight-copy">
          {segment.text}
        </span>
      ),
    ) ?? null;

  if (!changedRangeMatch || changedRangeMatch.index === undefined) {
    return renderSegments(line, 'plain');
  }

  const rangeStart = changedRangeMatch.index;
  const changedText = changedRangeMatch[1].trim();
  const label = line.slice(0, rangeStart);
  const suffix = line.slice(rangeStart + changedRangeMatch[1].length);

  return (
    <>
      {label ? renderSegments(label, 'label') : null}
      <span className="market-detail-highlight-change">{changedText}</span>
      {suffix ? renderSegments(suffix, 'suffix') : null}
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
    useAppStore.getState().pushToast(translate(useAppStore.getState().language, 'mkt.err.openLink'), 'error');
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
  const { t } = useTranslation();
  const [chartMode, setChartMode] = useState<ChartMode>('line');
  const [seriesToggles, setSeriesToggles] = useState<Record<ChartSeriesKey, boolean>>(DEFAULT_SERIES_TOGGLES);
  const [hoveredPointIndex, setHoveredPointIndex] = useState<number | null>(null);

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
  // Shared x-axis ticks so the vertical gridlines and the time labels sit on the SAME
  // positions (previously gridlines were evenly spaced but labels were at sampled data
  // indices, so they never lined up).
  const xAxisTickCount = Math.min(Math.max(points.length, 1), 6);
  const xAxisTicks = Array.from({ length: xAxisTickCount }, (_, index) => {
    const fraction = xAxisTickCount <= 1 ? 0.5 : index / (xAxisTickCount - 1);
    const dataIndex = Math.round(fraction * Math.max(0, points.length - 1));
    return {
      x: fraction * plotWidth,
      timestamp: points[dataIndex]?.timestamp ?? '',
      anchor: (index === 0
        ? 'start'
        : index === xAxisTickCount - 1
          ? 'end'
          : 'middle') as 'start' | 'middle' | 'end',
    };
  });
  const visibleSeries = SERIES_OPTIONS.filter((option) => seriesToggles[option.key]);
  const visibleLineSeries = visibleSeries.filter(
    (series) => series.key !== 'entryZone' && series.key !== 'exitZone',
  );
  const volumeMax = Math.max(...points.map((point) => point.volume), 1);
  const entryBand = buildZoneBandRect(
    analytics?.entryExitZoneOverview.entryZoneLow,
    analytics?.entryExitZoneOverview.entryZoneHigh,
    pricePlotHeight,
    minValue,
    maxValue,
  );
  const chartLoading = loading;
  const exitBand = buildZoneBandRect(
    analytics?.entryExitZoneOverview.exitZoneLow,
    analytics?.entryExitZoneOverview.exitZoneHigh,
    pricePlotHeight,
    minValue,
    maxValue,
  );
  const activePointIndex =
    hoveredPointIndex !== null && hoveredPointIndex >= 0 && hoveredPointIndex < points.length
      ? hoveredPointIndex
      : null;
  const activePoint = activePointIndex !== null ? points[activePointIndex] : null;
  const activePointX =
    activePointIndex !== null
      ? points.length === 1
        ? plotWidth / 2
        : (activePointIndex / (points.length - 1)) * plotWidth
      : null;
  const hoverCardOnRight = activePointX === null ? true : activePointX < plotWidth / 2;

  useEffect(() => {
    if (hoveredPointIndex !== null && hoveredPointIndex >= points.length) {
      setHoveredPointIndex(null);
    }
  }, [hoveredPointIndex, points.length]);

  function toggleSeries(key: ChartSeriesKey) {
    setSeriesToggles((current) => ({
      ...current,
      [key]: !current[key],
    }));
  }

  function handleChartPointerMove(event: ReactMouseEvent<SVGSVGElement>) {
    if (points.length === 0) {
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0) {
      return;
    }

    const ratio = clampNumber((event.clientX - bounds.left) / bounds.width, 0, 1);
    const nextIndex = points.length === 1 ? 0 : Math.round(ratio * (points.length - 1));
    setHoveredPointIndex(nextIndex);
  }

  function handleChartPointerLeave() {
    setHoveredPointIndex(null);
  }

  return (
    <div className="card market-chart-stack">
      <div className="card-header">
        <div className="market-chart-header">
          <div className="market-chart-header-copy">
            <span className="panel-title-eyebrow">{t('market.priceChart')}</span>
            <span className="card-label market-panel-title-row">
              <span>{itemName}</span>
              <InfoHint text={t('mki.chart')} />
            </span>
          </div>
          <div className="market-chart-select-row">
            <label className="market-toolbar-group">
              <span className="market-toolbar-label">{t('market.toolbar.range')}</span>
              <select
                className="market-variant-select"
                value={domain}
                onChange={(event) => onDomainChange(event.target.value as ChartDomainKey)}
              >
                {DOMAIN_OPTIONS.map((option) => (
                  <option key={option.key} value={option.key}>
                    {t(option.label as TranslationKey)}
                  </option>
                ))}
              </select>
            </label>
            <label className="market-toolbar-group">
              <span className="market-toolbar-label">{t('market.toolbar.bucket')}</span>
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
      <div className="card-body market-panel-body">
        <div className="market-chart-card">
          <div className="market-chart-toolbar">
            {/* The static O/H/L/C strip is gone. Only candlestick mode has open/high/low/close,
                so in the default line view it rendered "O — H — L — C — — (—)" permanently, and
                the hover readout already gives those four per point in candle mode. */}
            <div className="market-toggle-row">
              {SERIES_OPTIONS.map((option) => (
                <button
                  key={option.key}
                  className={`market-chart-toggle${seriesToggles[option.key] ? ' active' : ''}`}
                  type="button"
                  onClick={() => toggleSeries(option.key)}
                >
                  <span className={`legend-swatch ${option.colorClass}`} />
                  {t(option.label)}
                </button>
              ))}
            </div>
          </div>

          <div className="market-chart-surface">
            <div className="market-chart-y-axis">
              {tickValues.map((value, index) => (
                <span
                  key={value}
                  style={{
                    top: `${((index / 4) * pricePlotHeight) / (totalPlotHeight + xAxisHeight) * 100}%`,
                  }}
                >
                  {formatPrice(value)}
                </span>
              ))}
            </div>
            {chartLoading ? (
              <ChartSkeleton />
            ) : errorMessage ? (
              <div className="market-chart-status is-error">{errorMessage}</div>
            ) : points.length === 0 ? (
              <div className="market-chart-status">{t('mkt.noChartHistory')}</div>
            ) : (
              <div className="market-chart-plot-wrap">
                {activePoint ? (
                  <div
                    className={`market-chart-hover-card${hoverCardOnRight ? ' is-right' : ' is-left'}`}
                  >
                    <div className="market-chart-hover-header">
                      <span className="market-chart-hover-label">{t('mkt.hoveredBucket')}</span>
                      <span className="market-chart-hover-time">{formatChartTimestamp(activePoint.timestamp, domain)}</span>
                    </div>
                    <div className="market-chart-hover-section">
                      <span className="market-chart-hover-section-title">{t('mkt.market')}</span>
                      <div className="market-chart-hover-rows">
                        <span className="market-chart-hover-row"><span>{t('mkt.lowest')}</span><span>{formatPrice(activePoint.lowest)}</span></span>
                        <span className="market-chart-hover-row"><span>{t('mkt.highest')}</span><span>{formatPrice(activePoint.high)}</span></span>
                        <span className="market-chart-hover-row"><span>{t('mkt.median')}</span><span>{formatPrice(activePoint.median)}</span></span>
                        <span className="market-chart-hover-row"><span>{t('mkt.average')}</span><span>{formatPrice(activePoint.average)}</span></span>
                        <span className="market-chart-hover-row"><span>{t('mkt.volume')}</span><span>{formatNumber(activePoint.volume, 0)}</span></span>
                      </div>
                    </div>
                    <div className="market-chart-hover-section">
                      <span className="market-chart-hover-section-title">{t('mkt.levels')}</span>
                      <div className="market-chart-hover-rows">
                        <span className="market-chart-hover-row"><span>{t('mkt.open')}</span><span>{formatPrice(activePoint.open)}</span></span>
                        <span className="market-chart-hover-row"><span>{t('mkt.close')}</span><span>{formatPrice(activePoint.close)}</span></span>
                        <span className="market-chart-hover-row"><span>{t('mkt.sma')}</span><span>{formatPrice(activePoint.movingAverage)}</span></span>
                        <span className="market-chart-hover-row"><span>{t('mkt.entry')}</span><span>{formatPrice(activePoint.entryZone)}</span></span>
                        <span className="market-chart-hover-row"><span>{t('mkt.exit')}</span><span>{formatPrice(activePoint.exitZone)}</span></span>
                      </div>
                    </div>
                  </div>
                ) : null}
                <svg
                  className="market-chart-svg"
                  viewBox={`0 0 ${plotWidth} ${totalPlotHeight + xAxisHeight}`}
                  preserveAspectRatio="none"
                  aria-label={t('market.graphAria')}
                  onMouseMove={handleChartPointerMove}
                  onMouseLeave={handleChartPointerLeave}
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
                  {xAxisTicks.map((tick, index) => (
                    <line
                      key={`v-${index}`}
                      className="market-chart-gridline market-chart-gridline-vertical"
                      x1={tick.x}
                      y1="0"
                      x2={tick.x}
                      y2={totalPlotHeight}
                    />
                  ))}
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

                  {activePointX !== null ? (
                    <line
                      className="market-chart-hover-line"
                      x1={activePointX}
                      y1="0"
                      x2={activePointX}
                      y2={totalPlotHeight}
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
                              className={`market-candle-wick${isUp ? ' is-up' : ' is-down'}${activePointIndex === index ? ' is-active' : ''}`}
                              x1={x}
                              y1={highY}
                              x2={x}
                              y2={lowY}
                            />
                            <rect
                              className={`market-candle-body${isUp ? ' is-up' : ' is-down'}${activePointIndex === index ? ' is-active' : ''}`}
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
                            className={`market-chart-marker market-chart-marker-${series.colorClass}${activePointIndex === index ? ' is-active' : ''}`}
                            cx={x}
                            cy={y}
                            r={activePointIndex === index ? '5.25' : '3.5'}
                          />
                        );
                      }),
                    )}

                  {visibleLineSeries
                    .filter((series) => series.key !== 'median' && series.key !== 'lowest')
                    .map((series) => {
                      if (activePoint === null) {
                        return null;
                      }
                      const value = activePoint[series.key];
                      if (value === null || activePointX === null) {
                        return null;
                      }
                      return (
                        <circle
                          key={`active-${series.key}-${activePoint.timestamp}`}
                          className={`market-chart-active-marker market-chart-marker-${series.colorClass}`}
                          cx={activePointX}
                          cy={renderChartY(value, pricePlotHeight, minValue, maxValue)}
                          r="4.25"
                        />
                      );
                    })}

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
                        className={`market-volume-bar${isUp ? ' is-up' : ' is-down'}${activePointIndex === index ? ' is-active' : ''}`}
                        x={x}
                        y={totalPlotHeight - height}
                        width={width}
                        height={height}
                        rx="3"
                      />
                    );
                  })}

                  {xAxisTicks.map((tick, index) =>
                    tick.timestamp ? (
                      <text
                        key={`x-${index}-${tick.timestamp}`}
                        className="market-chart-axis-label"
                        x={tick.x}
                        y={totalPlotHeight + 18}
                        textAnchor={tick.anchor}
                      >
                        {formatChartTimestamp(tick.timestamp, domain)}
                      </text>
                    ) : null,
                  )}
                </svg>
              </div>
            )}
          </div>

          <div className="market-chart-legend market-chart-footer">
            <span>Median {formatPrice(points[points.length - 1]?.median ?? null)}</span>
            <span>{t('mkt.lowestPrefix', { price: formatPrice(points[points.length - 1]?.lowest ?? null) })}</span>
            <span>Volume {formatNumber(points[points.length - 1]?.volume ?? null, 0)}</span>
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
    return '<0.01%';
  }

  const percentValue = Math.abs(value) <= 1 ? value * 100 : value;
  const absValue = Math.abs(percentValue);
  let digits = 1;
  if (absValue < 0.01) {
    digits = 4;
  } else if (absValue < 0.1) {
    digits = 3;
  } else if (absValue < 1) {
    digits = 2;
  }

  return `${formatNumber(percentValue, digits)}%`;
}

const WEEKDAY_LABEL_KEYS: TranslationKey[] = [
  'mkt.weekdayMon',
  'mkt.weekdayTue',
  'mkt.weekdayWed',
  'mkt.weekdayThu',
  'mkt.weekdayFri',
  'mkt.weekdaySat',
  'mkt.weekdaySun',
];

/** `10:00–12:00`, not `10–12`. A bare number pair reads as a range of anything — the colon is
 *  what makes it read as a clock. */
function formatTwoHourBlockLabel(bucketIndex: number): string {
  const start = (bucketIndex * 2) % 24;
  const end = (start + 2) % 24;
  return `${start.toString().padStart(2, '0')}:00–${end.toString().padStart(2, '0')}:00`;
}

function emptyTimeOfDayCell(weekday: number, bucketIndex: number): TimeOfDayLiquidityBucket {
  return {
    weekday,
    bucketIndex,
    hour: bucketIndex * 2,
    label: formatTwoHourBlockLabel(bucketIndex),
    avgVisibleQuantity: 0,
    avgSellOrders: 0,
    avgSpreadPct: null,
    avgLiquidityScore: 0,
    avgHourlyVolume: 0,
    sampleCount: 0,
    normalizedLiquidity: 0,
    normalizedVolume: 0,
    heatScore: 0,
  };
}

interface TimeOfDayDisplayRow {
  weekday: number;
  label: string;
  isToday: boolean;
  cells: TimeOfDayLiquidityBucket[];
}

interface TimeOfDayDisplayModel {
  rows: TimeOfDayDisplayRow[];
  columnLabels: string[];
  todayWeekday: number;
  todayBestLabels: string[];
  strongestWindowLabel: string | null;
  weakestWindowLabel: string | null;
  currentHourLabel: string;
}

// Builds the 7 (Mon–Sun) × 12 (two-hour blocks) heatmap grid straight from the backend
// buckets. Times are UTC, matching how the backend aggregates the observatory tape.
function buildTimeOfDayDisplayModel(
  summary: ItemAnalysisResponse['timeOfDayLiquidity'] | null | undefined,
): TimeOfDayDisplayModel {
  const byKey = new Map<string, TimeOfDayLiquidityBucket>();
  for (const bucket of summary?.buckets ?? []) {
    byKey.set(`${bucket.weekday}:${bucket.bucketIndex}`, bucket);
  }

  const todayWeekday = summary?.todayWeekday ?? -1;
  const rows = Array.from({ length: 7 }, (_, weekday): TimeOfDayDisplayRow => ({
    weekday,
    label: tActive(WEEKDAY_LABEL_KEYS[weekday]),
    isToday: weekday === todayWeekday,
    cells: Array.from(
      { length: 12 },
      (_unused, bucketIndex) =>
        byKey.get(`${weekday}:${bucketIndex}`) ?? emptyTimeOfDayCell(weekday, bucketIndex),
    ),
  }));

  return {
    rows,
    columnLabels: Array.from({ length: 12 }, (_unused, bucketIndex) =>
      formatTwoHourBlockLabel(bucketIndex),
    ),
    todayWeekday,
    todayBestLabels: summary?.todayBestLabels ?? [],
    strongestWindowLabel: summary?.strongestWindowLabel ?? null,
    weakestWindowLabel: summary?.weakestWindowLabel ?? null,
    currentHourLabel: summary?.currentHourLabel ?? '—',
  };
}

function formatRelativeTimestamp(value: string | null | undefined): string {
  if (!value) {
    return '—';
  }
  return formatShortLocalDateTime(value);
}

function formatDateCompact(value: string | null | undefined): string {
  if (!value) {
    return '—';
  }
  return formatShortLocalDate(value);
}

function formatNullableBoolean(value: boolean | null | undefined, t: TranslateFn): string {
  if (value === null || value === undefined) {
    return '—';
  }

  return value ? t('mkt.yes') : t('mkt.no');
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

function buildItemDetailSections(detail: ItemDetailSummary | null, t: TranslateFn): ItemDetailSection[] {
  if (!detail) {
    return [];
  }

  const detailKind = classifyItemDetail(detail);
  const sections: ItemDetailSection[] = [];
  const overviewFields: ItemDetailField[] = [];

  pushDetailField(overviewFields, t('mkt.field.category'), detail.category ?? '—');
  pushDetailField(overviewFields, t('mkt.field.rarity'), detail.rarity ?? '—');
  pushDetailField(overviewFields, t('mkt.field.prime'), formatNullableBoolean(detail.prime, t));
  pushDetailField(overviewFields, t('mkt.field.vaulted'), formatNullableBoolean(detail.vaulted, t));
  if (overviewFields.length > 0) {
    sections.push({ title: t('mkt.section.overview'), fields: overviewFields });
  }

  if (detailKind === 'mod' || detailKind === 'arcane') {
    const upgradeFields: ItemDetailField[] = [];
    pushDetailField(upgradeFields, t('mkt.field.compatibility'), detail.compatName ?? '—');
    pushDetailField(upgradeFields, t('mkt.field.polarity'), detail.polarity ?? '—');
    pushDetailField(upgradeFields, t('mkt.field.stancePolarity'), detail.stancePolarity ?? '—');
    pushDetailField(upgradeFields, t('mkt.field.modSet'), detail.modSet ?? '—');
    pushDetailField(upgradeFields, t('mkt.field.baseDrain'), formatNumber(detail.baseDrain, 0));
    pushDetailField(upgradeFields, t('mkt.field.fusionLimit'), formatNumber(detail.fusionLimit, 0));
    pushDetailField(upgradeFields, t('mkt.field.maxRank'), formatNumber(detail.maxRank, 0));
    pushDetailField(upgradeFields, t('mkt.field.mastery'), formatNumber(detail.masteryReq, 0));
    if (upgradeFields.length > 0) {
      sections.push({ title: detailKind === 'arcane' ? t('mkt.section.arcaneProfile') : t('mkt.section.modProfile'), fields: upgradeFields });
    }
  }

  if (detailKind === 'weapon' || detailKind === 'component') {
    const combatFields: ItemDetailField[] = [];
    pushDetailField(combatFields, t('mkt.field.totalDamage'), formatNumber(detail.totalDamage, 1));
    pushDetailField(combatFields, t('mkt.field.critChance'), formatStatPercent(detail.criticalChance));
    pushDetailField(combatFields, t('mkt.field.critMult'), formatMultiplier(detail.criticalMultiplier));
    pushDetailField(combatFields, t('mkt.field.statusChance'), formatStatPercent(detail.statusChance));
    pushDetailField(combatFields, t('mkt.field.fireRate'), formatNumber(detail.fireRate, 2));
    pushDetailField(combatFields, t('mkt.field.reload'), detail.reloadTime !== null ? `${formatNumber(detail.reloadTime, 2)}s` : '—');
    pushDetailField(combatFields, t('mkt.field.magazine'), formatNumber(detail.magazineSize, 0));
    pushDetailField(combatFields, t('mkt.field.multishot'), formatNumber(detail.multishot, 0));
    pushDetailField(combatFields, t('mkt.field.disposition'), formatNumber(detail.disposition, 0));
    pushDetailField(combatFields, t('mkt.field.range'), formatNumber(detail.range, 1));
    if (combatFields.length > 0) {
      sections.push({ title: detailKind === 'component' ? t('mkt.section.componentCombat') : t('mkt.section.combatStats'), fields: combatFields });
    }

    const handlingFields: ItemDetailField[] = [];
    pushDetailField(handlingFields, t('mkt.field.trigger'), detail.trigger ?? '—');
    pushDetailField(handlingFields, t('mkt.field.fieldNoise'), detail.noise ?? '—');
    pushDetailField(handlingFields, t('mkt.field.followThrough'), formatNumber(detail.followThrough, 2));
    pushDetailField(handlingFields, t('mkt.field.blockingAngle'), formatNumber(detail.blockingAngle, 0));
    pushDetailField(handlingFields, t('mkt.field.comboDuration'), formatNumber(detail.comboDuration, 1));
    pushDetailField(handlingFields, t('mkt.field.heavyAttack'), formatNumber(detail.heavyAttackDamage, 0));
    pushDetailField(handlingFields, t('mkt.field.slamAttack'), formatNumber(detail.slamAttack, 0));
    pushDetailField(handlingFields, t('mkt.field.heavySlam'), formatNumber(detail.heavySlamAttack, 0));
    pushDetailField(handlingFields, t('mkt.field.windUp'), detail.windUp !== null ? `${formatNumber(detail.windUp, 2)}s` : '—');
    if (handlingFields.length > 0) {
      sections.push({ title: t('mkt.section.handling'), fields: handlingFields });
    }
  }

  if (detailKind === 'warframe') {
    const baseStatFields: ItemDetailField[] = [];
    pushDetailField(baseStatFields, t('mkt.field.health'), formatNumber(detail.health, 0));
    pushDetailField(baseStatFields, t('mkt.field.shield'), formatNumber(detail.shield, 0));
    pushDetailField(baseStatFields, t('mkt.field.armor'), formatNumber(detail.armor, 0));
    pushDetailField(baseStatFields, t('mkt.field.sprintSpeed'), formatNumber(detail.sprintSpeed, 2));
    pushDetailField(baseStatFields, t('mkt.field.power'), formatNumber(detail.power, 0));
    pushDetailField(baseStatFields, t('mkt.field.stamina'), formatNumber(detail.stamina, 0));
    pushDetailField(baseStatFields, t('mkt.field.mastery'), formatNumber(detail.masteryReq, 0));
    if (baseStatFields.length > 0) {
      sections.push({ title: t('mkt.section.baseStats'), fields: baseStatFields });
    }

    const kitFields: ItemDetailField[] = [];
    pushDetailField(kitFields, t('mkt.field.abilities'), detail.abilityNames.length > 0 ? detail.abilityNames.join(', ') : '—');
    pushDetailField(kitFields, t('mkt.field.polarities'), detail.polarities.length > 0 ? detail.polarities.join(', ') : '—');
    if (kitFields.length > 0) {
      sections.push({ title: t('mkt.section.kit'), fields: kitFields });
    }
  }

  if (detailKind === 'relic') {
    const relicFields: ItemDetailField[] = [];
    pushDetailField(relicFields, t('mkt.field.tier'), detail.relicTier ?? '—');
    pushDetailField(relicFields, t('mkt.field.code'), detail.relicCode ?? '—');
    pushDetailField(relicFields, t('mkt.field.release'), formatDateCompact(detail.releaseDate));
    pushDetailField(relicFields, t('mkt.field.estVault'), formatDateCompact(detail.estimatedVaultDate));
    pushDetailField(relicFields, t('mkt.field.vaultDate'), formatDateCompact(detail.vaultDate));
    pushDetailField(relicFields, t('mkt.field.itemCount'), formatNumber(detail.itemCount, 0));
    if (relicFields.length > 0) {
      sections.push({ title: t('mkt.section.relicProfile'), fields: relicFields });
    }
  }

  if (detailKind === 'set') {
    const setFields: ItemDetailField[] = [];
    pushDetailField(setFields, t('mkt.field.itemCount'), formatNumber(detail.itemCount, 0));
    pushDetailField(setFields, t('mkt.field.release'), formatDateCompact(detail.releaseDate));
    pushDetailField(setFields, t('mkt.field.estVault'), formatDateCompact(detail.estimatedVaultDate));
    pushDetailField(setFields, t('mkt.field.vaultDate'), formatDateCompact(detail.vaultDate));
    pushDetailField(setFields, t('mkt.field.ducats'), formatNumber(detail.ducats, 0));
    if (setFields.length > 0) {
      sections.push({ title: t('mkt.section.setProfile'), fields: setFields });
    }
  }

  if (detailKind === 'component' || detailKind === 'resource' || detailKind === 'generic') {
    const profileFields: ItemDetailField[] = [];
    pushDetailField(profileFields, t('mkt.field.productCategory'), detail.productCategory ?? '—');
    pushDetailField(profileFields, t('mkt.field.parents'), detail.parentNames.length > 0 ? detail.parentNames.join(', ') : '—');
    pushDetailField(profileFields, t('mkt.field.buildPrice'), formatNumber(detail.buildPrice, 0));
    pushDetailField(profileFields, t('mkt.field.buildQty'), formatNumber(detail.buildQuantity, 0));
    pushDetailField(profileFields, t('mkt.field.buildTime'), formatDurationSeconds(detail.buildTime));
    pushDetailField(profileFields, t('mkt.field.skipBuild'), formatNumber(detail.skipBuildTimePrice, 0));
    pushDetailField(profileFields, t('mkt.field.marketCost'), formatNumber(detail.marketCost, 0));
    pushDetailField(profileFields, t('mkt.field.ducats'), formatNumber(detail.ducats, 0));
    if (profileFields.length > 0) {
      sections.push({ title: detailKind === 'component' ? t('mkt.section.componentProfile') : t('mkt.section.itemProfile'), fields: profileFields });
    }
  }

  if (detail.attackNames.length > 0 && (detailKind === 'weapon' || detailKind === 'component')) {
    sections.push({
      title: t('mkt.section.attackModes'),
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

interface DisplayDropSource {
  key: string;
  location: string;
  rarity: string | null;
  chance: number | null;
  sourceType: string | null;
  imagePath: string | null;
  isRelic: boolean;
}

function normalizeRelicLocation(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const relicMatch = value.match(/\b(lith|meso|neo|axi)\s+([a-z0-9]+)\b/i);
  if (!relicMatch) {
    return null;
  }

  const tier = relicMatch[1].charAt(0).toUpperCase() + relicMatch[1].slice(1).toLowerCase();
  const code = relicMatch[2].toUpperCase();
  return `${tier} ${code} Relic`;
}

function isRelicDropSource(location: string | null | undefined, sourceType: string | null | undefined): boolean {
  const normalizedType = normalizeMatchValue(sourceType);
  if (normalizedType?.includes('relic')) {
    return true;
  }
  return normalizeRelicLocation(location) !== null;
}

function buildDisplayDropSources(
  dropSources: Array<{
    location: string;
    chance: number | null;
    rarity: string | null;
    sourceType: string | null;
  }>,
  autocompleteItems: WfmAutocompleteItem[],
): DisplayDropSource[] {
  const relicImageByName = new Map<string, string | null>();
  autocompleteItems.forEach((item) => {
    // Category detection has to read the ENGLISH name — `item.name` is localized, so matching
    // " relic" against it silently classifies nothing once the app is in another language.
    if (!(item.nameEn ?? item.name).toLowerCase().includes(' relic')) {
      return;
    }

    const normalizedName = normalizeMatchValue(item.name);
    if (!normalizedName || relicImageByName.has(normalizedName)) {
      return;
    }

    relicImageByName.set(normalizedName, item.imagePath);
  });

  const uniqueRelics = new Map<string, DisplayDropSource>();
  const otherSources: DisplayDropSource[] = [];

  dropSources.forEach((source) => {
    if (!isRelicDropSource(source.location, source.sourceType)) {
      otherSources.push({
        key: `${source.location}-${source.sourceType ?? 'none'}`,
        location: source.location,
        rarity: source.rarity,
        chance: source.chance,
        sourceType: source.sourceType,
        imagePath: null,
        isRelic: false,
      });
      return;
    }

    const normalizedRelicName = normalizeRelicLocation(source.location);
    if (!normalizedRelicName) {
      return;
    }

    const existing = uniqueRelics.get(normalizedRelicName);
    if (existing) {
      if (!existing.rarity && source.rarity) {
        existing.rarity = source.rarity;
      }
      return;
    }

    uniqueRelics.set(normalizedRelicName, {
      key: normalizedRelicName,
      location: normalizedRelicName,
      rarity: source.rarity,
      chance: source.chance,
      sourceType: 'relic',
      imagePath: relicImageByName.get(normalizeMatchValue(normalizedRelicName) ?? '') ?? null,
      isRelic: true,
    });
  });

  return [...uniqueRelics.values(), ...otherSources];
}

interface EventContextEntry {
  label: string;
  impact: string;
}

function buildEventContextConfidence(entries: EventContextEntry[], t: TranslateFn): MarketConfidenceSummary {
  if (entries.length === 0) {
    return {
      level: 'low',
      label: t('mkt.conf.low'),
      reasons: [t('mkt.noActiveCtx')],
      isDegraded: true,
    };
  }

  const hasDirectRetailHook = entries.some((entry) =>
    [
      t('mkt.event.voidTrader'),
      t('mkt.event.flashSale'),
      t('mkt.event.alertReward'),
      t('mkt.event.invasionReward'),
    ].includes(entry.label),
  );

  if (hasDirectRetailHook || entries.length >= 2) {
    return {
      level: 'high',
      label: t('mkt.conf.high'),
      reasons: [],
      isDegraded: false,
    };
  }

  return {
    level: 'medium',
    label: t('mkt.conf.medium'),
    reasons: [t('mkt.indirectCtx')],
    isDegraded: true,
  };
}

function ConfidenceBadge({
  confidence,
}: {
  confidence: MarketConfidenceSummary | null | undefined;
}) {
  const { t } = useTranslation();
  if (!confidence) {
    return null;
  }

  return (
    <span className={`market-panel-badge tone-${getConfidenceTone(confidence)}`}>
      {tConfidence(t, confidence)}
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
  t: TranslateFn,
  analysis: ItemAnalysisResponse | null,
  eventData: {
    alerts: ReturnType<typeof useAppStore.getState>['worldStateAlerts'];
    events: ReturnType<typeof useAppStore.getState>['worldStateEvents'];
    invasions: ReturnType<typeof useAppStore.getState>['worldStateInvasions'];
    syndicateMissions: ReturnType<typeof useAppStore.getState>['worldStateSyndicateMissions'];
    voidTrader: ReturnType<typeof useAppStore.getState>['worldStateVoidTrader'];
    flashSales: ReturnType<typeof useAppStore.getState>['worldStateFlashSales'];
    vaultTraderPayload: unknown;
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
        label: t('mkt.event.alertReward'),
        impact: t('mkev.alertImpact', { node: alert.mission?.node ?? t('mkt.unknownNode') }),
      });
    }
  }

  for (const event of eventData.events) {
    const rewardItems = event.rewards.flatMap((reward) => reward.items);
    if (rewardItems.some((item) => containsItemMatch(item, matchNeedles))) {
      entries.push({
        label: t('mkt.event.activeEvent'),
        impact: t('mkev.eventImpact', { event: event.description }),
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
        label: t('mkt.event.invasionReward'),
        impact: t('mkev.invasionImpact', { node: invasion.node ?? t('mkt.unknownNode') }),
      });
    }
  }

  for (const mission of eventData.syndicateMissions) {
    const rewardItems = mission.jobs.flatMap((job) => job.rewardPool);
    if (rewardItems.some((item) => containsItemMatch(item, matchNeedles))) {
      entries.push({
        label: t('mkt.event.syndicateMission'),
        impact: t('mkev.syndicateImpact', { syndicate: mission.syndicate ?? t('mkt.syndicate') }),
      });
    }
  }

  if (
    eventData.voidTrader?.inventory.some((entry) =>
      containsItemMatch(entry.item, matchNeedles),
    )
  ) {
    entries.push({
      label: t('mkt.event.voidTrader'),
      impact: t('mkev.baroImpact'),
    });
  }

  if (
    eventData.flashSales.some((entry) =>
      containsItemMatch(entry.item, matchNeedles),
    )
  ) {
    entries.push({
      label: t('mkt.event.flashSale'),
      impact: t('mkev.flashImpact'),
    });
  }

  // Varzia doesn't sell the relics themselves as a searchable item — she sells the warframe/
  // weapon whose relics she's carrying that cycle (see `parseVaultTraderPayload`). This is
  // matched by SLUG, not fuzzy name matching like the other event sources above: her item's own
  // slug is the affected set bundle, but every one of that set's COMPONENT slugs is affected too
  // (e.g. selling "Titania Prime" puts titania_prime_set, titania_prime_blueprint,
  // titania_prime_neuroptics_blueprint, titania_prime_chassis_blueprint, and
  // titania_prime_systems_blueprint all in extra relic supply) — `affectedSlugs` already carries
  // that full expansion from the backend, which has the catalog's set_parts data to build it.
  const vaultTrader = parseVaultTraderPayload(eventData.vaultTraderPayload);
  if (
    vaultTrader?.active &&
    vaultTrader.tradeableItems.some((entry) => entry.affectedSlugs.includes(analysis.itemDetails.slug))
  ) {
    entries.push({
      label: t('mkt.event.vaultTrader'),
      impact: t('mkev.varziaImpact'),
    });
  }

  return entries;
}

function EmptyAnalyticsState({
  title,
  body,
  actionLabel = null,
  onAction = null,
}: {
  title?: string;
  body: string;
  actionLabel?: string | null;
  onAction?: (() => void) | null;
}) {
  const { t } = useTranslation();
  const resolvedTitle = title ?? t('mkt.emptyReady');

  return (
    <div className="market-empty-state">
      <span className="empty-primary">{resolvedTitle}</span>
      <span className="empty-sub">{body}</span>
      {actionLabel && onAction ? (
        <button type="button" className="market-empty-state-action" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

function MarketInlineNotice({
  tone,
  message,
}: {
  tone: 'warning' | 'error';
  message: string;
}) {
  return (
    <div
      className={
        tone === 'warning'
          ? 'settings-inline-warning market-inline-notice'
          : 'settings-inline-error market-inline-notice'
      }
    >
      {message}
    </div>
  );
}

/**
 * What a panel is currently able to show.
 *
 * `idle`   — nothing selected. The panel's shape is drawn but inert, so the page reads as a real
 *            interface waiting for input rather than one empty sentence where the UI should be.
 * `loading`— selected, data not in yet. Same shape, now pulsing.
 * `ready`  — data present.
 *
 * The three share one skeleton shape on purpose: idle and loading differ only by the pulse, so
 * nothing moves or resizes as a panel walks through the states. That is the whole point — the
 * page must not reflow while it fills in.
 */
type PanelPhase = 'idle' | 'loading' | 'ready';

/**
 * Panel contents for the current phase.
 *
 * Replaces `PanelOverlay`, which put a **spinner** over the panel — the interface-polish skill's
 * rule 5 is skeletons, not spinners, precisely because the content's shape is known here.
 * Errors still take over the body, because a failed panel has nothing to show.
 */
function PanelBody({
  phase,
  skeleton,
  errorMessage,
  children,
}: {
  phase: PanelPhase;
  /** Skeleton composition string matching this panel's real layout. */
  skeleton: string;
  errorMessage?: string | null;
  children: ReactNode;
}) {
  if (errorMessage) {
    return <p className="text-[11px] text-accent-red">{errorMessage}</p>;
  }
  if (phase === 'ready') {
    return <>{children}</>;
  }
  return (
    <Skeleton
      type={skeleton}
      // Idle is the same shape holding still. `animate-none` also means an unselected page is
      // not sitting there pulsing at the user with nothing loading.
      leafClassName={phase === 'idle' ? 'animate-none opacity-25' : undefined}
    />
  );
}

function AnalyticsPanel({
  title,
  info,
  children,
  phase = 'ready',
  skeleton = 'text@4',
  errorMessage = null,
  className = '',
  headerAside = null,
}: {
  title: string;
  info?: string;
  children: ReactNode;
  phase?: PanelPhase;
  /** Skeleton composition matching this panel's real body. Defaults to a metric grid. */
  skeleton?: string;
  errorMessage?: string | null;
  className?: string;
  headerAside?: ReactNode;
}) {

  return (
    // Panel primitive, not `.card market-panel`. The accent used to paint a coloured top edge on
    // every panel; with 14 of them on screen that was decoration spending the accent palette,
    // which ELEMENTS.md §3 reserves for meaning. The eyebrow already says what the panel is.
    <Panel className={`gap-0 ${className}`.trim()}>
      <PanelHeader className="min-h-0 gap-2 border-b-0 px-4 pt-4 pb-0">
        {/* No eyebrow. Every panel used to carry a second label above its title — "Observatory
            Tape", "Analytics Carryover", "Execution Model" — category words that sound meaningful
            and say nothing the title does not. A section heading is the noun, with nothing above
            or below it. */}
        <div className="flex min-w-0 flex-col gap-0.5">
          {/* Panel titles are Inter 13/600 in full-strength ink, not the mono micro-label the
              primitive defaults to. That treatment is right for a dense sub-label but reads as a
              caption when it is the only heading a panel has. */}
          <PanelTitle variant="heading" className="flex items-center gap-1.5">
            <span className="truncate">{title}</span>
            {info ? <InfoHint text={info} /> : null}
          </PanelTitle>
        </div>
        {/* Suppressed while idle: a status badge with nothing selected asserts something about
            nothing — "0 matches" and "low confidence" were being claimed about an empty page. */}
        {headerAside && phase !== 'idle' ? (
          <div className="ml-auto shrink-0">{headerAside}</div>
        ) : null}
      </PanelHeader>
      {/* Generous padding is the point — see ELEMENTS.md §5c. The metrics inside no longer carry
          their own borders, so the panel's own space is what separates them. */}
      <div className="relative flex min-h-20 flex-1 flex-col gap-4 p-4">
        <PanelBody phase={phase} skeleton={skeleton} errorMessage={errorMessage}>
          {children}
        </PanelBody>
      </div>
    </Panel>
  );
}

function AnalyticsTab() {
  const { t } = useTranslation();
  const pageContentRef = useRef<HTMLDivElement | null>(null);
  const analyticsIdentityRef = useRef<string | null>(null);
  const selectedItem = useAppStore((state) => state.quickView.selectedItem);
  const itemNameMap = useAppStore((state) => state.itemNameMap);
  const marketVariants = useAppStore((state) => state.marketVariants);
  const marketVariantsLoading = useAppStore((state) => state.marketVariantsLoading);
  const marketVariantsError = useAppStore((state) => state.marketVariantsError);
  const loadQuickViewItem = useAppStore((state) => state.loadQuickViewItem);
  const sellerMode = useAppStore((state) => state.sellerMode);
  const selectedMarketVariantKey = useAppStore((state) => state.selectedMarketVariantKey);
  const [analytics, setAnalytics] = useState<ItemAnalyticsResponse | null>(null);
  const [backtestSummary, setBacktestSummary] = useState<BacktestSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [trendTab, setTrendTab] = useState<'lowestSell' | 'medianSell' | 'weightedAvg'>('lowestSell');
  const [chartDomain, setChartDomain] = useState<ChartDomainKey>('48h');
  const [chartBucket, setChartBucket] = useState<ChartBucketKey>('1h');
  // Panels used to be gated behind an 85ms staggered `revealedPanels` map. That existed to make
  // one all-at-once payload *look* progressive. The backend now genuinely answers in two waves
  // (cached, then live), so the stagger would only delay real data behind a fake animation.
  

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
    if (!selectedItem || !selectedMarketVariantKey || !selectedItem.wfmId) {
      analyticsIdentityRef.current = null;
      setAnalytics(null);
      setLoading(false);
      setErrorMessage(null);
      return;
    }

    let isMounted = true;
    const itemKey = selectedItem.wfmId;
    const selectionIdentity = buildMarketSelectionIdentity(
      selectedItem.itemId,
      selectedMarketVariantKey,
      sellerMode,
    );
    const canKeepCurrentSnapshot =
      Boolean(selectionIdentity)
      && analyticsIdentityRef.current === selectionIdentity
      && analytics !== null;
    setLoading(true);
    setErrorMessage(null);
    if (!canKeepCurrentSnapshot) {
      setAnalytics(null);
    }

    void getItemAnalytics(
      itemKey,
      selectedItem.slug,
      selectedMarketVariantKey,
      sellerMode,
      chartDomain,
      chartBucket,
    )
      .then((response) => {
        if (!isMounted) {
          return;
        }
        analyticsIdentityRef.current = selectionIdentity;
        setAnalytics(response);
        setLoading(false);
        setErrorMessage(null);
      })
      .catch((error) => {
        if (!isMounted) {
          return;
        }
        const friendlyMessage = formatMarketErrorMessage(
          canKeepCurrentSnapshot ? 'market-analytics-refresh' : 'market-analytics-load',
          error,
        );
        if (!canKeepCurrentSnapshot) {
          analyticsIdentityRef.current = null;
          setAnalytics(null);
        }
        setLoading(false);
        setErrorMessage(friendlyMessage);
      });

    return () => {
      isMounted = false;
      void stopMarketTracking(
        itemKey,
        selectedItem.slug,
        selectedMarketVariantKey,
        'analytics',
      ).catch(() => undefined);
    };
  }, [selectedItem, selectedMarketVariantKey, refreshNonce, chartDomain, chartBucket, sellerMode]);

  useEffect(() => {
    let isMounted = true;
    getBacktestSummary()
      .then((summary) => {
        if (isMounted) {
          setBacktestSummary(summary);
        }
      })
      .catch(() => undefined);
    return () => {
      isMounted = false;
    };
  }, []);

  const trendMetrics =
    analytics?.trendQualityBreakdown.tabs[trendTab] ??
    analytics?.trendQualityBreakdown.tabs.lowestSell;
  const analyticsPanelError = analytics ? null : errorMessage;
  /**
   * `idle` when nothing is selected, so the panels render as inert shells rather than being
   * replaced by a single empty sentence — the page should look like the interface it is while it
   * waits for input. `ready` the moment data exists, which is what makes the fill-in progressive:
   * the cached build lands first and panels populate from it, then the live build replaces it.
   */
  const analyticsPhase: PanelPhase = !selectedItem ? 'idle' : analytics ? 'ready' : 'loading';

  // NOTE: no early return for "nothing selected". The panels below are null-safe and render as
  // inert shells in `idle`, so the page shows the interface you are about to use instead of
  // replacing it with one sentence. The prompt to pick an item is a notice above the grid.

  // While item variants are still loading we deliberately fall through to the real
  // analytics layout below. Every panel (and the chart) is null-safe and shows its
  // own loading state, so the surface looks
  // exactly like the loaded version with content pending — no separate skeleton.

  if (marketVariantsError && marketVariants.length === 0 && !selectedMarketVariantKey) {
    return (
      <div className="page-content">
        <EmptyAnalyticsState
          title={t('a11y.analyticsFailed')}
          body={marketVariantsError}
          actionLabel={t('common.retry')}
          onAction={() => {
            if (selectedItem) {
              void loadQuickViewItem(selectedItem);
            }
          }}
        />
      </div>
    );
  }

  if (marketVariants.length > 1 && !selectedMarketVariantKey) {
    return (
      <div className="page-content">
        <EmptyAnalyticsState body={t('mkb.pickRankCharts')} />
        {marketVariantsError ? <MarketInlineNotice tone="error" message={marketVariantsError} /> : null}
      </div>
    );
  }

  return (
    <div ref={pageContentRef} className="page-content market-page-content">
      {errorMessage && analytics ? (
        <MarketInlineNotice tone="warning" message={errorMessage} />
      ) : null}
      {errorMessage && !analytics && !loading ? (
        <EmptyAnalyticsState
          title={t('a11y.analyticsFailed')}
          body={errorMessage}
          actionLabel={t('common.retry')}
          onAction={() => setRefreshNonce((value) => value + 1)}
        />
      ) : null}
      {/* Always rendered — see the note in AnalysisTab. Panels are null-safe and draw as inert
          shells in `idle`, so the interface stays on screen while it waits for a selection. */}
      <>
      {/* One provenance stamp, matching the rest of the app (Home's "Priced 1d ago",
          Opportunities' "Prices 1d ago" beside Refresh). This was three separate pills —
          Snapshot / Stats / Computed — each a full absolute datetime. Three timestamps for one
          question is two too many, and "computed" is the only one that describes what is on
          screen: the other two are inputs to it. */}
      <div className="flex items-center gap-3 px-4 pt-3">
        <span className="font-mono text-[10px] text-ink-faint tabular-nums">
          {t('mkt.fresh.computed')} {formatRelativeTimestamp(analytics?.computedAt ?? null)}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto text-ink-dim hover:text-ink"
          aria-label={t('market.refreshAnalytics')}
          title={t('market.refreshAnalytics')}
          onClick={() => setRefreshNonce((value) => value + 1)}
        >
          <RefreshIcon />
        </Button>
      </div>
      <StaticAnalyticsChart
        itemName={selectedItem ? resolveLocalizedName(itemNameMap, selectedItem) : ''}
        analytics={analytics}
        loading={loading || marketVariantsLoading}
        errorMessage={analyticsPanelError}
        domain={chartDomain}
        bucket={chartBucket}
        onDomainChange={setChartDomain}
        onBucketChange={setChartBucket}
      />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <AnalyticsPanel
              title={t('a11y.entryExitOverview')}
              info={t('mki.zones')}
              phase={analyticsPhase}
              errorMessage={analyticsPanelError}
              headerAside={<ConfidenceBadge confidence={analytics?.entryExitZoneOverview.confidenceSummary} />}
            >
              <MetricGrid>
                <Metric label={t('mkt.currentLowest')} value={formatPrice(analytics?.entryExitZoneOverview.currentLowestPrice)} />
                <Metric label={t('mkt.medianLowest')} value={formatPrice(analytics?.entryExitZoneOverview.currentMedianLowestPrice)} />
                <Metric
                  label={t('mkt.fairValueBand')}
                  value={`${formatPrice(analytics?.entryExitZoneOverview.fairValueLow)} - ${formatPrice(analytics?.entryExitZoneOverview.fairValueHigh)}`}
                />
                <Metric label={t('mkt.zoneQuality')} value={tHealth(t, analytics?.entryExitZoneOverview.zoneQuality) || '—'} />
              </MetricGrid>
              <div className="market-copy-block">
                <span className="market-copy-title">{t('mkt.entryZone')}</span>
                <span>
                  {formatPrice(analytics?.entryExitZoneOverview.entryZoneLow)} - {formatPrice(analytics?.entryExitZoneOverview.entryZoneHigh)}
                </span>
                <p>{tEntryRationale(t, analytics?.entryExitZoneOverview.entryRationale, analytics?.entryExitZoneOverview.confidenceSummary) || '—'}</p>
              </div>
              <div className="market-copy-block">
                <span className="market-copy-title">{t('mkt.exitZone')}</span>
                <span>
                  {formatPrice(analytics?.entryExitZoneOverview.exitZoneLow)} - {formatPrice(analytics?.entryExitZoneOverview.exitZoneHigh)}
                </span>
                <p>{tExitRationale(t, analytics?.entryExitZoneOverview.exitRationale, analytics?.entryExitZoneOverview.confidenceSummary) || '—'}</p>
              </div>
              <ConfidenceNote confidence={analytics?.entryExitZoneOverview.confidenceSummary} />
            </AnalyticsPanel>

            <AnalyticsPanel
              title={t('a11y.orderbookPressure')}
              info={t('mki.orderbook')}
              phase={analyticsPhase}
              errorMessage={analyticsPanelError}
              headerAside={<ConfidenceBadge confidence={analytics?.orderbookPressure.confidenceSummary} />}
            >
              <MetricGrid>
                <Metric label={t('mkt.cheapestSell')} value={formatPrice(analytics?.orderbookPressure.cheapestSell)} />
                <Metric label={t('mkt.highestBuy')} value={formatPrice(analytics?.orderbookPressure.highestBuy)} />
                <Metric
                  label={t('mkt.spread')}
                  value={`${formatPrice(analytics?.orderbookPressure.spread)} · ${formatPercent(analytics?.orderbookPressure.spreadPct)}`}
                />
                <Metric label={t('mkt.pressure')} value={tHealth(t, analytics?.orderbookPressure.pressureLabel) || '—'} />
              </MetricGrid>
              <div className="market-pressure-row">
                <div>
                  <span className="market-copy-title">{t('mkt.entryDepth')}</span>
                  <span>{t('mkt.visibleQuantity', { n: formatNumber(analytics?.orderbookPressure.entryDepth, 0) })}</span>
                </div>
                <div>
                  <span className="market-copy-title">{t('mkt.exitDepth')}</span>
                  <span>{t('mkt.visibleQuantity', { n: formatNumber(analytics?.orderbookPressure.exitDepth, 0) })}</span>
                </div>
                <div>
                  <span className="market-copy-title">{t('mkt.pressureRatio')}</span>
                  <span>{formatNumber(analytics?.orderbookPressure.pressureRatio, 2)}</span>
                </div>
              </div>
              <ConfidenceNote confidence={analytics?.orderbookPressure.confidenceSummary} />
            </AnalyticsPanel>

            <AnalyticsPanel
              title={t('a11y.trendQualityBreakdown')}
              info={t('mki.trend')}
              phase={analyticsPhase}
              errorMessage={analyticsPanelError}
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
                    {key === 'lowestSell' ? t('mkt.trend.lowestSell') : key === 'medianSell' ? t('mkt.trend.medianLowest') : t('mkt.trend.weightedAvg')}
                  </button>
                ))}
              </div>
              <MetricGrid>
                <Metric label={t('mkt.slope1h')} value={formatPercent(trendMetrics?.slope1h)} />
                <Metric label={t('mkt.slope3h')} value={formatPercent(trendMetrics?.slope3h)} />
                <Metric label={t('mkt.slope6h')} value={formatPercent(trendMetrics?.slope6h)} />
                <Metric label={t('mkt.confidence')} value={formatPercent(trendMetrics?.confidence)} />
              </MetricGrid>
              <div className="market-copy-block">
                <span className="market-copy-title">{t('mkt.crossSignal')}</span>
                <p>{tHealth(t, trendMetrics?.crossSignal) || '—'}</p>
              </div>
              <div className="market-copy-block">
                <span className="market-copy-title">{t('mkt.reversal')}</span>
                <p>{tHealth(t, trendMetrics?.reversal) || '—'}</p>
              </div>
              <div className="market-signal-list">
                {(trendMetrics?.confirmingSignals ?? []).map((signal) => (
                  <span key={signal} className="market-signal-pill">{tHealth(t, signal)}</span>
                ))}
              </div>
              <div className="market-pressure-row">
                <div>
                  <span className="market-copy-title">{t('mkt.stability')}</span>
                  <span>{formatPercent(analytics?.trendQualityBreakdown.stability)}</span>
                </div>
                <div>
                  <span className="market-copy-title">{t('mkt.volatility')}</span>
                  <span>{formatPercent(analytics?.trendQualityBreakdown.volatility)}</span>
                </div>
                <div>
                  <span className="market-copy-title">{t('mkt.noise')}</span>
                  <span>{formatPercent(analytics?.trendQualityBreakdown.noise)}</span>
                </div>
              </div>
              <ConfidenceNote confidence={analytics?.trendQualityBreakdown.confidenceSummary} />
            </AnalyticsPanel>

            <AnalyticsPanel
              title={t('a11y.actionCard')}
              info={t('mki.action')}
              phase={analyticsPhase}
              errorMessage={analyticsPanelError}
              headerAside={<ConfidenceBadge confidence={analytics?.actionCard.confidenceSummary} />}
            >
              <div className={`market-action-card tone-${analytics?.actionCard.tone ?? 'neutral'}`}>
                <div className="market-action-header">
                  <span className="market-action-label">{t('mkt.suggestedAction')}</span>
                  <span className="market-action-value">{tHealth(t, analytics?.actionCard.suggestedAction) || '—'}</span>
                </div>
                <MetricGrid>
                  <Metric label={t('mkt.zoneQuality')} value={tHealth(t, analytics?.actionCard.zoneQuality) || '—'} />
                  <Metric label={t('mkt.zoneAdjustedEdge')} value={formatPrice(analytics?.actionCard.zoneAdjustedEdge)} />
                  <Metric
                    label={t('mkt.spread')}
                    value={`${formatPrice(analytics?.actionCard.spread)} · ${formatPercent(analytics?.actionCard.spreadPct)}`}
                  />
                  <Metric label={t('mkt.bookBias')} value={tHealth(t, analytics?.actionCard.pressureLabel) || '—'} />
                </MetricGrid>
                <p className="market-action-rationale">{tActionRationale(t, analytics?.actionCard.rationale, analytics?.actionCard.confidenceSummary) || '—'}</p>
                <div className="market-signal-list">
                  {(analytics?.actionCard.alignedSignals ?? []).map((signal) => (
                    <span key={signal} className="market-signal-pill">{tHealth(t, signal)}</span>
                  ))}
                </div>
                <ConfidenceNote confidence={analytics?.actionCard.confidenceSummary} />
                <ActionCardTrackRecord
                  action={analytics?.actionCard.suggestedAction ?? null}
                  backtestSummary={backtestSummary}
                />
              </div>
            </AnalyticsPanel>
          </div>
      </>
    </div>
  );
}

function ActionCardTrackRecord({
  action,
  backtestSummary,
}: {
  action: string | null;
  backtestSummary: BacktestSummary | null;
}) {
  const { t } = useTranslation();
  if (!action || !backtestSummary) return null;

  const stats = backtestSummary.buyTradeStats.find((s) => s.label === action);

  if (!stats || stats.tradeCount < 5 || stats.hitRate === null || stats.medianReturnPct === null) {
    return null;
  }

  const hitPct = Math.round(stats.hitRate * 100);
  const returnSign = stats.medianReturnPct >= 0 ? '+' : '';
  const dayNote = stats.medianDaysHeld !== null ? ` over ~${stats.medianDaysHeld.toFixed(1)}d` : '';
  const tone =
    stats.medianReturnPct >= 5 ? 'green' : stats.medianReturnPct >= 0 ? 'amber' : 'red';

  return (
    <div className={`market-track-record tone-${tone}`}>
      <span className="market-track-record-label">{t('mkt.trackRecord')}</span>
      <span>
        {`${action} signals here: ${hitPct}% hit rate, median ${returnSign}${stats.medianReturnPct.toFixed(1)}%${dayNote} (${stats.tradeCount} graded trades)`}
      </span>
    </div>
  );
}

function AnalysisTab() {
  const { t } = useTranslation();
  const pageContentRef = useRef<HTMLDivElement | null>(null);
  const selectedItem = useAppStore((state) => state.quickView.selectedItem);
  const itemNameMap = useAppStore((state) => state.itemNameMap);
  const marketVariants = useAppStore((state) => state.marketVariants);
  const marketVariantsError = useAppStore((state) => state.marketVariantsError);
  const loadQuickViewItem = useAppStore((state) => state.loadQuickViewItem);
  const selectedMarketVariantKey = useAppStore((state) => state.selectedMarketVariantKey);
  const analysis = useAppStore((state) => state.selectedMarketAnalysis);
  const analysisLoading = useAppStore((state) => state.selectedMarketAnalysisLoading);
  const analysisError = useAppStore((state) => state.selectedMarketAnalysisError);
  /** Same three-phase rule as Analytics — see `analyticsPhase`. */
  const analysisPhase: PanelPhase = !selectedItem ? 'idle' : analysis ? 'ready' : 'loading';
  const loadSelectedMarketAnalysis = useAppStore((state) => state.loadSelectedMarketAnalysis);
  const addExplicitItemToWatchlist = useAppStore((state) => state.addExplicitItemToWatchlist);
  const worldStateAlerts = useAppStore((state) => state.worldStateAlerts);
  const worldStateEvents = useAppStore((state) => state.worldStateEvents);
  const worldStateInvasions = useAppStore((state) => state.worldStateInvasions);
  const worldStateSyndicateMissions = useAppStore((state) => state.worldStateSyndicateMissions);
  const worldStateVoidTrader = useAppStore((state) => state.worldStateVoidTrader);
  const worldStateFlashSales = useAppStore((state) => state.worldStateFlashSales);
  const worldStateVaultTrader = useAppStore((state) => state.worldStateExtra['vault-trader'].payload);
  const [itemDetails, setItemDetails] = useState<ItemDetailSummary | null>(null);
  const [, setItemDetailsLoading] = useState(false);
  const [itemDetailsError, setItemDetailsError] = useState<string | null>(null);
  const [componentTargets, setComponentTargets] = useState<Record<string, string>>({});
  const [watchlistAddFeedback, setWatchlistAddFeedback] = useState<Record<string, boolean>>({});
  const [autocompleteItems, setAutocompleteItems] = useState<WfmAutocompleteItem[]>([]);
  const watchlistAddFeedbackTimeoutsRef = useRef(new Map<string, number>());

  useEffect(() => {
    let isMounted = true;
    void getWfmAutocompleteItems(useAppStore.getState().language)
      .then((items) => {
        if (!isMounted) {
          return;
        }
        setAutocompleteItems(items);
      })
      .catch((error) => {
        console.error('Failed to load WFM autocomplete items for relic images', error);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(
    () => () => {
      clearWatchlistAddFeedbackTimeouts(watchlistAddFeedbackTimeoutsRef);
    },
    [],
  );

  useEffect(() => {
    pageContentRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [selectedItem?.itemId, selectedMarketVariantKey]);

  useEffect(() => {
    if (!selectedItem || !selectedMarketVariantKey || !selectedItem.wfmId) {
      setItemDetails(null);
      setItemDetailsLoading(false);
      setItemDetailsError(null);
      setComponentTargets({});
      return;
    }

    let isMounted = true;
    setItemDetails(null);
    setItemDetailsLoading(true);
    setItemDetailsError(null);
    setComponentTargets({});

    void getItemDetailSummary(selectedItem.wfmId, selectedItem.slug)
      .then((response) => {
        if (!isMounted) {
          return;
        }
        setItemDetails(response);
        setItemDetailsLoading(false);
        setItemDetailsError(null);
      })
      .catch((error) => {
        if (!isMounted) {
          return;
        }
        setItemDetails(null);
        setItemDetailsLoading(false);
        setItemDetailsError(formatMarketErrorMessage('market-item-details-load', error));
      });

    void loadSelectedMarketAnalysis()
      .then((response) => {
        if (!isMounted) {
          return;
        }
        if (!response) {
          return;
        }
        if (!itemDetails) {
          setItemDetails(response.itemDetails);
          setItemDetailsLoading(false);
          setItemDetailsError(null);
        }
        setComponentTargets(
          Object.fromEntries(
            response.supplyContext.components.map((component) => [
              component.slug,
              `${Math.round(component.recommendedEntryPrice ?? component.currentLowestPrice ?? 0)}`,
            ]),
          ),
        );
      })
      .catch(() => {
        if (!isMounted) {
          return;
        }
        // Reveal the panels anyway so they don't hang forever on "Building…"; the analysis
        // error state surfaces the failure to the user.
      });

    return () => {
      isMounted = false;
    };
  }, [selectedItem, selectedMarketVariantKey, loadSelectedMarketAnalysis]);

  const eventContextEntries = buildEventContextEntries(t, analysis, {
    alerts: worldStateAlerts,
    events: worldStateEvents,
    invasions: worldStateInvasions,
    syndicateMissions: worldStateSyndicateMissions,
    voidTrader: worldStateVoidTrader,
    flashSales: worldStateFlashSales,
    vaultTraderPayload: worldStateVaultTrader,
  });
  const eventContextConfidence = buildEventContextConfidence(eventContextEntries, t);

  // See the note in AnalyticsTab: panels render as idle shells rather than being replaced.

  // While variants load we fall through to the real analysis layout below; it is
  // null-safe and every panel shows its own loading overlay until revealed, so the
  // loading view matches the loaded view exactly (panels present, content pending).

  if (marketVariantsError && marketVariants.length === 0 && !selectedMarketVariantKey) {
    return (
      <div className="page-content">
        <EmptyAnalyticsState
          title={t('a11y.analysisFailed')}
          body={marketVariantsError}
          actionLabel={t('common.retry')}
          onAction={() => {
            if (selectedItem) {
              void loadQuickViewItem(selectedItem);
            }
          }}
        />
      </div>
    );
  }

  if (marketVariants.length > 1 && !selectedMarketVariantKey) {
    return (
      <div className="page-content">
        <EmptyAnalyticsState body={t('mkb.pickRankAnalysis')} />
        {marketVariantsError ? <MarketInlineNotice tone="error" message={marketVariantsError} /> : null}
      </div>
    );
  }

  // No early-return while the analysis is being built — the layout below renders with
  // pending content and per-panel loading overlays so it matches the loaded version.

  const effectiveItemDetails = itemDetails ?? analysis?.itemDetails ?? null;
  const itemImageUrl = resolveWfmAssetUrl(effectiveItemDetails?.imagePath, effectiveItemDetails?.slug);
  const itemDetailSections = buildItemDetailSections(effectiveItemDetails, t);
  // The three hero meters these fed are gone — each duplicated a panel below. Note the risk
  // meter in particular was a HARDCODED fill (0.92 / 0.58 / 0.18) derived from a tone, not a
  // measurement: a bar that looked like data and plotted nothing. See ELEMENTS.md on decoration.
  const timeOfDayDisplay = buildTimeOfDayDisplayModel(analysis?.timeOfDayLiquidity);
  const displayDropSources = buildDisplayDropSources(
    analysis?.supplyContext.dropSources ?? [],
    autocompleteItems,
  );
  const analysisDegradedMessage = analysisError && analysis ? analysisError : null;
  const itemDetailsDegradedMessage =
    itemDetailsError && effectiveItemDetails ? itemDetailsError : null;

  return (
    <div ref={pageContentRef} className="page-content market-page-content">
      {analysisError && !analysis && !analysisLoading ? (
        <EmptyAnalyticsState
          title={t('a11y.analysisFailed')}
          body={analysisError}
          actionLabel={t('common.retry')}
          onAction={() => {
            void loadSelectedMarketAnalysis({ force: true });
          }}
        />
      ) : null}
      {/* Always rendered. This used to be gated on `analysis || analysisLoading ||
          marketVariantsLoading`, so with nothing selected the whole page collapsed to one
          sentence. Every panel below is null-safe and draws itself as an inert shell in `idle`,
          which is what lets the interface stay visible while it waits for a selection. */}
      <>
      {analysisDegradedMessage ? (
        <MarketInlineNotice tone="warning" message={analysisDegradedMessage} />
      ) : null}
      {itemDetailsDegradedMessage ? (
        <MarketInlineNotice tone="warning" message={itemDetailsDegradedMessage} />
      ) : null}
      {/* One provenance stamp, matching the rest of the app (Home's "Priced 1d ago",
          Opportunities' "Prices 1d ago" beside Refresh). This was three separate pills —
          Snapshot / Stats / Computed — each a full absolute datetime. Three timestamps for one
          question is two too many, and "computed" is the only one that describes what is on
          screen: the other two are inputs to it. */}
      <div className="flex items-center gap-3 px-4 pt-3">
        <span className="font-mono text-[10px] text-ink-faint tabular-nums">
          {t('mkt.fresh.computed')} {formatRelativeTimestamp(analysis?.computedAt ?? null)}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto text-ink-dim hover:text-ink"
          disabled={analysisLoading}
          aria-label={t('market.refreshAnalysis')}
          title={t('market.refreshAnalysis')}
          onClick={() => {
            void loadSelectedMarketAnalysis({ force: true });
          }}
        >
          <RefreshIcon />
        </Button>
      </div>
      {/* Top row: what am I looking at, and can I act on it.
          Quick View sizes to its content and defines the row height; Item details is capped to it
          and scrolls (see `.market-item-details-cell`). */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-6">
        <ErrorBoundary label="Quick view">
          <div className="xl:col-span-4">
            <QuickViewCard />
          </div>
        </ErrorBoundary>

        <div className="market-item-details-cell xl:col-span-2">
<AnalyticsPanel
                title={t('a11y.itemDetails')}
                info={t('mki.reference')}
                phase={
                  !selectedItem ? 'idle' : effectiveItemDetails ? 'ready' : 'loading'
                }
                errorMessage={effectiveItemDetails ? null : itemDetailsError}
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
                      alt={effectiveItemDetails?.name ?? selectedItem?.name ?? ''}
                    />
                  ) : (
                    <div className="market-item-detail-image placeholder" />
                  )}
                  <div className="market-item-detail-copy">
                    <span className="market-item-detail-name">{effectiveItemDetails?.name ?? selectedItem?.name ?? '—'}</span>
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
                    <span className="market-copy-title">{t('mkt.description')}</span>
                    <p>
                      {parseWarframeMarkupLines(effectiveItemDetails.description).map((line, lineIndex) => (
                        <span key={lineIndex} className="market-detail-description-line">
                          {line.map((segment, segmentIndex) =>
                            segment.color ? (
                              <span key={segmentIndex} style={{ color: segment.color }}>
                                {segment.text}
                              </span>
                            ) : (
                              <span key={segmentIndex}>{segment.text}</span>
                            ),
                          )}
                        </span>
                      ))}
                    </p>
                  </div>
                ) : null}
                {(effectiveItemDetails?.statHighlights.length ?? 0) > 0 ? (
                  <div className="market-copy-block">
                    <span className="market-copy-title">
                      {effectiveItemDetails?.rankScaleLabel ?? t('mkt.rankScaling')}
                    </span>
                    <div className="market-detail-highlight-list">
                      {(effectiveItemDetails?.statHighlights ?? []).map((line) => (
                        <div key={line} className="market-detail-highlight">
                          {splitWarframeMarkupLines(line).map((segment, segmentIndex) => (
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
      </div>

      {/* Two columns that pack independently, rather than one grid of paired rows.
          In a grid, each row is as tall as its taller panel, so Flip economics and Trend were
          padded out with dead space to match Liquidity and Risk beside them. Columns let every
          panel size to its own content and stack flush.

          Left is the opportunity — the economics, where price is going, when to trade it, and what
          the parts cost. Right is the caveats — how easily you get out, what could distort the
          edge, and what events are moving it. */}
      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-5">
<AnalyticsPanel
            title={t('a11y.flipAnalysis')}
            info={t('mki.flip')}
            phase={analysisPhase}
            errorMessage={analysisError}
            className="market-panel-tone-blue"
            headerAside={
              <div className="market-badge-stack">
                <span className="market-panel-badge tone-blue">
                  {tHealth(t, analysis?.flipAnalysis.efficiencyLabel) || t('trades.row.building')}
                </span>
                <ConfidenceBadge confidence={analysis?.flipAnalysis.confidenceSummary} />
              </div>
            }
          >
            <MetricGrid>
              <Metric label={t('mkt.entryPrice')} value={formatPrice(analysis?.flipAnalysis.entryPrice)} />
              <Metric label={t('mkt.exitPrice')} value={formatPrice(analysis?.flipAnalysis.exitPrice)} />
              <Metric label={t('mkt.grossMargin')} value={formatPrice(analysis?.flipAnalysis.grossMargin)} />
              <Metric label={t('mkt.netMargin')} value={formatPrice(analysis?.flipAnalysis.netMargin)} />
              <Metric
                label={t('mkt.efficiencyScore')}
                value={`${formatPercent(analysis?.flipAnalysis.efficiencyScore)} · ${tHealth(t, analysis?.flipAnalysis.efficiencyLabel) || '—'}`}
              />
            </MetricGrid>
            <ConfidenceNote confidence={analysis?.flipAnalysis.confidenceSummary} />
          </AnalyticsPanel>
<AnalyticsPanel
            title={t('trades.analysis.trend')}
            info={t('mki.trendSummary')}
            phase={analysisPhase}
            errorMessage={analysisError}
            className={`market-panel-tone-${getTrendTone(analysis?.trend.direction)}`}
            headerAside={
              <div className="market-badge-stack">
                <span className={`market-panel-badge tone-${getTrendTone(analysis?.trend.direction)}`}>
                  {tHealth(t, analysis?.trend.direction) || t('trades.row.building')}
                </span>
                <ConfidenceBadge confidence={analysis?.trend.confidenceSummary} />
              </div>
            }
          >
            <MetricGrid>
              <Metric label={t('mkt.direction')} value={tHealth(t, analysis?.trend.direction) || '—'} />
              <Metric label={t('mkt.confidence')} value={formatPercent(analysis?.trend.confidence)} />
              <Metric label={t('mkt.slope1h')} value={formatPercent(analysis?.trend.slope1h)} />
              <Metric label={t('mkt.slope3h')} value={formatPercent(analysis?.trend.slope3h)} />
              <Metric label={t('mkt.slope6h')} value={formatPercent(analysis?.trend.slope6h)} />
            </MetricGrid>
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
              <span className="market-copy-title">{t('mkt.summary')}</span>
              <p>{analysis ? tTrendSummary(t, analysis.trend) : '—'}</p>
            </div>
            <ConfidenceNote confidence={analysis?.trend.confidenceSummary} />
          </AnalyticsPanel>
<AnalyticsPanel
            title={t('a11y.timeOfDayLiquidity')}
            info={t('mki.timeOfDay')}
            phase={analysisPhase}
            errorMessage={analysisError}
              className="market-panel-tone-blue"
              headerAside={
                <div className="market-badge-stack">
                  <span className="market-panel-badge tone-blue">
                    {timeOfDayDisplay.todayBestLabels[0] ?? t('trades.row.building')}
                  </span>
                  <ConfidenceBadge confidence={analysis?.timeOfDayLiquidity.confidenceSummary} />
                </div>
              }
            >
            <div className="market-pressure-row">
              <div>
                <span className="market-copy-title">{t('mkt.bestWindowsToday')}</span>
                <span>
                  {timeOfDayDisplay.todayBestLabels.length > 0
                    ? timeOfDayDisplay.todayBestLabels.join(' · ')
                    : '—'}
                </span>
              </div>
              <div>
                <span className="market-copy-title">{t('mkt.strongestAllDays')}</span>
                <span>{timeOfDayDisplay.strongestWindowLabel ?? '—'}</span>
              </div>
              <div>
                <span className="market-copy-title">{t('mkt.weakestAllDays')}</span>
                <span>{timeOfDayDisplay.weakestWindowLabel ?? '—'}</span>
              </div>
            </div>
            <div className="market-tod-heatmap">
              <div className="market-tod-colheader">
                <span className="market-tod-corner" aria-hidden="true" />
                {timeOfDayDisplay.columnLabels.map((label, index) => (
                  <span key={label} className="market-tod-coltick">
                    {/* Axis ticks show the hour the block starts — "10", "12" — while the cell
                        tooltip carries the full `10:00–12:00`. */}
                    {index % 2 === 0 ? label.slice(0, 2) : ''}
                  </span>
                ))}
              </div>
              {timeOfDayDisplay.rows.map((row) => (
                <div
                  key={row.weekday}
                  className={`market-tod-row${row.isToday ? ' is-today' : ''}`}
                >
                  <span className="market-tod-row-label">{row.label}</span>
                  <div className="market-tod-row-cells">
                    {row.cells.map((cell) => (
                      <div
                        key={cell.bucketIndex}
                        className={`market-tod-cell${cell.sampleCount > 0 ? '' : ' is-empty'}`}
                        style={{ '--heat-strength': cell.heatScore ?? 0 } as CSSProperties}
                        title={[
                          `${row.label} ${cell.label} (UTC)`,
                          `${t('mkt.heat')} ${formatPercent((cell.heatScore ?? 0) * 100)}`,
                          `${t('mkt.liquidity')} ${formatPercent(cell.avgLiquidityScore)}`,
                          `${t('mkt.volume')} ${formatNumber(cell.avgHourlyVolume, 0)}`,
                          cell.sampleCount > 0 ? `${t('mkt.samples')} ${cell.sampleCount}` : t('mkt.noDataYet'),
                        ].join('\n')}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <ConfidenceNote confidence={analysis?.timeOfDayLiquidity.confidenceSummary} />
          </AnalyticsPanel>
<AnalyticsPanel
            title={
              analysis?.supplyContext.mode === 'set-components'
                ? t('mkt.setComponents')
                : analysis?.supplyContext.mode === 'drop-sources'
                  ? t('mkt.dropSources')
                  : t('mkt.dropSourcesOrSetComponents')
            }
            info={t('mki.supply')}
            phase={analysisPhase}
            errorMessage={analysisError}
            className="market-panel-tone-amber"
            headerAside={
              <div className="market-badge-stack">
                <ConfidenceBadge confidence={analysis?.supplyContext.confidenceSummary} />
                {/* Adding a set one part at a time is six clicks through six inputs for the same
                    decision. This takes whatever is in the boxes — which default to the
                    recommended entry — and watches the whole set at those prices. */}
                {analysis?.supplyContext.mode === 'set-components'
                && (analysis?.supplyContext.components?.length ?? 0) > 0 ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-7 border-line px-2.5 text-[11px]"
                    onClick={() => {
                      for (const component of analysis?.supplyContext.components ?? []) {
                        if (component.itemKey === null) {
                          continue;
                        }
                        const target = Number.parseInt(
                          componentTargets[component.slug] || '0',
                          10,
                        );
                        addExplicitItemToWatchlist(
                          {
                            itemId: 0,
                            wfmId: component.itemKey,
                            name: component.name,
                            slug: component.slug,
                            maxRank: null,
                            itemFamily: null,
                            imagePath: component.imagePath,
                            bulkTradable: false,
                          },
                          component.variantKey,
                          component.variantLabel,
                          target,
                        );
                        markWatchlistAddFeedback(
                          component.slug,
                          setWatchlistAddFeedback,
                          watchlistAddFeedbackTimeoutsRef,
                        );
                      }
                    }}
                  >
                    {t('wl.addAll')}
                  </Button>
                ) : null}
              </div>
            }
          >
            {analysis?.supplyContext.mode === 'set-components' ? (
              <div className="market-component-list">
                {(analysis?.supplyContext.components ?? []).map((component) => {
                  const imageUrl = resolveWfmAssetUrl(component.imagePath, component.slug);
                  const targetValue = componentTargets[component.slug] ?? '';
                  const watchlistItem: WfmAutocompleteItem | null =
                    component.itemKey !== null
                      ? {
                          itemId: 0,
                          wfmId: component.itemKey,
                          name: component.name,
                          slug: component.slug,
                          maxRank: null,
                          itemFamily: null,
                          imagePath: component.imagePath,
                          bulkTradable: false,
                        }
                      : null;

                  // A row, not a stacked copy block. The three numbers are the same three on
                  // every component, so fixed columns let you compare down the list — which is
                  // the actual question ("which part is dragging the set?"). Prose lines could
                  // only be read one component at a time.
                  return (
                    <div key={component.slug} className="market-component-row">
                      {imageUrl ? (
                        <img className="market-component-image" src={imageUrl} alt="" />
                      ) : (
                        <div className="market-component-image placeholder" />
                      )}

                      {/* Wraps rather than truncating, and `pr-3` keeps the wrapped line clear
                          of the columns to its right — component names are long enough that a
                          single line ran straight into the numbers. */}
                      <div className="min-w-0 flex-1 pr-3">
                        <div className="text-xs leading-snug font-medium text-balance text-ink">
                          {resolveLocalizedName(itemNameMap, component)}
                        </div>
                      </div>

                      {/* Quantity reads as a count, not a suffix on the name. It is the first
                          thing that tells you how much of the set this part is. */}
                      <span className="market-component-qty">×{component.quantityInSet}</span>

                      <Metric
                        label={t('mkt.currentLowest')}
                        value={formatPrice(component.currentLowestPrice)}
                        className="w-20 shrink-0"
                      />
                      <Metric
                        label={t('mkt.recommendedEntry')}
                        value={formatPrice(component.recommendedEntryPrice)}
                        className="w-24 shrink-0"
                      />

                      <div className="flex shrink-0 items-center gap-1.5">
                        <Input
                          type="number"
                          min="0"
                          step="1"
                          aria-label={t('wl.targetPriceFor', { item: component.name })}
                          className="h-7 w-20 tabular-nums"
                          value={targetValue}
                          onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                            setComponentTargets((current) => ({
                              ...current,
                              [component.slug]: event.target.value,
                            }))
                          }
                        />
                        <Button
                          variant="secondary"
                          size="sm"
                          className="h-7 shrink-0 border-line px-2 text-[11px]"
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
                            markWatchlistAddFeedback(
                              component.slug,
                              setWatchlistAddFeedback,
                              watchlistAddFeedbackTimeoutsRef,
                            );
                          }}
                        >
                          {watchlistAddFeedback[component.slug] ? t('wl.added') : t('common.add')}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : analysis?.supplyContext.mode === 'drop-sources' ? (
              <div className="market-drop-list">
                {displayDropSources.map((source) => {
                  // Relic sources carry the relic's name in `location`; era art replaces WFM's.
                  const imageUrl = source.isRelic
                    ? resolveRelicAssetUrl({ name: source.location }) ?? resolveWfmAssetUrl(source.imagePath)
                    : resolveWfmAssetUrl(source.imagePath);
                  return (
                    <div key={source.key} className="market-drop-row">
                      {imageUrl ? (
                        <img
                          className={`market-drop-image${source.isRelic ? ' relic-art' : ''}`}
                          src={imageUrl}
                          alt=""
                          loading="lazy"
                        />
                      ) : (
                        <span className="market-drop-image placeholder" aria-hidden="true">
                          {source.location.slice(0, 2)}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-xs text-ink">
                        {source.location}
                      </span>
                      {/* Was four prefixed sentences per card — "Chance: 11.06%", "Rarity: Rare",
                          "Type: Mission". The prefix repeated on every line of every card; as
                          columns the label is said once at the top and the values line up. */}
                      {!source.isRelic ? (
                        <Metric
                          label={t('mkt.chance')}
                          value={formatDropChancePercent(source.chance)}
                          className="w-16 shrink-0"
                        />
                      ) : null}
                      <Metric
                        label={t('mkt.rarity')}
                        value={source.rarity ?? '—'}
                        className="w-20 shrink-0"
                      />
                      {!source.isRelic ? (
                        <Metric
                          label={t('mkt.sourceType')}
                          value={source.sourceType ?? '—'}
                          className="w-24 shrink-0"
                        />
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="market-copy-block">
                <span className="market-copy-title">{t('mkt.noSupplyContext')}</span>
                <p>{t('mkt.noSupplyBody')}</p>
              </div>
            )}
            <ConfidenceNote confidence={analysis?.supplyContext.confidenceSummary} />
          </AnalyticsPanel>
        </div>
        <div className="flex min-w-0 flex-col gap-5">
<AnalyticsPanel
            title={t('a11y.liquidityDetail')}
            info={t('mki.liquidity')}
            phase={analysisPhase}
            errorMessage={analysisError}
            className="market-panel-tone-blue"
            headerAside={
              <div className="market-badge-stack">
                <span className="market-panel-badge tone-blue">
                  {analysis?.liquidityDetail.state ?? t('mkt.profiling')}
                </span>
                <ConfidenceBadge confidence={analysis?.liquidityDetail.confidenceSummary} />
              </div>
            }
          >
            <MetricGrid>
              <Metric label={t('mkt.demandRatio')} value={formatNumber(analysis?.liquidityDetail.demandRatio, 2)} />
              <Metric label={t('mkt.state')} value={analysis?.liquidityDetail.state ?? '—'} />
              <Metric label={t('mkt.sellersWithin')} value={formatNumber(analysis?.liquidityDetail.sellersWithinTwoPt, 0)} />
              <Metric
                label={t('mkt.undercutVelocity')}
                value={`${formatNumber(analysis?.liquidityDetail.undercutVelocity, 2)} / h`}
              />
              <Metric label={t('mkt.qtyWeightedDemand')} value={formatPercent(analysis?.liquidityDetail.quantityWeightedDemand)} />
              <Metric label={t('mkt.liquidity')} value={formatPercent(analysis?.liquidityDetail.liquidityScore)} />
            </MetricGrid>
            <ConfidenceNote confidence={analysis?.liquidityDetail.confidenceSummary} />
            <div className="market-signal-board">
              <div className="market-signal-row">
                <span className="market-signal-label">{t('mkt.demandRatio')}</span>
                <div className="market-signal-track">
                  <div
                    className="market-signal-fill tone-blue"
                    style={{ '--signal-fill': `${Math.round(ratioToUnitInterval(analysis?.liquidityDetail.demandRatio) * 100)}%` } as CSSProperties}
                  />
                </div>
              </div>
              <div className="market-signal-row">
                <span className="market-signal-label">{t('mkt.qtyWeightedDemand')}</span>
                <div className="market-signal-track">
                  <div
                    className="market-signal-fill tone-green"
                    style={{ '--signal-fill': `${Math.round(toUnitInterval(analysis?.liquidityDetail.quantityWeightedDemand) * 100)}%` } as CSSProperties}
                  />
                </div>
              </div>
              <div className="market-signal-row">
                <span className="market-signal-label">{t('mkt.liquidityScore')}</span>
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
            title={t('a11y.manipulationRisk')}
            info={t('mki.risk')}
            phase={analysisPhase}
            errorMessage={analysisError}
            className={`market-panel-tone-${getRiskTone(analysis?.manipulationRisk.riskLevel)}`}
            headerAside={
              <div className="market-badge-stack">
                <span className={`market-panel-badge tone-${getRiskTone(analysis?.manipulationRisk.riskLevel)}`}>
                  {tHealth(t, analysis?.manipulationRisk.riskLevel) || t('trades.row.building')}
                </span>
                <ConfidenceBadge confidence={analysis?.manipulationRisk.confidenceSummary} />
              </div>
            }
          >
            <MetricGrid>
              <Metric label={t('mkt.riskLevel')} value={tHealth(t, analysis?.manipulationRisk.riskLevel) || '—'} />
              <Metric label={t('mkt.activeSignals')} value={formatNumber(analysis?.manipulationRisk.activeSignals, 0)} />
              <Metric label={t('mkt.efficiencyPenalty')} value={formatPercent(analysis?.manipulationRisk.efficiencyPenaltyPct)} />
            </MetricGrid>
            <div className="market-signal-board">
              <div className="market-signal-row">
                <span className="market-signal-label">{t('mkt.penaltyApplied')}</span>
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
                  <span className="market-copy-title">{tHealth(t, signal.label)}</span>
                  <span className="market-analysis-signal-state">
                    {signal.active ? t('mkt.signal.active') : t('mkt.signal.clear')}
                  </span>
                  <p>{tSignalDetail(t, signal.detail)}</p>
                </div>
              ))}
            </div>
          </AnalyticsPanel>
<AnalyticsPanel
            title={t('a11y.eventContext')}
            info={t('mki.worldstate')}
            phase={analysisPhase}
            errorMessage={analysisError}
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
                <span className="market-copy-title">{t('mkt.noActiveContext')}</span>
                <p>{t('mkt.noActiveBody')}</p>
              </div>
            )}
            <ConfidenceNote confidence={eventContextConfidence} />
          </AnalyticsPanel>
        </div>
      </div>
      </>
    </div>
  );
}



export function MarketPage() {
  const marketSubTab = useAppStore((s) => s.marketSubTab);

  // NOTE: this used to reset the sub-tab to 'analysis' on every mount. That is incompatible with
  // sidebar-driven navigation — picking "Market › Analytics" mounts this page, which would snap
  // straight back to Analysis. The sidebar owns the selection now.

  return (
    <>
      <PageHeading page="market" />

      {/* Quick View lives INSIDE the Summary tab, beside Item details — not here. Rendering it
          at page level put it above both sub-views, but Charts is about price history over time
          and has nothing to say about who is selling right now.

          Analysis Preview is gone. It showed entry, exit, net margin, liquidity, risk, trend and
          trade posture — every one of which the Summary panels render in full, further down the
          same page. It was a preview of the page it sat on: that made sense on Home, where it
          linked here, and is pure duplication now that it lives here. */}
      {marketSubTab === 'analytics' ? <AnalyticsTab /> : <AnalysisTab />}
    </>
  );
}
