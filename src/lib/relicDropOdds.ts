/** The confidence level the "how many runs" hint aims for. */
export const ODDS_TARGET = 0.8;

/** Refinement keys in ascending order of quality. */
export const REFINEMENT_KEYS = ['intact', 'exceptional', 'flawless', 'radiant'] as const;
export type RefinementKey = (typeof REFINEMENT_KEYS)[number];

/** Per-refinement drop chance for one relic (0..1), as reported by the scanner. */
export type ChanceProfile = Partial<Record<RefinementKey, number | null>>;

/** How many of a relic you hold at each refinement. */
export type RefinementCounts = Partial<Record<RefinementKey, number>>;

export interface RelicOddsInput {
  /** Display label, e.g. "Meso O2". */
  label: string;
  chances: ChanceProfile;
  counts: RefinementCounts;
}

export interface RefinementOdds {
  refinement: RefinementKey;
  count: number;
  /** Per-run chance at this refinement (0..1). */
  chance: number;
  /** Chance of at least one drop across all your relics at this refinement (0..1). */
  atLeastOne: number;
}

export interface RelicOdds {
  label: string;
  /** Only refinements you actually hold, best-chance first. */
  breakdown: RefinementOdds[];
  totalCount: number;
  /** Chance of at least one drop if you run every copy you own of this relic. */
  atLeastOne: number;
  /** The refinement with the highest per-run chance for this drop (whether or not you own it). */
  bestRefinement: RefinementKey | null;
  bestChance: number | null;
  /** True when you hold none at the best refinement — i.e. upgrading would help. */
  missingBest: boolean;
}

export interface DropOddsSummary {
  relics: RelicOdds[];
  /** Total relics you own that can drop this item. */
  totalRelics: number;
  /** Chance of at least one drop if you run everything you own. */
  atLeastOne: number;
  /** Expected number of copies from running everything (can exceed 1). */
  expectedDrops: number;
  /** How many runs at the best refinement to reach ~80% odds. `null` when unknown. */
  runsForTargetOdds: number | null;
}

const clampChance = (value: number | null | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;

/**
 * Probability of at least one success across independent runs: `1 - Π(1 - p)^n`.
 *
 * Deliberately NOT `chance × count` — that overstates badly and can exceed 100% (5 relics at 20%
 * is 67%, not "100%"). Overstating here would have people run five relics expecting a guaranteed
 * drop and come up empty a third of the time, so the honest number is the useful one.
 */
export function atLeastOneChance(trials: Array<{ chance: number; count: number }>): number {
  let missAll = 1;
  for (const { chance, count } of trials) {
    const p = clampChance(chance);
    const n = Math.max(0, Math.floor(count));
    if (n === 0 || p <= 0) {
      continue;
    }
    missAll *= Math.pow(1 - p, n);
  }
  return 1 - missAll;
}

/** Expected number of drops across all runs — the linear sum, useful alongside `atLeastOne`. */
export function expectedDropCount(trials: Array<{ chance: number; count: number }>): number {
  return trials.reduce(
    (sum, { chance, count }) => sum + clampChance(chance) * Math.max(0, Math.floor(count)),
    0,
  );
}

/** Smallest number of runs at `chance` to reach `target` probability of at least one drop. */
export function runsForTarget(chance: number, target = ODDS_TARGET): number | null {
  const p = clampChance(chance);
  if (p <= 0 || p >= 1) {
    return p >= 1 ? 1 : null;
  }
  return Math.ceil(Math.log(1 - target) / Math.log(1 - p));
}

/** The refinement with the highest chance for this drop. */
export function bestRefinementFor(chances: ChanceProfile): { key: RefinementKey; chance: number } | null {
  let best: { key: RefinementKey; chance: number } | null = null;
  for (const key of REFINEMENT_KEYS) {
    const chance = clampChance(chances[key]);
    if (chance > 0 && (!best || chance > best.chance)) {
      best = { key, chance };
    }
  }
  return best;
}

/**
 * Your real odds of getting a specific drop from the relics you currently hold, at the
 * refinements you actually hold them in.
 */
export function computeDropOdds(inputs: RelicOddsInput[]): DropOddsSummary {
  const relics: RelicOdds[] = [];
  const allTrials: Array<{ chance: number; count: number }> = [];

  for (const input of inputs) {
    const breakdown: RefinementOdds[] = [];
    const trials: Array<{ chance: number; count: number }> = [];

    for (const refinement of REFINEMENT_KEYS) {
      const count = Math.max(0, Math.floor(input.counts[refinement] ?? 0));
      const chance = clampChance(input.chances[refinement]);
      if (count <= 0) {
        continue;
      }
      trials.push({ chance, count });
      breakdown.push({
        refinement,
        count,
        chance,
        atLeastOne: atLeastOneChance([{ chance, count }]),
      });
    }

    if (trials.length === 0) {
      continue;
    }

    breakdown.sort((left, right) => right.chance - left.chance);
    const best = bestRefinementFor(input.chances);
    const totalCount = trials.reduce((sum, trial) => sum + trial.count, 0);

    relics.push({
      label: input.label,
      breakdown,
      totalCount,
      atLeastOne: atLeastOneChance(trials),
      bestRefinement: best?.key ?? null,
      bestChance: best?.chance ?? null,
      missingBest: best ? (input.counts[best.key] ?? 0) <= 0 : false,
    });
    allTrials.push(...trials);
  }

  relics.sort((left, right) => right.atLeastOne - left.atLeastOne);

  // For the "how many more runs" hint, use the best chance available across these relics.
  const bestOverall = relics.reduce<number>(
    (best, relic) => Math.max(best, relic.bestChance ?? 0),
    0,
  );

  return {
    relics,
    totalRelics: allTrials.reduce((sum, trial) => sum + trial.count, 0),
    atLeastOne: atLeastOneChance(allTrials),
    expectedDrops: expectedDropCount(allTrials),
    runsForTargetOdds: bestOverall > 0 ? runsForTarget(bestOverall, ODDS_TARGET) : null,
  };
}
