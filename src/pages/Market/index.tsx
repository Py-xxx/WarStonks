import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, Dispatch, MouseEvent as ReactMouseEvent, MutableRefObject, ReactNode, SetStateAction } from 'react';
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
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { wfstatLangCode } from '../../lib/language';
import { tActive, useTranslation } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { resolveLocalizedName } from '../../lib/itemNames';
import { tConfidence, tHealth, tTrendSummary } from '../../lib/healthLabels';
import type { TranslationKey } from '../../i18n/en';
import { translate } from '../../i18n';
import { useAppStore } from '../../stores/useAppStore';
import type {
  AnalyticsChartPoint,
  BacktestBucketStats,
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
  label: TranslationKey;
  colorClass: string;
}

function createRevealState<T extends string>(keys: readonly T[]): Record<T, boolean> {
  return Object.fromEntries(keys.map((key) => [key, false])) as Record<T, boolean>;
}

function clearRevealTimeouts(timeoutsRef: MutableRefObject<number[]>) {
  timeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
  timeoutsRef.current = [];
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

function AdaptiveInfoHint({
  text,
  preferredPlacement = 'auto',
}: {
  text: string;
  preferredPlacement?: 'auto' | 'below';
}) {
  const hintRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const [tooltipStyle, setTooltipStyle] = useState<CSSProperties>({
    bottom: 'calc(100% + 8px)',
    left: 0,
  });

  const updatePlacement = () => {
    const hintRect = hintRef.current?.getBoundingClientRect();
    const tooltipRect = tooltipRef.current?.getBoundingClientRect();
    if (!hintRect || !tooltipRect) {
      return;
    }

    const viewportPadding = 12;
    const tooltipGap = 8;
    const placeBelow = preferredPlacement === 'below'
      ? true
      : hintRect.top < tooltipRect.height + 24;
    let nextStyle: CSSProperties = placeBelow
      ? { top: `calc(100% + ${tooltipGap}px)`, bottom: 'auto' }
      : { bottom: `calc(100% + ${tooltipGap}px)`, top: 'auto' };

    const shouldAlignRight = hintRect.left + tooltipRect.width > window.innerWidth - viewportPadding;
    if (shouldAlignRight) {
      nextStyle.right = 0;
      nextStyle.left = 'auto';
      const projectedLeft = hintRect.right - tooltipRect.width;
      if (projectedLeft < viewportPadding) {
        nextStyle.left = `${viewportPadding - hintRect.left}px`;
        nextStyle.right = 'auto';
      }
    } else {
      nextStyle.left = 0;
      nextStyle.right = 'auto';
    }

    setTooltipStyle(nextStyle);
  };

  return (
    <span
      ref={hintRef}
      className="info-hint market-info-hint"
      tabIndex={0}
      aria-label={text}
      onMouseEnter={updatePlacement}
      onFocus={updatePlacement}
    >
      <span className="info-hint-glyph" aria-hidden="true">i</span>
      <span
        ref={tooltipRef}
        className="info-hint-tooltip market-info-hint-tooltip"
        style={tooltipStyle}
      >
        {text}
      </span>
    </span>
  );
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

function buildAnalysisHeroState(analysis: ItemAnalysisResponse | null, t: TranslateFn) {
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
      label: t('mkt.hero.buildingReadout'),
      tone: 'blue' as PanelTone,
      note: t('mkt.hero.note.building'),
    };
  }

  if (riskTone === 'red') {
    return {
      label: t('mkt.hero.highCaution'),
      tone: 'red' as PanelTone,
      note: `${t('mkt.hero.note.highCaution')}${confidenceNote}`,
    };
  }

  if (headlineConfidence?.level === 'low') {
    return {
      label: t('mkt.hero.cautiousRead'),
      tone: 'amber' as PanelTone,
      note: `${t('mkt.hero.note.cautiousRead')}${confidenceNote}`,
    };
  }

  if (netMargin > 0 && liquidityScore >= 60 && trendTone === 'green') {
    return {
      label: t('mkt.hero.buyBias'),
      tone: 'green' as PanelTone,
      note: `${t('mkt.hero.note.buyBias', { liq: Math.round(liquidityScore), conf: Math.round(confidence ?? 0) })}${confidenceNote}`,
    };
  }

  if (netMargin > 0 && liquidityScore >= 42) {
    return {
      label: t('mkt.hero.selective'),
      tone: 'blue' as PanelTone,
      note: `${t('mkt.hero.note.selective')}${confidenceNote}`,
    };
  }

  return {
    label: t('mkt.hero.wait'),
    tone: 'amber' as PanelTone,
    note: `${t('mkt.hero.note.wait')}${confidenceNote}`,
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
              <AdaptiveInfoHint text={t('mki.chart')} />
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
            <div className="market-chart-toolbar-copy">
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
            {errorMessage && !chartLoading ? (
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
            <span>Lowest {formatPrice(points[points.length - 1]?.lowest ?? null)}</span>
            <span>Volume {formatNumber(points[points.length - 1]?.volume ?? null, 0)}</span>
          </div>
        </div>
        <PanelOverlay
          loading={chartLoading}
          errorMessage={!chartLoading ? errorMessage : null}
          label={t('mkt.loadingChartHistory')}
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

function formatTwoHourBlockLabel(bucketIndex: number): string {
  const start = (bucketIndex * 2) % 24;
  const end = (start + 2) % 24;
  return `${start.toString().padStart(2, '0')}–${end.toString().padStart(2, '0')}`;
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
    if (!item.name.toLowerCase().includes(' relic')) {
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
  info,
  infoPlacement = 'auto',
  children,
  loading = false,
  errorMessage = null,
  loadingLabel,
  className = '',
  accent = 'blue',
  headerAside = null,
}: {
  title: string;
  eyebrow: string;
  info?: string;
  infoPlacement?: 'auto' | 'below';
  children: ReactNode;
  loading?: boolean;
  errorMessage?: string | null;
  loadingLabel?: string;
  className?: string;
  accent?: 'blue' | 'green' | 'amber' | 'purple';
  headerAside?: ReactNode;
}) {
  const { t } = useTranslation();
  const resolvedLoadingLabel = loadingLabel ?? t('mkl.panel');

  return (
    <div className={`card market-panel accent-${accent} ${className}`.trim()}>
      <div className="card-header">
        <div className="market-panel-header">
          <div className="market-panel-header-copy">
              <span className="panel-title-eyebrow">{eyebrow}</span>
              <span className="card-label market-panel-title-row">
                <span>{title}</span>
              {info ? <AdaptiveInfoHint text={info} preferredPlacement={infoPlacement} /> : null}
              </span>
            </div>
          {headerAside ? <div className="market-panel-header-aside">{headerAside}</div> : null}
        </div>
      </div>
      <div className="card-body market-panel-body">
        {children}
        <PanelOverlay loading={loading} errorMessage={errorMessage} label={resolvedLoadingLabel} />
      </div>
    </div>
  );
}

function AnalyticsTab() {
  const { t } = useTranslation();
  const pageContentRef = useRef<HTMLDivElement | null>(null);
  const revealTimeoutsRef = useRef<number[]>([]);
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
      analyticsIdentityRef.current = null;
      setAnalytics(null);
      setLoading(false);
      setErrorMessage(null);
      setRevealedPanels(createRevealState(ANALYTICS_PANEL_SEQUENCE));
      return;
    }

    let isMounted = true;
    const selectionIdentity = buildMarketSelectionIdentity(
      selectedItem.itemId,
      selectedMarketVariantKey,
      sellerMode,
    );
    const canKeepCurrentSnapshot =
      Boolean(selectionIdentity)
      && analyticsIdentityRef.current === selectionIdentity
      && analytics !== null;
    clearRevealTimeouts(revealTimeoutsRef);
    setLoading(true);
    setErrorMessage(null);
    if (!canKeepCurrentSnapshot) {
      setAnalytics(null);
      setRevealedPanels(createRevealState(ANALYTICS_PANEL_SEQUENCE));
    }

    void getItemAnalytics(
      selectedItem.itemId,
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
        queuePanelReveal(ANALYTICS_PANEL_SEQUENCE, setRevealedPanels, revealTimeoutsRef);
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

  if (!selectedItem) {
    return (
      <div className="page-content">
        <EmptyAnalyticsState body={t('mkb.pickItemCharts')} />
      </div>
    );
  }

  // While item variants are still loading we deliberately fall through to the real
  // analytics layout below. Every panel (and the chart) is null-safe and shows its
  // own loading overlay while `revealedPanels` is still false, so the surface looks
  // exactly like the loaded version with content pending — no separate skeleton.

  if (marketVariantsError && marketVariants.length === 0 && !selectedMarketVariantKey) {
    return (
      <div className="page-content">
        <EmptyAnalyticsState
          title={t('a11y.analyticsFailed')}
          body={marketVariantsError}
          actionLabel={t('common.retry')}
          onAction={() => {
            void loadQuickViewItem(selectedItem);
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
      {!errorMessage || analytics || loading ? (
        <>
      <div className="market-header-actions">
        <div className="market-item-freshness">
          <span>{t('mkt.fresh.snapshot')} {formatRelativeTimestamp(analytics?.sourceSnapshotAt ?? null)}</span>
          <span>{t('mkt.fresh.stats')} {formatRelativeTimestamp(analytics?.sourceStatsFetchedAt ?? null)}</span>
          <span>{t('mkt.fresh.computed')} {formatRelativeTimestamp(analytics?.computedAt ?? null)}</span>
        </div>
        <button
          className="market-refresh-button"
          type="button"
          aria-label={t('market.refreshAnalytics')}
          title={t('market.refreshAnalytics')}
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
        itemName={resolveLocalizedName(itemNameMap, selectedItem)}
        analytics={analytics}
        loading={loading || marketVariantsLoading}
        revealed={revealedPanels.chart}
        errorMessage={analyticsPanelError}
        domain={chartDomain}
        bucket={chartBucket}
        onDomainChange={setChartDomain}
        onBucketChange={setChartBucket}
      />
      <div className="market-analytics-grid">
            <AnalyticsPanel
              title={t('a11y.entryExitOverview')}
              eyebrow={t('mkteb.marketState')}
              info={t('mki.zones')}
              infoPlacement="below"
              loading={!revealedPanels.overview && !analyticsPanelError}
              errorMessage={!revealedPanels.overview ? analyticsPanelError : null}
              loadingLabel={t('mkl.zones')}
              headerAside={<ConfidenceBadge confidence={analytics?.entryExitZoneOverview.confidenceSummary} />}
            >
              <div className="market-metric-grid">
                <div className="market-metric-card">
                  <span className="market-metric-label">{t('mkt.currentLowest')}</span>
                  <span className="market-metric-value">{formatPrice(analytics?.entryExitZoneOverview.currentLowestPrice)}</span>
                </div>
                <div className="market-metric-card">
                  <span className="market-metric-label">{t('mkt.medianLowest')}</span>
                  <span className="market-metric-value">{formatPrice(analytics?.entryExitZoneOverview.currentMedianLowestPrice)}</span>
                </div>
                <div className="market-metric-card">
                  <span className="market-metric-label">{t('mkt.fairValueBand')}</span>
                  <span className="market-metric-value">
                    {formatPrice(analytics?.entryExitZoneOverview.fairValueLow)} - {formatPrice(analytics?.entryExitZoneOverview.fairValueHigh)}
                  </span>
                </div>
                <div className="market-metric-card">
                  <span className="market-metric-label">{t('mkt.zoneQuality')}</span>
                  <span className="market-metric-value">{analytics?.entryExitZoneOverview.zoneQuality ?? '—'}</span>
                </div>
              </div>
              <div className="market-copy-block">
                <span className="market-copy-title">{t('mkt.entryZone')}</span>
                <span>
                  {formatPrice(analytics?.entryExitZoneOverview.entryZoneLow)} - {formatPrice(analytics?.entryExitZoneOverview.entryZoneHigh)}
                </span>
                <p>{analytics?.entryExitZoneOverview.entryRationale ?? '—'}</p>
              </div>
              <div className="market-copy-block">
                <span className="market-copy-title">{t('mkt.exitZone')}</span>
                <span>
                  {formatPrice(analytics?.entryExitZoneOverview.exitZoneLow)} - {formatPrice(analytics?.entryExitZoneOverview.exitZoneHigh)}
                </span>
                <p>{analytics?.entryExitZoneOverview.exitRationale ?? '—'}</p>
              </div>
              <ConfidenceNote confidence={analytics?.entryExitZoneOverview.confidenceSummary} />
            </AnalyticsPanel>

            <AnalyticsPanel
              title={t('a11y.orderbookPressure')}
              eyebrow={t('mkteb.execution')}
              info={t('mki.orderbook')}
              infoPlacement="below"
              loading={!revealedPanels.pressure && !analyticsPanelError}
              errorMessage={!revealedPanels.pressure ? analyticsPanelError : null}
              loadingLabel={t('mkl.orderbook')}
              headerAside={<ConfidenceBadge confidence={analytics?.orderbookPressure.confidenceSummary} />}
            >
              <div className="market-metric-grid">
                <div className="market-metric-card">
                  <span className="market-metric-label">{t('mkt.cheapestSell')}</span>
                  <span className="market-metric-value">{formatPrice(analytics?.orderbookPressure.cheapestSell)}</span>
                </div>
                <div className="market-metric-card">
                  <span className="market-metric-label">{t('mkt.highestBuy')}</span>
                  <span className="market-metric-value">{formatPrice(analytics?.orderbookPressure.highestBuy)}</span>
                </div>
                <div className="market-metric-card">
                  <span className="market-metric-label">{t('mkt.spread')}</span>
                  <span className="market-metric-value">
                    {formatPrice(analytics?.orderbookPressure.spread)} · {formatPercent(analytics?.orderbookPressure.spreadPct)}
                  </span>
                </div>
                <div className="market-metric-card">
                  <span className="market-metric-label">{t('mkt.pressure')}</span>
                  <span className="market-metric-value">{tHealth(t, analytics?.orderbookPressure.pressureLabel) || '—'}</span>
                </div>
              </div>
              <div className="market-pressure-row">
                <div>
                  <span className="market-copy-title">{t('mkt.entryDepth')}</span>
                  <span>{formatNumber(analytics?.orderbookPressure.entryDepth, 0)} visible quantity</span>
                </div>
                <div>
                  <span className="market-copy-title">{t('mkt.exitDepth')}</span>
                  <span>{formatNumber(analytics?.orderbookPressure.exitDepth, 0)} visible quantity</span>
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
              eyebrow={t('mkteb.structure')}
              info={t('mki.trend')}
              loading={!revealedPanels.trend && !analyticsPanelError}
              errorMessage={!revealedPanels.trend ? analyticsPanelError : null}
              loadingLabel={t('mkl.trend')}
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
                  <span className="market-metric-label">{t('mkt.confidence')}</span>
                  <span className="market-metric-value">{formatPercent(trendMetrics?.confidence)}</span>
                </div>
              </div>
              <div className="market-copy-block">
                <span className="market-copy-title">{t('mkt.crossSignal')}</span>
                <p>{trendMetrics?.crossSignal ?? '—'}</p>
              </div>
              <div className="market-copy-block">
                <span className="market-copy-title">{t('mkt.reversal')}</span>
                <p>{trendMetrics?.reversal ?? '—'}</p>
              </div>
              <div className="market-signal-list">
                {(trendMetrics?.confirmingSignals ?? []).map((signal) => (
                  <span key={signal} className="market-signal-pill">{signal}</span>
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
              eyebrow={t('mkteb.readout')}
              info={t('mki.action')}
              loading={!revealedPanels.action && !analyticsPanelError}
              errorMessage={!revealedPanels.action ? analyticsPanelError : null}
              loadingLabel={t('mkl.readout')}
              headerAside={<ConfidenceBadge confidence={analytics?.actionCard.confidenceSummary} />}
            >
              <div className={`market-action-card tone-${analytics?.actionCard.tone ?? 'neutral'}`}>
                <div className="market-action-header">
                  <span className="market-action-label">{t('mkt.suggestedAction')}</span>
                  <span className="market-action-value">{analytics?.actionCard.suggestedAction ?? '—'}</span>
                </div>
                <div className="market-metric-grid">
                  <div className="market-metric-card">
                    <span className="market-metric-label">{t('mkt.zoneQuality')}</span>
                    <span className="market-metric-value">{analytics?.actionCard.zoneQuality ?? '—'}</span>
                  </div>
                  <div className="market-metric-card">
                    <span className="market-metric-label">{t('mkt.zoneAdjustedEdge')}</span>
                    <span className="market-metric-value">{formatPrice(analytics?.actionCard.zoneAdjustedEdge)}</span>
                  </div>
                  <div className="market-metric-card">
                    <span className="market-metric-label">{t('mkt.spread')}</span>
                    <span className="market-metric-value">
                      {formatPrice(analytics?.actionCard.spread)} · {formatPercent(analytics?.actionCard.spreadPct)}
                    </span>
                  </div>
                  <div className="market-metric-card">
                    <span className="market-metric-label">{t('mkt.bookBias')}</span>
                    <span className="market-metric-value">{tHealth(t, analytics?.actionCard.pressureLabel) || '—'}</span>
                  </div>
                </div>
                <p className="market-action-rationale">{analytics?.actionCard.rationale ?? '—'}</p>
                <div className="market-signal-list">
                  {(analytics?.actionCard.alignedSignals ?? []).map((signal) => (
                    <span key={signal} className="market-signal-pill">{signal}</span>
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
      ) : null}
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
  const revealTimeoutsRef = useRef<number[]>([]);
  const selectedItem = useAppStore((state) => state.quickView.selectedItem);
  const itemNameMap = useAppStore((state) => state.itemNameMap);
  const marketVariants = useAppStore((state) => state.marketVariants);
  const marketVariantsLoading = useAppStore((state) => state.marketVariantsLoading);
  const marketVariantsError = useAppStore((state) => state.marketVariantsError);
  const loadQuickViewItem = useAppStore((state) => state.loadQuickViewItem);
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
  const [watchlistAddFeedback, setWatchlistAddFeedback] = useState<Record<string, boolean>>({});
  const [autocompleteItems, setAutocompleteItems] = useState<WfmAutocompleteItem[]>([]);
  const watchlistAddFeedbackTimeoutsRef = useRef(new Map<string, number>());
  const [revealedPanels, setRevealedPanels] = useState<Record<AnalysisPanelKey, boolean>>(
    () => ({
      ...createRevealState(ANALYSIS_PANEL_SEQUENCE),
      itemDetails: false,
    }),
  );

  useEffect(() => {
    let isMounted = true;
    void getWfmAutocompleteItems(wfstatLangCode(useAppStore.getState().language))
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
      .catch(() => {
        if (!isMounted) {
          return;
        }
        clearRevealTimeouts(revealTimeoutsRef);
        // Reveal the panels anyway so they don't hang forever on "Building…"; the analysis
        // error state surfaces the failure to the user.
        queuePanelReveal(ANALYSIS_PANEL_SEQUENCE, setRevealedPanels, revealTimeoutsRef);
      });

    return () => {
      isMounted = false;
      clearRevealTimeouts(revealTimeoutsRef);
    };
  }, [selectedItem, selectedMarketVariantKey, loadSelectedMarketAnalysis]);

  const eventContextEntries = buildEventContextEntries(t, analysis, {
    alerts: worldStateAlerts,
    events: worldStateEvents,
    invasions: worldStateInvasions,
    syndicateMissions: worldStateSyndicateMissions,
    voidTrader: worldStateVoidTrader,
    flashSales: worldStateFlashSales,
  });
  const eventContextConfidence = buildEventContextConfidence(eventContextEntries, t);

  if (!selectedItem) {
    return (
      <div className="page-content">
        <EmptyAnalyticsState body={t('mkb.pickItemAnalysis')} />
      </div>
    );
  }

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
            void loadQuickViewItem(selectedItem);
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
  const itemImageUrl = resolveWfmAssetUrl(effectiveItemDetails?.imagePath);
  const itemDetailSections = buildItemDetailSections(effectiveItemDetails, t);
  const heroState = buildAnalysisHeroState(analysis, t);
  const liquidityMeterValue = toUnitInterval(analysis?.headline.liquidityScore);
  const trendConfidenceValue = toUnitInterval(analysis?.trend.confidence);
  const riskMeterValue = getRiskTone(analysis?.manipulationRisk.riskLevel) === 'red'
    ? 0.92
    : getRiskTone(analysis?.manipulationRisk.riskLevel) === 'amber'
      ? 0.58
      : getRiskTone(analysis?.manipulationRisk.riskLevel) === 'green'
        ? 0.18
        : 0.35;
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
      {analysis || analysisLoading || marketVariantsLoading ? (
        <>
      {analysisDegradedMessage ? (
        <MarketInlineNotice tone="warning" message={analysisDegradedMessage} />
      ) : null}
      {itemDetailsDegradedMessage ? (
        <MarketInlineNotice tone="warning" message={itemDetailsDegradedMessage} />
      ) : null}
      <div className="market-header-actions">
        <div className="market-item-freshness">
          <span>{t('mkt.fresh.snapshot')} {formatRelativeTimestamp(analysis?.sourceSnapshotAt ?? null)}</span>
          <span>{t('mkt.fresh.stats')} {formatRelativeTimestamp(analysis?.sourceStatsFetchedAt ?? null)}</span>
          <span>{t('mkt.fresh.computed')} {formatRelativeTimestamp(analysis?.computedAt ?? null)}</span>
        </div>
        <button
          className="market-refresh-button"
          type="button"
          aria-label={t('market.refreshAnalysis')}
          title={t('market.refreshAnalysis')}
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
                  <span className="market-hero-kicker market-hero-kicker-row">
                    <span>{t('mkt.tradePosture')}</span>
                    <AdaptiveInfoHint text={t('mki.hero')} />
                  </span>
                  <div className="market-badge-stack">
                    <span className={`market-panel-badge tone-${heroState.tone}`}>{heroState.label}</span>
                    <ConfidenceBadge confidence={analysis?.headline.confidenceSummary} />
                  </div>
                </div>
                <span className="market-hero-item-name">{resolveLocalizedName(itemNameMap, selectedItem)}</span>
                <p className="market-hero-note">{heroState.note}</p>
              </div>
              <div className="market-hero-meter-grid">
                <div className="market-meter-card">
                  <span className="market-copy-title">{t('mkt.liquidity')}</span>
                  <div className="market-meter-track">
                    <div
                      className="market-meter-fill tone-blue"
                      style={{ '--meter-fill': `${Math.round(liquidityMeterValue * 100)}%` } as CSSProperties}
                    />
                  </div>
                  <span className="market-meter-value">
                    {formatPercent(analysis?.headline.liquidityScore)} · {tHealth(t, analysis?.headline.liquidityLabel) || '—'}
                  </span>
                </div>
                <div className="market-meter-card">
                  <span className="market-copy-title">{t('mkt.trendConfidence')}</span>
                  <div className="market-meter-track">
                    <div
                      className="market-meter-fill tone-green"
                      style={{ '--meter-fill': `${Math.round(trendConfidenceValue * 100)}%` } as CSSProperties}
                    />
                  </div>
                  <span className="market-meter-value">
                    {formatPercent(analysis?.trend.confidence)} · {tHealth(t, analysis?.trend.direction) || '—'}
                  </span>
                </div>
                <div className="market-meter-card">
                  <span className="market-copy-title">{t('mkt.riskPosture')}</span>
                  <div className="market-meter-track">
                    <div
                      className={`market-meter-fill tone-${getRiskTone(analysis?.manipulationRisk.riskLevel)}`}
                      style={{ '--meter-fill': `${Math.round(riskMeterValue * 100)}%` } as CSSProperties}
                    />
                  </div>
                  <span className="market-meter-value">{tHealth(t, analysis?.manipulationRisk.riskLevel) || '—'}</span>
                </div>
              </div>
            </div>
            <div className="market-analysis-summary-grid">
              <div className="market-summary-card">
                <span className="market-summary-label">{t('mkt.entryPrice')}</span>
                <span className="market-summary-value">{formatPrice(analysis?.headline.entryPrice)}</span>
              </div>
              <div className="market-summary-card">
                <span className="market-summary-label">Exit Price ({analysis?.headline.exitPercentileLabel ?? 'P60'})</span>
                <span className="market-summary-value">{formatPrice(analysis?.headline.exitPrice)}</span>
              </div>
              <div className="market-summary-card">
                <span className="market-summary-label">{t('mkt.netMargin')}</span>
                <span className="market-summary-value">{formatPrice(analysis?.headline.netMargin)}</span>
              </div>
              <div className="market-summary-card">
                <span className="market-summary-label">{t('mkt.liquidity')}</span>
                <span className="market-summary-value">
                  {formatPercent(analysis?.headline.liquidityScore)} · {tHealth(t, analysis?.headline.liquidityLabel) || '—'}
                </span>
              </div>
            </div>
            <PanelOverlay
              loading={!revealedPanels.headline && !analysisError}
              errorMessage={!revealedPanels.headline ? analysisError : null}
              label={t('mkt.buildingHeadlineMetrics')}
            />
          </div>

          <AnalyticsPanel
            title={t('a11y.flipAnalysis')}
            eyebrow={t('mkteb.executionModel')}
            info={t('mki.flip')}
            loading={!revealedPanels.flip && !analysisError}
            errorMessage={!revealedPanels.flip ? analysisError : null}
            loadingLabel={t('mkl.flip')}
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
            <div className="market-metric-grid">
              <div className="market-metric-card">
                <span className="market-metric-label">{t('mkt.entryPrice')}</span>
                <span className="market-metric-value">{formatPrice(analysis?.flipAnalysis.entryPrice)}</span>
              </div>
              <div className="market-metric-card">
                <span className="market-metric-label">{t('mkt.exitPrice')}</span>
                <span className="market-metric-value">{formatPrice(analysis?.flipAnalysis.exitPrice)}</span>
              </div>
              <div className="market-metric-card">
                <span className="market-metric-label">{t('mkt.grossMargin')}</span>
                <span className="market-metric-value">{formatPrice(analysis?.flipAnalysis.grossMargin)}</span>
              </div>
              <div className="market-metric-card">
                <span className="market-metric-label">{t('mkt.netMargin')}</span>
                <span className="market-metric-value">{formatPrice(analysis?.flipAnalysis.netMargin)}</span>
              </div>
              <div className="market-metric-card">
                <span className="market-metric-label">{t('mkt.efficiencyScore')}</span>
                <span className="market-metric-value">
                  {formatPercent(analysis?.flipAnalysis.efficiencyScore)} · {tHealth(t, analysis?.flipAnalysis.efficiencyLabel) || '—'}
                </span>
              </div>
            </div>
            <ConfidenceNote confidence={analysis?.flipAnalysis.confidenceSummary} />
          </AnalyticsPanel>

          <AnalyticsPanel
            title={t('a11y.liquidityDetail')}
            eyebrow={t('mkteb.marketStructure')}
            info={t('mki.liquidity')}
            loading={!revealedPanels.liquidity && !analysisError}
            errorMessage={!revealedPanels.liquidity ? analysisError : null}
            loadingLabel={t('mkl.liquidity')}
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
            <div className="market-metric-grid">
              <div className="market-metric-card">
                <span className="market-metric-label">{t('mkt.demandRatio')}</span>
                <span className="market-metric-value">{formatNumber(analysis?.liquidityDetail.demandRatio, 2)}</span>
              </div>
              <div className="market-metric-card">
                <span className="market-metric-label">{t('mkt.state')}</span>
                <span className="market-metric-value">{analysis?.liquidityDetail.state ?? '—'}</span>
              </div>
              <div className="market-metric-card">
                <span className="market-metric-label">{t('mkt.sellersWithin')}</span>
                <span className="market-metric-value">{formatNumber(analysis?.liquidityDetail.sellersWithinTwoPt, 0)}</span>
              </div>
              <div className="market-metric-card">
                <span className="market-metric-label">{t('mkt.undercutVelocity')}</span>
                <span className="market-metric-value">{formatNumber(analysis?.liquidityDetail.undercutVelocity, 2)} / h</span>
              </div>
              <div className="market-metric-card">
                <span className="market-metric-label">{t('mkt.qtyWeightedDemand')}</span>
                <span className="market-metric-value">{formatPercent(analysis?.liquidityDetail.quantityWeightedDemand)}</span>
              </div>
              <div className="market-metric-card">
                <span className="market-metric-label">{t('mkt.liquidity')}</span>
                <span className="market-metric-value">{formatPercent(analysis?.liquidityDetail.liquidityScore)}</span>
              </div>
            </div>
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
            title={t('trades.analysis.trend')}
            eyebrow={t('mkteb.analyticsCarryover')}
            info={t('mki.trendSummary')}
            loading={!revealedPanels.trend && !analysisError}
            errorMessage={!revealedPanels.trend ? analysisError : null}
            loadingLabel={t('mkl.trendSummary')}
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
            <div className="market-metric-grid">
              <div className="market-metric-card">
                <span className="market-metric-label">{t('mkt.direction')}</span>
                <span className="market-metric-value">{tHealth(t, analysis?.trend.direction) || '—'}</span>
              </div>
              <div className="market-metric-card">
                <span className="market-metric-label">{t('mkt.confidence')}</span>
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
              <span className="market-copy-title">{t('mkt.summary')}</span>
              <p>{analysis ? tTrendSummary(t, analysis.trend) : '—'}</p>
            </div>
            <ConfidenceNote confidence={analysis?.trend.confidenceSummary} />
          </AnalyticsPanel>

          <AnalyticsPanel
            title={
              analysis?.supplyContext.mode === 'set-components'
                ? t('mkt.setComponents')
                : analysis?.supplyContext.mode === 'drop-sources'
                  ? t('mkt.dropSources')
                  : t('mkt.dropSourcesOrSetComponents')
            }
            eyebrow={t('mkteb.supplyContext')}
            info={t('mki.supply')}
            loading={!revealedPanels.supply && !analysisError}
            errorMessage={!revealedPanels.supply ? analysisError : null}
            loadingLabel={t('mkl.supply')}
            className="market-panel-tone-amber"
            headerAside={
              <div className="market-badge-stack">
                <span className="market-panel-badge tone-amber">
                  {analysis?.supplyContext.mode === 'set-components'
                    ? t('mkt.setBreakdown')
                    : analysis?.supplyContext.mode === 'drop-sources'
                      ? t('mkt.dropIntel')
                      : t('mkt.noSource')}
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
                          wfmId: null,
                          name: component.name,
                          slug: component.slug,
                          maxRank: null,
                          itemFamily: null,
                          imagePath: component.imagePath,
                          bulkTradable: false,
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
                          <span className="market-copy-title">{resolveLocalizedName(itemNameMap, component)}</span>
                          <span>Needed for set: {component.quantityInSet}x</span>
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
                        <div className="watchlist-add-feedback-stack">
                          {watchlistAddFeedback[component.slug] ? (
                            <span className="watchlist-add-success">{t('wl.addedToWatchlist')}</span>
                          ) : null}
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
                              markWatchlistAddFeedback(
                                component.slug,
                                setWatchlistAddFeedback,
                                watchlistAddFeedbackTimeoutsRef,
                              );
                            }}
                          >
                            {t('wl.addToWatchlist')}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : analysis?.supplyContext.mode === 'drop-sources' ? (
              <div className="market-drop-list">
                {displayDropSources.map((source) => {
                  const imageUrl = resolveWfmAssetUrl(source.imagePath);
                  return (
                    <div key={source.key} className="market-drop-card">
                      <div className="market-drop-card-top">
                        {source.isRelic ? (
                          imageUrl ? (
                            <img className="market-drop-image" src={imageUrl} alt={source.location} loading="lazy" />
                          ) : (
                            <span className="market-drop-image placeholder" aria-hidden="true">
                              {source.location.slice(0, 2)}
                            </span>
                          )
                        ) : null}
                        <span className="market-drop-title">{source.location}</span>
                      </div>
                      {source.isRelic ? <span>Rarity: {source.rarity ?? '—'}</span> : null}
                      {!source.isRelic ? <span>Chance: {formatDropChancePercent(source.chance)}</span> : null}
                      {!source.isRelic ? <span>Rarity: {source.rarity ?? '—'}</span> : null}
                      {!source.isRelic ? <span>Type: {source.sourceType ?? '—'}</span> : null}
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

        <div className="market-analysis-column market-analysis-column-side">
          <div className="market-analysis-item-details">
              <AnalyticsPanel
                title={t('a11y.itemDetails')}
                eyebrow={t('mkteb.reference')}
                info={t('mki.reference')}
                loading={itemDetailsLoading || (!revealedPanels.itemDetails && !itemDetailsError)}
                errorMessage={effectiveItemDetails ? null : itemDetailsError}
                loadingLabel={t('mkl.details')}
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
                    <span className="market-copy-title">{t('mkt.description')}</span>
                    <p>{effectiveItemDetails.description}</p>
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
            title={t('a11y.eventContext')}
            eyebrow={t('mkteb.worldState')}
            info={t('mki.worldstate')}
            loading={!revealedPanels.eventContext && !analysisError}
            errorMessage={!revealedPanels.eventContext ? analysisError : null}
            loadingLabel={t('mkl.worldstate')}
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

          <AnalyticsPanel
            title={t('a11y.manipulationRisk')}
            eyebrow={t('mkteb.safety')}
            info={t('mki.risk')}
            loading={!revealedPanels.manipulation && !analysisError}
            errorMessage={!revealedPanels.manipulation ? analysisError : null}
            loadingLabel={t('mkl.risk')}
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
            <div className="market-metric-grid">
              <div className="market-metric-card">
                <span className="market-metric-label">{t('mkt.riskLevel')}</span>
                <span className="market-metric-value">{tHealth(t, analysis?.manipulationRisk.riskLevel) || '—'}</span>
              </div>
              <div className="market-metric-card">
                <span className="market-metric-label">{t('mkt.activeSignals')}</span>
                <span className="market-metric-value">{formatNumber(analysis?.manipulationRisk.activeSignals, 0)}</span>
              </div>
              <div className="market-metric-card">
                <span className="market-metric-label">{t('mkt.efficiencyPenalty')}</span>
                <span className="market-metric-value">{formatPercent(analysis?.manipulationRisk.efficiencyPenaltyPct)}</span>
              </div>
            </div>
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
                  <span className="market-copy-title">{signal.label}</span>
                  <span className="market-analysis-signal-state">
                    {signal.active ? t('mkt.signal.active') : t('mkt.signal.clear')}
                  </span>
                  <p>{signal.detail}</p>
                </div>
              ))}
            </div>
          </AnalyticsPanel>

          <AnalyticsPanel
            title={t('a11y.timeOfDayLiquidity')}
            eyebrow={t('mkteb.observatoryTape')}
            info={t('mki.timeOfDay')}
            loading={!revealedPanels.timeOfDay && !analysisError}
            errorMessage={!revealedPanels.timeOfDay ? analysisError : null}
            loadingLabel={t('mkl.tape')}
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
                        style={{ '--heat-strength': `${Math.round((cell.heatScore ?? 0) * 100)}%` } as CSSProperties}
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
        </div>
      </div>
        </>
      ) : null}
    </div>
  );
}

// ─── Calibration tab ──────────────────────────────────────────────────────────

const MIN_TRADES_FOR_DISPLAY = 5;

function formatReturnPct(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

function returnTone(value: number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return value >= 5 ? ' tone-green' : value >= 0 ? ' tone-amber' : ' tone-red';
}

function CalibrationBucketCard({ stat }: { stat: BacktestBucketStats }) {
  const { t } = useTranslation();
  const enough = stat.tradeCount >= MIN_TRADES_FOR_DISPLAY;
  const hitPct = stat.hitRate !== null ? Math.round(stat.hitRate * 100) : null;

  return (
    <div className="card market-panel calib-bucket-card">
      <div className="card-header">
        <div className="market-panel-header">
          <div className="market-panel-header-copy">
            <span className="panel-title-eyebrow">{t('mkt.action')}</span>
            <span className="card-label">{stat.label}</span>
          </div>
          {enough && hitPct !== null && (
            <div className="market-panel-header-aside">
              <span className={`market-panel-badge${returnTone(stat.medianReturnPct)}`}>
                {hitPct}% hit
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="card-body market-panel-body">
        {!enough ? (
          <p className="calib-insufficient">
            {stat.tradeCount === 0
              ? t('mkt.noGradedTrades')
              : t('mkt.onlyGradedTradesNeedMore', { n: stat.tradeCount, min: MIN_TRADES_FOR_DISPLAY })}
          </p>
        ) : (
          <>
            <div className="market-metric-grid">
              <div className="market-metric-card">
                <span className="market-metric-label">{t('mkt.medianReturn')}</span>
                <span className={`market-metric-value${returnTone(stat.medianReturnPct)}`}>
                  {formatReturnPct(stat.medianReturnPct)}
                </span>
              </div>
              <div className="market-metric-card">
                <span className="market-metric-label">{t('mkt.hitRate')}</span>
                <span className="market-metric-value">{hitPct !== null ? `${hitPct}%` : '—'}</span>
              </div>
              <div className="market-metric-card">
                <span className="market-metric-label">{t('mkt.trades')}</span>
                <span className="market-metric-value">{stat.tradeCount}</span>
              </div>
              <div className="market-metric-card">
                <span className="market-metric-label">{t('mkt.medianDaysHeld')}</span>
                <span className="market-metric-value">
                  {stat.medianDaysHeld !== null ? `${stat.medianDaysHeld?.toFixed(1)}d` : '—'}
                </span>
              </div>
            </div>
            <div className="calib-return-band">
              <span className="market-copy-title">{t('mkt.returnRange')}</span>
              <span className={`calib-band-value${returnTone(stat.p25ReturnPct)}`}>
                {formatReturnPct(stat.p25ReturnPct)}
              </span>
              <span className="calib-band-sep">→</span>
              <span className={`calib-band-value${returnTone(stat.p75ReturnPct)}`}>
                {formatReturnPct(stat.p75ReturnPct)}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function CalibrationTab() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<BacktestSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    setError(null);
    getBacktestSummary()
      .then((nextSummary) => {
        if (isMounted) {
          setSummary(nextSummary);
        }
      })
      .catch((err: unknown) => {
        if (isMounted) {
          setError(
            err instanceof Error
              ? err.message
              : t('mkt.backtestLoadFailed'),
          );
        }
      })
      .finally(() => {
        if (isMounted) {
          setLoading(false);
        }
      });
    return () => {
      isMounted = false;
    };
  }, []);

  const rolling30dHitPct =
    summary?.rolling30dHitRate !== null && summary?.rolling30dHitRate !== undefined
      ? Math.round(summary.rolling30dHitRate * 100)
      : null;

  return (
    <div className="market-page-content">
      <div className="market-page-scroll-area" style={{ paddingTop: 16 }}>
        <div className="market-analytics-grid">

          <AnalyticsPanel
            title={t('a11y.backtestStatus')}
            eyebrow={t('mkteb.trackRecord')}
            info={t('mki.backtest')}
            loading={loading}
            loadingLabel={t('mkl.backtest')}
          >
            {error ? (
              <p className="calib-insufficient">{error}</p>
            ) : (
              <div className="market-pressure-row">
                <div>
                  <span className="market-copy-title">{t('mkt.graded')}</span>
                  <span>{summary?.totalGraded ?? '—'}</span>
                </div>
                <div>
                  <span className="market-copy-title">{t('mkt.pending')}</span>
                  <span>{summary?.totalPending ?? '—'}</span>
                </div>
                <div>
                  <span className="market-copy-title">{t('mkt.openPositions')}</span>
                  <span>{summary?.totalOpen ?? '—'}</span>
                </div>
              </div>
            )}
            {!error && summary && (
              <div className="market-copy-block" style={{ marginTop: 8 }}>
                <span className="market-copy-title">{t('mkt.rollingHitRate')}</span>
                <span
                  className={`calib-rolling-hit${returnTone(rolling30dHitPct)}`}
                >
                  {rolling30dHitPct !== null
                    ? t('mkt.gradedTradesAcross', { pct: rolling30dHitPct, n: summary.rolling30dTradeCount })
                    : t('mkt.notEnoughDataYet')}
                </span>
              </div>
            )}
          </AnalyticsPanel>

          <AnalyticsPanel
            title={t('a11y.buyCalibration')}
            eyebrow={t('mkteb.buyHold')}
            info={t('mki.calibration')}
            loading={loading}
            loadingLabel={t('mkl.calibration')}
          >
            {error ? (
              <p className="calib-insufficient">{error}</p>
            ) : (
              <div className="calib-bucket-grid">
                {(summary?.buyTradeStats ?? []).map((stat) => (
                  <CalibrationBucketCard key={stat.label} stat={stat} />
                ))}
              </div>
            )}
          </AnalyticsPanel>

          <AnalyticsPanel
            title={t('a11y.howThisWorks')}
            eyebrow={t('mkteb.methodology')}
            info={t('mki.methodology')}
          >
            <div className="market-copy-block">
              <span className="market-copy-title">{t('mkt.entryModel')}</span>
              <p>
                Each time analytics are computed for a tracked item, one recommendation is recorded
                (at most once per 6 hours per item). Entry is considered triggered if the live floor
                drops into the entry zone within 48 hours.
              </p>
            </div>
            <div className="market-copy-block">
              <span className="market-copy-title">{t('mkt.exitModel')}</span>
              <p>
                After entry, exit is triggered if the floor rises to the exit zone low within 7 days.
                If no exit occurs, the trade is marked to market at the floor on day 7.
              </p>
            </div>
            <div className="market-copy-block">
              <span className="market-copy-title">{t('mkt.realizedReturn')}</span>
              <p>
                (exit price − entry price) ÷ entry price. No transaction fee. Mark-to-market is
                used when the exit zone is not reached, so stuck capital is counted against the score.
              </p>
            </div>
            <div className="market-copy-block">
              <span className="market-copy-title">{t('mkt.limitations')}</span>
              <p>
                Floor price is used as a fill proxy — real fills depend on availability and
                counterparty online status. The first several weeks of data will show low trade
                counts; the calibration becomes meaningful once 5+ trades per action bucket are graded.
              </p>
            </div>
          </AnalyticsPanel>

        </div>
      </div>
    </div>
  );
}

export function MarketPage() {
  const marketSubTab = useAppStore((s) => s.marketSubTab);
  const setMarketSubTab = useAppStore((s) => s.setMarketSubTab);
  const { t } = useTranslation();

  useEffect(() => {
    setMarketSubTab('analysis');
  }, [setMarketSubTab]);

  return (
    <>
      <div className="subnav market-page-subnav">
        <div className="subnav-left">
          <span className="page-title">{t('market.title')}</span>
          {([
            ['analysis', 'market.tab.analysis'],
            ['analytics', 'market.tab.analytics'],
            ['calibration', 'market.tab.calibration'],
          ] as const).map(([tab, labelKey]) => (
            <span
              key={tab}
              className={`subtab${marketSubTab === tab ? ' active' : ''}`}
              onClick={() => setMarketSubTab(tab)}
              role="tab"
              aria-selected={marketSubTab === tab}
              tabIndex={0}
            >
              {t(labelKey)}
            </span>
          ))}
        </div>
      </div>

      {marketSubTab === 'analytics' ? <AnalyticsTab /> : marketSubTab === 'calibration' ? <CalibrationTab /> : <AnalysisTab />}
    </>
  );
}
