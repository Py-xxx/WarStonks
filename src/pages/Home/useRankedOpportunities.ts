import { useMemo } from 'react';

import { buildOpportunityQueue } from '../../lib/opportunitySnipes';
import type { Opportunity } from '../../lib/tauriClient';
import { useAppStore } from '../../stores/useAppStore';

export type OpportunityStatus = 'loading' | 'empty' | 'ready';

/**
 * The Act now queue, and the status that drives its loading state.
 *
 * Extracted because the stat strip and the queue itself both need the exact same list: when the
 * strip filtered `opportunities` directly and the queue filtered dismissals separately, the
 * header could count a play the list below had already dropped.
 *
 * `loadedAt === null` means the board has never been computed on this launch — that is the only
 * true loading state. A refresh of an already-populated board must NOT skeleton over data the
 * user is reading.
 *
 * The queue itself comes from `lib/opportunitySnipes`, shared with the Opportunities board, so
 * live snipes — the plays that expire in five minutes — reach the surface that exists to show you
 * what to act on right now. This hook used to read `opportunities` alone and never showed one.
 */
export function useRankedOpportunities(): {
  ranked: Opportunity[];
  status: OpportunityStatus;
  stalestPricedAt: string | null;
} {
  const opportunities = useAppStore((s) => s.opportunities);
  const listings = useAppStore((s) => s.underpricedListings);
  const loadedAt = useAppStore((s) => s.opportunitiesLoadedAt);
  const dismissed = useAppStore((s) => s.dismissedOpportunityKeys);

  const ranked = useMemo(
    () => buildOpportunityQueue(opportunities, listings, dismissed),
    [opportunities, listings, dismissed],
  );

  // One provenance stamp for the panel, from the least recently priced row. Per-row stamps
  // repeated nearly the same value on every line; the stalest is the one worth knowing.
  const stalestPricedAt = useMemo(() => {
    let oldest: string | null = null;
    for (const opportunity of ranked) {
      if (opportunity.pricedAt && (!oldest || opportunity.pricedAt < oldest)) {
        oldest = opportunity.pricedAt;
      }
    }
    return oldest;
  }, [ranked]);

  // A live snipe is real content even before the board has ever been computed, so having rows
  // beats "never loaded" — skeletoning over plays the user can already act on would be a lie.
  const status: OpportunityStatus =
    ranked.length > 0 ? 'ready' : loadedAt === null ? 'loading' : 'empty';

  return { ranked, status, stalestPricedAt };
}
