import { OpportunityBoard } from '../../components/OpportunityBoard';
import { UnderpricedListingsPanel } from '../../components/UnderpricedListingsPanel';

/**
 * Opportunities → Overview: the computed board, and the live radar beside it.
 *
 * Two flex columns rather than a grid. Grid rows are as tall as their tallest cell, and these two
 * panels differ in height by whatever the market is doing — a grid would pad the shorter one with
 * dead space and pin the taller one's scroll to it. Columns pack independently.
 *
 * The layout lives here rather than inside either panel, so neither one has an opinion about what
 * sits next to it.
 */
export function OpportunitiesOverview() {
  return (
    <div className="flex items-start gap-4 p-4 max-[1100px]:flex-col">
      <div className="min-w-0 flex-1 max-[1100px]:w-full">
        <OpportunityBoard />
      </div>
      <div className="w-80 shrink-0 max-[1100px]:w-full">
        <UnderpricedListingsPanel />
      </div>
    </div>
  );
}
