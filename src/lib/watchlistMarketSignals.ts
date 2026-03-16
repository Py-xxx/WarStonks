import type { WatchlistItem } from '../types';

const MAX_SIGNAL_AGE_MINUTES = 30;
const MIN_SAMPLE_COUNT = 5;
const TRIM_THRESHOLD_COUNT = 8;
const TRIM_RATIO = 0.1;

type SignalTone = 'green' | 'amber' | 'red';

export type WatchlistMarketSignalKey = 'momentum' | 'spread-quality' | 'volatility';

export type WatchlistMarketSignal = {
  key: WatchlistMarketSignalKey;
  label: string;
  valueText: string;
  subtitle: string;
  tooltip: string;
  tone: SignalTone;
  fillPct: number;
  score: number | null;
  sampleCount: number;
};

type WeightedMetric = {
  metric: number;
  weight: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function parseUpdatedAt(lastUpdatedAt: string | null): number | null {
  if (!lastUpdatedAt) {
    return null;
  }

  const parsed = Date.parse(lastUpdatedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function getFreshnessWeight(lastUpdatedAt: string | null, nowMs: number): number | null {
  const updatedAtMs = parseUpdatedAt(lastUpdatedAt);
  if (updatedAtMs === null) {
    return null;
  }

  const ageMinutes = (nowMs - updatedAtMs) / 60_000;
  if (ageMinutes < 0 || ageMinutes > MAX_SIGNAL_AGE_MINUTES) {
    return null;
  }

  return clamp(1 - ageMinutes / MAX_SIGNAL_AGE_MINUTES, 0.25, 1);
}

function getBaseEligibleMetrics(items: WatchlistItem[], nowMs: number): Array<{
  item: WatchlistItem;
  weight: number;
}> {
  const eligible: Array<{ item: WatchlistItem; weight: number }> = [];

  for (const item of items) {
    if (item.currentPrice === null || item.currentPrice <= 0 || item.lastError) {
      continue;
    }

    const freshnessWeight = getFreshnessWeight(item.lastUpdatedAt, nowMs);
    if (freshnessWeight === null) {
      continue;
    }

    const liquidityWeight = clamp(Math.log(item.volume + 1), 0.5, 4.0);
    eligible.push({
      item,
      weight: freshnessWeight * liquidityWeight,
    });
  }

  return eligible;
}

function buildTrimmedWeightedMean(metrics: WeightedMetric[]): number | null {
  if (metrics.length === 0) {
    return null;
  }

  const sorted = [...metrics].sort((left, right) => left.metric - right.metric);
  const trimCount = sorted.length >= TRIM_THRESHOLD_COUNT ? Math.floor(sorted.length * TRIM_RATIO) : 0;
  const trimmed = sorted.slice(trimCount, sorted.length - trimCount || sorted.length);

  let weightedSum = 0;
  let totalWeight = 0;
  for (const entry of trimmed) {
    weightedSum += entry.metric * entry.weight;
    totalWeight += entry.weight;
  }

  return totalWeight > 0 ? weightedSum / totalWeight : null;
}

function buildEmptySignal(
  key: WatchlistMarketSignalKey,
  label: string,
  tooltip: string,
): WatchlistMarketSignal {
  return {
    key,
    label,
    valueText: '—',
    subtitle: 'Not enough fresh watchlist data',
    tooltip,
    tone: 'amber',
    fillPct: 0,
    score: null,
    sampleCount: 0,
  };
}

function formatSignedScore(value: number): string {
  const rounded = Math.round(value);
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}

function buildMomentumSignal(items: Array<{ item: WatchlistItem; weight: number }>): WatchlistMarketSignal {
  const tooltip =
    'Weighted trimmed score from fresh watchlist items, combining 24h change (70%) with current price position inside the entry and exit zone (30%).';
  if (items.length < MIN_SAMPLE_COUNT) {
    return buildEmptySignal('momentum', 'Momentum', tooltip);
  }

  const score = buildTrimmedWeightedMean(
    items.map(({ item, weight }) => {
      const deltaSignal = clamp(item.delta24h / 15, -1, 1);
      let zoneSignal = 0;

      if (
        item.entryPrice !== null &&
        item.exitPrice !== null &&
        item.currentPrice !== null &&
        item.exitPrice > item.entryPrice
      ) {
        const midpoint = (item.entryPrice + item.exitPrice) / 2;
        const halfRange = Math.max((item.exitPrice - item.entryPrice) / 2, 1);
        zoneSignal = clamp((item.currentPrice - midpoint) / halfRange, -1, 1);
      }

      return {
        metric: 100 * (0.7 * deltaSignal + 0.3 * zoneSignal),
        weight,
      };
    }),
  );

  if (score === null) {
    return buildEmptySignal('momentum', 'Momentum', tooltip);
  }

  const tone: SignalTone = score > 20 ? 'green' : score < -20 ? 'red' : 'amber';
  const valueText = score > 20 ? 'Bullish' : score < -20 ? 'Weak' : 'Stable';

  return {
    key: 'momentum',
    label: 'Momentum',
    valueText,
    subtitle: `Score ${formatSignedScore(score)} · ${items.length} items`,
    tooltip,
    tone,
    fillPct: clamp((score + 100) / 2, 0, 100),
    score,
    sampleCount: items.length,
  };
}

function buildSpreadQualitySignal(
  items: Array<{ item: WatchlistItem; weight: number }>,
): WatchlistMarketSignal {
  const tooltip =
    'Weighted trimmed quality score using exit headroom (55%), current alignment versus entry (25%), and watchlist liquidity from item volume (20%).';
  const eligible = items.filter(
    ({ item }) =>
      item.entryPrice !== null &&
      item.entryPrice > 0 &&
      item.exitPrice !== null &&
      item.currentPrice !== null &&
      item.exitPrice > item.currentPrice,
  );

  if (eligible.length < MIN_SAMPLE_COUNT) {
    return buildEmptySignal('spread-quality', 'Spread Quality', tooltip);
  }

  const score = buildTrimmedWeightedMean(
    eligible.map(({ item, weight }) => {
      const currentPrice = item.currentPrice ?? 0;
      const entryPrice = item.entryPrice ?? 0;
      const exitPrice = item.exitPrice ?? 0;
      const headroomPct = 100 * ((exitPrice - currentPrice) / Math.max(currentPrice, 1));
      const marginScore = clamp(headroomPct / 15, 0, 1);
      const entryGapPct = 100 * ((currentPrice - entryPrice) / Math.max(entryPrice, 1));
      const entryAlignment = clamp(1 - entryGapPct / 10, 0, 1);
      const liquidityScore = clamp(Math.log(item.volume + 1) / 4, 0, 1);

      return {
        metric: 100 * (0.55 * marginScore + 0.25 * entryAlignment + 0.2 * liquidityScore),
        weight,
      };
    }),
  );

  if (score === null) {
    return buildEmptySignal('spread-quality', 'Spread Quality', tooltip);
  }

  const tone: SignalTone = score >= 70 ? 'green' : score >= 45 ? 'amber' : 'red';
  return {
    key: 'spread-quality',
    label: 'Spread Quality',
    valueText: `${Math.round(score)}/100`,
    subtitle: `${eligible.length} tradable items`,
    tooltip,
    tone,
    fillPct: clamp(score, 0, 100),
    score,
    sampleCount: eligible.length,
  };
}

function buildVolatilitySignal(items: Array<{ item: WatchlistItem; weight: number }>): WatchlistMarketSignal {
  const tooltip =
    'Weighted trimmed 24h absolute move across fresh watchlist items. Lower means calmer pricing; higher means more unstable movement.';
  if (items.length < MIN_SAMPLE_COUNT) {
    return buildEmptySignal('volatility', 'Volatility', tooltip);
  }

  const score = buildTrimmedWeightedMean(
    items.map(({ item, weight }) => ({
      metric: Math.abs(item.delta24h),
      weight,
    })),
  );

  if (score === null) {
    return buildEmptySignal('volatility', 'Volatility', tooltip);
  }

  const tone: SignalTone = score < 5 ? 'green' : score < 12 ? 'amber' : 'red';
  return {
    key: 'volatility',
    label: 'Volatility',
    valueText: `${score.toFixed(1)}%`,
    subtitle: `24h absolute move · ${items.length} items`,
    tooltip,
    tone,
    fillPct: clamp((score / 20) * 100, 0, 100),
    score,
    sampleCount: items.length,
  };
}

export function buildWatchlistMarketSignals(
  watchlist: WatchlistItem[],
  nowMs = Date.now(),
): WatchlistMarketSignal[] {
  const baseEligible = getBaseEligibleMetrics(watchlist, nowMs);

  return [
    buildMomentumSignal(baseEligible),
    buildSpreadQualitySignal(baseEligible),
    buildVolatilitySignal(baseEligible),
  ];
}

