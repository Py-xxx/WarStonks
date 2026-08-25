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

/** Presence as a `Badge` tone. Separate from `getTradeStatusToneClass`, which returns the bare
 *  `.trade-status-*` colour classes the TopBar still uses for text and its presence dot. */
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
      return 'trade-status-ingame';
    case 'online':
      return 'trade-status-online';
    default:
      return 'trade-status-offline';
  }
}

export function formatPlatinumValue(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }

  return `${new Intl.NumberFormat().format(value)}p`;
}
