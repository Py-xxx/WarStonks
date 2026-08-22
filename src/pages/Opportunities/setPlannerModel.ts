import type { ArbitrageScannerComponentEntry, ArbitrageScannerSetEntry } from '../../types';

/**
 * Shapes shared by the Set Completion Planner — the page computes them, `SetPlanner.tsx` renders
 * them. Same split as `farmNowModel.ts`, for the same reason: the derivation joins the arbitrage
 * scan with the owned-parts inventory, both of which live in `index.tsx`'s state, while the
 * rendering has no business sharing a file with five other tabs.
 */

export type PlannerComponentState = {
  component: ArbitrageScannerComponentEntry;
  ownedQuantity: number;
  coveredQuantity: number;
  missingQuantity: number;
  isOwned: boolean;
};

export type PlannerSetEntry = {
  entry: ArbitrageScannerSetEntry;
  /** Distinct components fully owned / total distinct components. */
  ownedComponentCount: number;
  totalComponentCount: number;
  /** Quantity-weighted: total individual parts needed (Σ quantityInSet) and how many are owned.
   *  A set needing 2× of two of its three parts totals 5 parts, not 3. */
  totalPartsNeeded: number;
  ownedPartsCount: number;
  remainingInvestment: number | null;
  completionProfit: number | null;
  completionRoiPct: number | null;
  /** Fraction of individual parts owned by quantity (0..1). */
  partCountRatio: number;
  /** Fraction of the set's total part value that the owned parts represent (0..1). */
  ownedValueRatio: number;
  components: PlannerComponentState[];
};

export type PlannerOwnedRelicHint = {
  key: string;
  label: string;
  fullName: string;
  totalCount: number;
};
/** A set counts as "meaningfully underway" for the summary line when it's at least half owned by
 *  part count, OR the parts already owned are worth at least half the set's total part value (so
 *  owning one expensive part of a cheap-remainder set still qualifies). */
export const PLANNER_SUMMARY_THRESHOLD = 0.5;

/** Everything that can stand between the user and a list of sets, resolved to one value — the
 *  `FarmNowGate` pattern, which exists because these states route to different places. */
export type SetPlannerGate =
  | { kind: 'loading' }
  | { kind: 'noScan' }
  | { kind: 'noOwnedParts' }
  | { kind: 'ready' };
