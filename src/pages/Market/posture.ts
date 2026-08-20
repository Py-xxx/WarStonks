/**
 * Trade posture, and the tone helpers behind it.
 *
 * Extracted from `index.tsx` so `DashboardPanels` can use them: the posture is now rendered inside
 * Quick View rather than as its own panel, and index.tsx imports Quick View, so the dependency had
 * to be broken rather than reversed.
 */
import { confidenceTone } from '../../lib/healthLabels';
import type { TranslateFn } from '../../i18n';
import type { ItemAnalysisResponse, MarketConfidenceSummary } from '../../types';

export type PanelTone = 'neutral' | 'blue' | 'green' | 'amber' | 'red';


export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function toUnitInterval(value: number | null | undefined, fallback = 0): number {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return fallback;
  }
  return clampNumber(value > 1 ? value / 100 : value, 0, 1);
}

export function ratioToUnitInterval(value: number | null | undefined): number {
  if (value === null || value === undefined || Number.isNaN(value) || value <= 0) {
    return 0;
  }
  return clampNumber(value / (value + 1), 0, 1);
}

export function slopeToUnitInterval(value: number | null | undefined): number {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return 0.5;
  }
  return clampNumber(0.5 + value * 4, 0, 1);
}

export function getRiskTone(riskLevel: string | null | undefined): PanelTone {
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

export function getTrendTone(direction: string | null | undefined): PanelTone {
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

export function getConfidenceTone(confidence: MarketConfidenceSummary | null | undefined): PanelTone {
  return confidenceTone(confidence);
}

export function buildAnalysisHeroState(analysis: ItemAnalysisResponse | null, t: TranslateFn) {
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
