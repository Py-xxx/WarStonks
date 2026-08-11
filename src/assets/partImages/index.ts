// Component icons, keyed by the part name exactly as the file is named.
//
// WFM serves every component of a set the *parent item's* art, so a Neuroptics, a Chassis and
// a Systems all render as the same warframe picture. These replace that with the real part
// icon. Keys are `{part}` and `{part}_prime`; the prime variant is used only for items whose
// name contains "Prime".
//
// Generated from the files in this directory — keep the two in step when adding art.

import avionicsIcon from './avionics.webp';
import bandIcon from './band.webp';
import bandPrimeIcon from './band_prime.webp';
import barrelIcon from './barrel.webp';
import barrelPrimeIcon from './barrel_prime.webp';
import bladeIcon from './blade.webp';
import bladePrimeIcon from './blade_prime.webp';
import buckleIcon from './buckle.webp';
import bucklePrimeIcon from './buckle_prime.webp';
import carapaceIcon from './carapace.webp';
import carapacePrimeIcon from './carapace_prime.webp';
import cerebrumIcon from './cerebrum.webp';
import cerebrumPrimeIcon from './cerebrum_prime.webp';
import chassisIcon from './chassis.webp';
import chassisPrimeIcon from './chassis_prime.webp';
import collarIcon from './collar.webp';
import collarPrimeIcon from './collar_prime.webp';
import diskIcon from './disk.webp';
import diskPrimeIcon from './disk_prime.webp';
import enginesIcon from './engines.webp';
import fuselageIcon from './fuselage.webp';
import gauntletIcon from './gauntlet.webp';
import gauntletPrimeIcon from './gauntlet_prime.png';
import gripIcon from './grip.webp';
import guardIcon from './guard.webp';
import guardPrimeIcon from './guard_prime.webp';
import handleIcon from './handle.webp';
import handlePrimeIcon from './handle_prime.png';
import harnessIcon from './harness.webp';
import harnessPrimeIcon from './harness_prime.webp';
import headIcon from './head.webp';
import headPrimeIcon from './head_prime.webp';
import hiltIcon from './hilt.webp';
import hiltPrimeIcon from './hilt_prime.webp';
import hookIcon from './hook.webp';
import linkIcon from './link.webp';
import linkPrimeIcon from './link_prime.webp';
import lowerLimbIcon from './lower_limb.webp';
import lowerLimbPrimeIcon from './lower_limb_prime.webp';
import neuropticsIcon from './neuroptics.webp';
import neuropticsPrimeIcon from './neuroptics_prime.webp';
import ornamentIcon from './ornament.webp';
import ornamentPrimeIcon from './ornament_prime.webp';
import pouchIcon from './pouch.webp';
import pouchPrimeIcon from './pouch_prime.webp';
import receiverIcon from './receiver.webp';
import receiverPrimeIcon from './receiver_prime.webp';
import starsIcon from './stars.webp';
import starsPrimeIcon from './stars_prime.webp';
import stockIcon from './stock.webp';
import stockPrimeIcon from './stock_prime.webp';
import stringIcon from './string.webp';
import stringPrimeIcon from './string_prime.webp';
import systemsIcon from './systems.webp';
import systemsPrimeIcon from './systems_prime.webp';
import upperLimbIcon from './upper_limb.webp';
import upperLimbPrimeIcon from './upper_limb_prime.webp';
import wingsIcon from './wings.webp';
import wingsPrimeIcon from './wings_prime.webp';

export const partIcons: Record<string, string> = {
  'avionics': avionicsIcon,
  'band': bandIcon,
  'band_prime': bandPrimeIcon,
  'barrel': barrelIcon,
  'barrel_prime': barrelPrimeIcon,
  'blade': bladeIcon,
  'blade_prime': bladePrimeIcon,
  'buckle': buckleIcon,
  'buckle_prime': bucklePrimeIcon,
  'carapace': carapaceIcon,
  'carapace_prime': carapacePrimeIcon,
  'cerebrum': cerebrumIcon,
  'cerebrum_prime': cerebrumPrimeIcon,
  'chassis': chassisIcon,
  'chassis_prime': chassisPrimeIcon,
  'collar': collarIcon,
  'collar_prime': collarPrimeIcon,
  'disk': diskIcon,
  'disk_prime': diskPrimeIcon,
  'engines': enginesIcon,
  'fuselage': fuselageIcon,
  'gauntlet': gauntletIcon,
  'gauntlet_prime': gauntletPrimeIcon,
  'grip': gripIcon,
  'guard': guardIcon,
  'guard_prime': guardPrimeIcon,
  'handle': handleIcon,
  'handle_prime': handlePrimeIcon,
  'harness': harnessIcon,
  'harness_prime': harnessPrimeIcon,
  'head': headIcon,
  'head_prime': headPrimeIcon,
  'hilt': hiltIcon,
  'hilt_prime': hiltPrimeIcon,
  'hook': hookIcon,
  'link': linkIcon,
  'link_prime': linkPrimeIcon,
  'lower_limb': lowerLimbIcon,
  'lower_limb_prime': lowerLimbPrimeIcon,
  'neuroptics': neuropticsIcon,
  'neuroptics_prime': neuropticsPrimeIcon,
  'ornament': ornamentIcon,
  'ornament_prime': ornamentPrimeIcon,
  'pouch': pouchIcon,
  'pouch_prime': pouchPrimeIcon,
  'receiver': receiverIcon,
  'receiver_prime': receiverPrimeIcon,
  'stars': starsIcon,
  'stars_prime': starsPrimeIcon,
  'stock': stockIcon,
  'stock_prime': stockPrimeIcon,
  'string': stringIcon,
  'string_prime': stringPrimeIcon,
  'systems': systemsIcon,
  'systems_prime': systemsPrimeIcon,
  'upper_limb': upperLimbIcon,
  'upper_limb_prime': upperLimbPrimeIcon,
  'wings': wingsIcon,
  'wings_prime': wingsPrimeIcon,
};
