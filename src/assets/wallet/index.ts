import ayaIcon from './aya.webp';
import creditsIcon from './credits.webp';
import ducatsIcon from './ducats.webp';
import endoIcon from './endo.webp';
import platinumIcon from './platinum.webp';
import regalAyaIcon from './regalAya.webp';

export const walletIcons = {
  platinum: platinumIcon,
  credits: creditsIcon,
  endo: endoIcon,
  ducats: ducatsIcon,
  aya: ayaIcon,
  /** Not in the currency strip — Prime Resurgence is the only place Regal Aya is shown. */
  regalAya: regalAyaIcon,
} as const;
