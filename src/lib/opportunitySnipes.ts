import type { Opportunity, UnderpricedListing } from './tauriClient';

/**
 * Live snipes, expressed as `Opportunity` objects.
 *
 * The underpriced radar streams sell listings priced well below their recommended entry. When one
 * of them completes a set the user already owns parts of, it is not just a cheap listing — it is
 * the single most actionable play on screen, and it disappears within five minutes.
 *
 * This lived inside `components/OpportunityBoard`, which meant Home's "Act now" queue — the
 * surface whose entire job is "what do I act on right now" — never saw a snipe at all. Act now is
 * a VIEW of the board (see `opportunityView.ts` for the same lesson about colour), so the list
 * itself has to have one home too, not just its presentation.
 */

/** The listing shape this module needs. Structural, so callers can pass the store's card type. */
export type SnipeSource = Pick<
  UnderpricedListing,
  | 'orderId'
  | 'slug'
  | 'itemName'
  | 'username'
  | 'listedPrice'
  | 'recommendedPrice'
  | 'pctBelow'
  | 'tier'
  | 'completesSet'
> & { status?: string };

/**
 * Snipes are pinned above every computed play by a score offset rather than by a separate list.
 *
 * A separate list would let the two surfaces order them differently, which is the bug this module
 * exists to prevent. One comparable score means any surface that sorts by `score` agrees for free.
 */
export const SNIPE_SCORE_FLOOR = 100_000;

/** Tier → confidence. Red is the radar's strongest signal, so it earns the highest confidence. */
function confidenceForTier(tier: SnipeSource['tier']): number {
  if (tier === 'red') return 0.85;
  if (tier === 'yellow') return 0.7;
  return 0.6;
}

export function confidenceLabelFor(confidence: number): string {
  return confidence >= 0.75 ? 'High' : confidence >= 0.45 ? 'Medium' : 'Low';
}

/**
 * Turn a live underpriced listing into a board opportunity: urgent, pinnable, and actionable
 * (copy the buy whisper to that exact seller).
 *
 * `estValue` is **savings**, not profit — what you avoid paying versus the recommended entry.
 * `valueBasis: 'savings'` is what stops the queue comparing it against a profit figure as if the
 * two were the same quantity.
 */
export function snipeToOpportunity(card: SnipeSource): Opportunity {
  const completes = card.completesSet;
  const savings = Math.max(0, Math.round(card.recommendedPrice - card.listedPrice));
  const confidence = confidenceForTier(card.tier);
  return {
    id: `snipe:${card.orderId}`,
    subjectKey: `snipe:${card.orderId}`,
    category: 'snipe',
    titleKey: 'opp.snipeTitle',
    titleParams: { name: card.itemName },
    subtitleKey: completes ? 'opp.completesYour' : 'opp.underpricedNeed',
    subtitleParams: completes
      ? {
          set: completes.setName,
          owned: String(completes.ownedDistinct),
          needed: String(completes.neededDistinct),
        }
      : {},
    setSlug: completes?.setSlug ?? null,
    imagePath: null,
    estValue: savings,
    cost: Math.round(card.listedPrice),
    valueBasis: 'savings',
    pricedAt: null,
    confidence,
    confidenceLabel: confidenceLabelFor(confidence),
    urgency: 'expiring',
    reasons: [
      {
        icon: 'inventory',
        textKey: completes ? 'opp.youOwnPartsOf' : 'opp.partYouNeed',
        textParams: completes
          ? {
              owned: String(completes.ownedDistinct),
              needed: String(completes.neededDistinct),
              set: completes.setName,
            }
          : {},
        source: 'inventory',
      },
      {
        icon: 'market',
        textKey: 'opp.listedAt',
        textParams: {
          user: card.username,
          price: String(Math.round(card.listedPrice)),
          pct: String(Math.round(card.pctBelow)),
          rec: String(Math.round(card.recommendedPrice)),
        },
        source: 'market',
      },
    ],
    actions: [
      {
        kind: 'copyWhisper',
        labelKey: 'opp.buyFrom',
        labelParams: { user: card.username },
        itemSlug: card.slug,
        itemName: card.itemName,
        price: Math.round(card.listedPrice),
        username: card.username,
      },
    ],
    score: savings * confidence + SNIPE_SCORE_FLOOR,
  };
}

/**
 * Which listings become opportunities: those that complete a set the user owns parts of, and are
 * still buyable.
 *
 * A listing whose seller pulled or repriced it (`gone` / `overpriced`) is no longer a play — the
 * radar keeps showing it so the user understands what happened to a card they were reading, but
 * the queue must not rank a dead listing above live work.
 */
export function isActionableSnipe(card: SnipeSource): boolean {
  return Boolean(card.completesSet) && card.status !== 'gone' && card.status !== 'overpriced';
}

/**
 * The one ranked list every opportunity surface renders: live snipes merged with computed plays,
 * minus anything dismissed, sorted by score.
 *
 * Dismissal is applied here rather than by each caller so a play dropped on one surface cannot
 * survive on another.
 */
export function buildOpportunityQueue(
  opportunities: Opportunity[],
  listings: SnipeSource[],
  dismissedKeys: ReadonlySet<string>,
): Opportunity[] {
  const snipes = listings.filter(isActionableSnipe).map(snipeToOpportunity);
  return [...snipes, ...opportunities]
    .filter((opportunity) => !dismissedKeys.has(opportunity.subjectKey))
    .sort((a, b) => b.score - a.score);
}
