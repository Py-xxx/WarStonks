/**
 * Presentation rules shared by every surface that renders an `Opportunity`.
 *
 * These lived only inside `components/OpportunityBoard` (as CSS classes) and were then
 * re-derived by hand for Home's "Act now" queue — which got them wrong: `sellInventory` was
 * tinted blue there and amber on the board, while `flip` (blue on the board) fell through to
 * green. The same play was a different colour depending on which screen you were looking at.
 *
 * Home is a VIEW of the board, so the mapping has to have exactly one home. Anything new that
 * renders an `Opportunity` reads it from here.
 */

export type OpportunityTone = 'red' | 'green' | 'amber' | 'purple' | 'blue';

/**
 * Category → tone, matching `.opp-card-*` in `legacy.css` exactly.
 *
 * `setCompletion` is the unsuffixed `.opp-card` default (purple), so anything unrecognised
 * lands there too — the same fallback the board has.
 */
const CATEGORY_TONE: Record<string, OpportunityTone> = {
  setCompletion: 'purple',
  sellInventory: 'amber',
  flip: 'blue',
  snipe: 'amber',
  reprice: 'red',
};

export function opportunityTone(category: string): OpportunityTone {
  return CATEGORY_TONE[category] ?? 'purple';
}

/**
 * The label under the value on the shipped board — `PROFIT`, `SAVINGS`, `TO SELL`.
 *
 * This is not decoration: platinum you save and platinum you would earn are different
 * quantities, and the queue ranks them against each other. A bare `+53p` with no basis invites
 * the user to compare two numbers that are not comparable.
 */
const VALUE_BASIS_KEY: Record<string, string> = {
  profit: 'opp.basisProfit',
  liquidation: 'opp.basisToSell',
  savings: 'opp.basisSavings',
  unlock: 'opp.basisUnlock',
};

/**
 * `profit` and `liquidation` reuse the board's existing keys. The board falls back to printing
 * the raw `basis` string for `savings` and `unlock` — which is why the shipped screenshot reads
 * `SAVINGS`, uppercased by CSS rather than translated. Those two now have real keys; the board
 * can adopt them when Opportunities is migrated.
 */
export function valueBasisKey(basis: string): string {
  return VALUE_BASIS_KEY[basis] ?? 'opp.basisProfit';
}

/**
 * Platinum written the way the shipped board writes it: a leading sign and a bare `p`.
 *
 * Deliberately NOT `formatPlatinumValue` from `lib/trades.ts` — that one groups thousands
 * (`1,240p`), which is right for a P&L total and wrong for a column of two- and three-digit
 * values that has to stay narrow. Both exist on purpose; this is the one for opportunity and
 * fill rows, and it is the only place the sign is decided.
 */
export function formatPlatinumDelta(value: number): string {
  if (!Number.isFinite(value)) {
    return '—';
  }
  return `${value >= 0 ? '+' : '−'}${Math.abs(value)}p`;
}

/**
 * Confidence → tone, matching `.opp-conf-*` in `legacy.css` exactly.
 *
 * The board has always coloured its confidence label; Home printed the same word in `ink-faint`
 * regardless, so a LOW-confidence play and a HIGH-confidence one looked identical on the surface
 * you scan fastest. Confidence is the one fact that decides whether a number is safe to act on,
 * which makes it exactly the wrong thing to render flat.
 *
 * `low` is deliberately muted rather than red: red is `reprice`'s colour on the board, and a
 * low-confidence play is uncertain, not a loss.
 */
export type ConfidenceTone = 'green' | 'amber' | 'muted';

const CONFIDENCE_TONE: Record<string, ConfidenceTone> = {
  high: 'green',
  medium: 'amber',
  low: 'muted',
};

export function confidenceTone(label: string): ConfidenceTone {
  return CONFIDENCE_TONE[label.toLowerCase()] ?? 'muted';
}
