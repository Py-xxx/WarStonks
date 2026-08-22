import type { RelicRoiDropEntry, RelicRoiEntry } from '../../types';

/**
 * Shapes and formatting shared by "What To Farm Now" — the page computes these, `FarmNow.tsx`
 * renders them.
 *
 * The split exists because the derivation genuinely belongs to the page (it joins the relic scan,
 * the owned-relic cache and the planner inventory, all of which live in `index.tsx`'s state) while
 * the rendering is 800 lines that had no business sharing a file with five other tabs. Types and
 * pure formatters go here so neither side owns them and there is no import cycle.
 */

export type RefinementMetric = {
  key: string;
  label: string;
  value: number | null;
  owned: number;
};

export type RefinementGuidance = {
  metrics: RefinementMetric[];
  bestKey: string;
  bestLabel: string;
  hint: string;
  /** Set when the user owns none of the recommended refinement but some of another. */
  ownedNote: { count: number; label: string } | null;
};

export type FarmNowRelicRow = {
  relic: RelicRoiEntry;
  tier: string;
  ownedCount: number;
  expectedProfit: number | null; // EV/run at the recommended refinement
  platPerHour: number | null;
  guidance: RefinementGuidance;
  bestDropSlug: string | null;
  /** Set when the search query targeted a specific drop item (item-targeted refinement mode). */
  targetedDropName?: string;
  drops: Array<{
    drop: RelicRoiDropEntry;
    chance: number | null;
    expectedValue: number | null;
  }>;
};

export type FarmNowSetCompletionDrop = {
  drop: RelicRoiDropEntry;
  isNeeded: boolean;
  missingQuantity: number;
  coveredSetCount: number;
  setNames: string[];
  /** Best (closest-to-complete) set this drop helps: owned/total parts. */
  bestSetProgress: { owned: number; total: number } | null;
};

export type FarmNowSetCompletionRow = {
  relic: RelicRoiEntry;
  tier: string;
  ownedCount: number;
  neededDropCount: number;
  totalMissingQuantity: number;
  coveredSetCount: number;
  coveredSetNames: string[];
  /** Progress-weighted priority: completes near-finished sets first. */
  completionScore: number;
  /** The closest-to-complete set this relic helps. */
  bestSetProgress: { owned: number; total: number; name: string } | null;
  /** Which refinement to run for the best shot at the NEEDED parts. */
  guidance: RefinementGuidance;
  drops: FarmNowSetCompletionDrop[];
};

/** The two questions the tab can answer. Each has its own rows, metrics and sort options. */
export type FarmNowMode = 'part-profit' | 'set-completion';

/**
 * Everything that can stand between the user and a list of relics, resolved to one value.
 *
 * This was a nine-deep nested ternary written out **twice**, once per mode — ~200 lines of
 * near-identical branches. The states themselves all matter: "no scan", "no relics" and "no
 * inventory" send you to three different places, so none of them can be collapsed into a generic
 * "nothing here". What was duplicated was the *rendering*, not the meaning.
 */
export type FarmNowGate =
  | { kind: 'loading' }
  | { kind: 'noScan' }
  | { kind: 'relicsLoading' }
  | { kind: 'relicsError'; message: string }
  | { kind: 'needsRelicLoad' }
  | { kind: 'noOwnedRelics' }
  | { kind: 'noInventory' }
  | { kind: 'ready' };

export function formatPlat(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }

  return `${Math.round(value)}p`;
}

export function formatPlatDecimal(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }

  return `${(Math.round(value * 10) / 10).toFixed(1)}p`;
}

/** Sub-1% chances keep a decimal; above 10% they don't, because nobody reads `12.4%` differently
 *  from `12%` when deciding which relic to run. */
export function formatChance(value: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }

  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded}%`;
}

export function relicRarityTone(rarity: string | null): string {
  const normalized = rarity?.toLowerCase() ?? '';
  if (normalized.includes('rare')) {
    return 'rare';
  }
  if (normalized.includes('uncommon')) {
    return 'uncommon';
  }
  if (normalized.includes('common')) {
    return 'common';
  }
  return 'unknown';
}

export function relicRefinementTone(refinementKey: string): string {
  switch (refinementKey) {
    case 'exceptional':
      return 'exceptional';
    case 'flawless':
      return 'flawless';
    case 'radiant':
      return 'radiant';
    case 'intact':
      return 'intact';
    default:
      return 'unknown';
  }
}

/**
 * Rarity → accent, ported from `.owned-relics-rarity-*`: common blue, uncommon green, rare purple.
 *
 * Not invented — Owned Relics and the Set Planner already paint rarity this way, and a second
 * rarity language on the tab that sits next to them is exactly the divergence this migration
 * exists to stop. Text colour only, no pill: the shipped badge is a bordered chip, but these sit
 * three-to-a-row inside a drop line where a chip is a box around a single word.
 */
export const RARITY_CLASS: Record<string, string> = {
  common: 'text-accent-blue',
  uncommon: 'text-accent-green',
  rare: 'text-accent-purple',
  unknown: 'text-ink-faint',
};

/**
 * Refinement → accent, ported from `.relic-refinement-pill-*`.
 *
 * Radiant is the deepest investment and gets the strongest colour; Intact is the default state and
 * stays neutral, so "run it Intact" doesn't read as a warning.
 */
export const REFINEMENT_CLASS: Record<string, string> = {
  intact: 'bg-bg-elevated text-ink-soft',
  exceptional: 'bg-accent-blue/15 text-accent-blue',
  flawless: 'bg-accent-purple/15 text-accent-purple',
  radiant: 'bg-accent-amber/15 text-accent-amber',
  unknown: 'bg-bg-elevated text-ink-dim',
};
