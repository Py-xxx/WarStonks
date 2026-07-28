import { atLeastOneChance, type RefinementKey } from './relicDropOdds';
import type {
  FarmingSessionDrop,
  FarmingSessionRelic,
  OwnedRelicEntry,
  RelicRoiDropEntry,
  RelicRoiEntry,
} from '../types';

/** Placeholder slug for the synthetic "nothing I need" option when a relic lists no Forma. */
export const FILLER_DROP_SLUG = '__forma_filler__';

/** Forma is the universal "got nothing worth keeping" reward — logged for run-count accuracy but
 *  never added to the parts inventory. */
export function isFillerDropName(name: string): boolean {
  return name.trim().toLowerCase().includes('forma');
}

/** Splits a relic's display name ("Meso O2") into its tier and code. */
export function parseRelicTierCode(name: string): { tier: string; code: string } | null {
  const tokens = name.trim().split(/\s+/);
  const tier = tokens[0];
  const code = tokens[1];
  return tier && code ? { tier, code } : null;
}

const REFINEMENTS: RefinementKey[] = ['intact', 'exceptional', 'flawless', 'radiant'];

function chanceAt(drop: RelicRoiDropEntry, refinement: string): number | null {
  const raw = drop.chanceProfile?.[refinement as RefinementKey];
  // Scanner chances are percentages; sessions store 0..1.
  return typeof raw === 'number' && Number.isFinite(raw) ? raw / 100 : null;
}

/** Ensures a "nothing I need" choice exists even when the relic's table has no Forma entry. */
function withFiller(drops: FarmingSessionDrop[]): FarmingSessionDrop[] {
  if (drops.some((drop) => drop.isFiller)) {
    return drops;
  }
  return [
    ...drops,
    {
      itemId: null,
      slug: FILLER_DROP_SLUG,
      name: 'Forma Blueprint',
      imagePath: null,
      rarity: null,
      chance: null,
      recommendedExitPrice: null,
      isFiller: true,
    },
  ];
}

/**
 * Builds one cycle entry for a relic.
 *
 * `refinement` is chosen for the *goal*: when hunting a specific item it's the refinement giving
 * that item the best chance, otherwise the caller's recommended one. `targetOdds` is the real
 * chance of pulling the target across every copy owned — that's what ranks the cycle, so a single
 * Radiant can correctly outrank eight Intacts.
 */
export function buildFarmingRelic(
  relic: RelicRoiEntry,
  owned: OwnedRelicEntry | undefined,
  tier: string,
  code: string,
  options: { targetDropSlug?: string | null; fallbackRefinement?: string } = {},
): FarmingSessionRelic {
  const targetDrop = options.targetDropSlug
    ? relic.drops.find((drop) => drop.slug === options.targetDropSlug)
    : undefined;

  const counts = owned?.counts;
  const heldAt = (key: RefinementKey) => (counts?.[key] as number | undefined) ?? 0;
  const scoreAt = (key: RefinementKey) =>
    targetDrop ? chanceAt(targetDrop, key) ?? 0 : REFINEMENTS.indexOf(key);

  // What we'd advise: the refinement giving the best shot at the goal, owned or not.
  let recommendedRefinement: RefinementKey = REFINEMENTS[0];
  let bestScore = -1;
  for (const candidate of REFINEMENTS) {
    const score = scoreAt(candidate);
    if (score > bestScore) {
      bestScore = score;
      recommendedRefinement = candidate;
    }
  }

  // What you'll actually run: the best refinement you hold copies of. Falls back to the
  // recommendation (or the caller's hint) when we can't tell what's owned — showing chances for
  // a refinement you don't have would quietly overstate your odds.
  let refinement: string = options.fallbackRefinement ?? recommendedRefinement;
  let ownedScore = -1;
  for (const candidate of REFINEMENTS) {
    if (heldAt(candidate) <= 0) {
      continue;
    }
    const score = scoreAt(candidate);
    if (score > ownedScore) {
      ownedScore = score;
      refinement = candidate;
    }
  }

  const drops = withFiller(
    relic.drops.map((drop) => ({
      itemId: drop.itemId,
      slug: drop.slug,
      name: drop.name,
      imagePath: drop.imagePath,
      rarity: drop.rarity,
      chance: chanceAt(drop, refinement),
      recommendedExitPrice: drop.recommendedExitPrice,
      isFiller: isFillerDropName(drop.name),
    })),
  );

  const ownedCount = counts?.total ?? 0;
  const targetChance = targetDrop ? chanceAt(targetDrop, refinement) : null;

  // Real odds across everything held, at the refinements actually held.
  const targetOdds = targetDrop
    ? atLeastOneChance(
        REFINEMENTS.map((key) => ({
          chance: chanceAt(targetDrop, key) ?? 0,
          count: (counts?.[key] as number | undefined) ?? 0,
        })),
      )
    : null;

  return {
    relicSlug: relic.slug,
    relicName: relic.name,
    relicImagePath: relic.imagePath,
    tier,
    code,
    refinement,
    recommendedRefinement,
    refinementOwnedCount: heldAt(refinement as RefinementKey),
    drops,
    ownedCount,
    targetChance,
    targetOdds,
  };
}

/** Orders candidates by real odds of pulling the target, best first. */
export function rankByTargetOdds(relics: FarmingSessionRelic[]): FarmingSessionRelic[] {
  return [...relics].sort((left, right) => {
    const delta = (right.targetOdds ?? 0) - (left.targetOdds ?? 0);
    if (Math.abs(delta) > 1e-9) {
      return delta;
    }
    // Tie-break on copies held, then chance per run.
    if (right.ownedCount !== left.ownedCount) {
      return right.ownedCount - left.ownedCount;
    }
    return (right.targetChance ?? 0) - (left.targetChance ?? 0);
  });
}
