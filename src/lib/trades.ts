import { tActive } from '../i18n';
import type { TradeAccountSummary } from '../types';

export function formatTradeStatusLabel(
  status: TradeAccountSummary['status'] | string | null | undefined,
): string {
  switch ((status ?? '').toString().trim().toLowerCase()) {
    case 'ingame':
    case 'in_game':
      return tActive('home.seller.ingame');
    case 'online':
      return tActive('status.online');
    default:
      return tActive('status.invisible');
  }
}

/** Presence as a `Badge` tone. Separate from `getTradeStatusToneClass`, which returns a text
 *  colour for the TopBar's presence label and its dot (the dot pairs it with `bg-current`). */
export function tradeStatusTone(
  status: TradeAccountSummary['status'] | string | null | undefined,
): 'green' | 'purple' | 'neutral' {
  switch ((status ?? '').toString().trim().toLowerCase()) {
    case 'ingame':
    case 'in_game':
      return 'purple';
    case 'online':
      return 'green';
    default:
      return 'neutral';
  }
}

export function getTradeStatusToneClass(
  status: TradeAccountSummary['status'] | string | null | undefined,
): string {
  switch ((status ?? '').toString().trim().toLowerCase()) {
    case 'ingame':
    case 'in_game':
      return 'text-accent-purple';
    case 'online':
      return 'text-accent-green';
    default:
      return 'text-ink-dim';
  }
}

export function formatPlatinumValue(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }

  return `${new Intl.NumberFormat().format(value)}p`;
}
