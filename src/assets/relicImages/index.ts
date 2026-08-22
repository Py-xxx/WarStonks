// Relic icons, keyed by era.
//
// Warframe.Market serves relic art per item, which means four near-identical pictures per relic
// (one per refinement) and inconsistent art between surfaces depending on which backend table the
// image path came from. Era is the only thing that distinguishes relics visually anyway — a Lith
// is a Lith whether it is Intact or Radiant — so these replace WFM's art everywhere.
//
// Supplied by the project owner in `Resources/assets/relics`. Keep the two in step when adding art.

import axiIcon from './axi.webp';
import lithIcon from './lith.webp';
import mesoIcon from './meso.webp';
import neoIcon from './neo.webp';
import requiemIcon from './requiem.webp';
import vanguardIcon from './vanguard.webp';

export const relicIcons: Record<string, string> = {
  axi: axiIcon,
  lith: lithIcon,
  meso: mesoIcon,
  neo: neoIcon,
  requiem: requiemIcon,
  vanguard: vanguardIcon,
};
