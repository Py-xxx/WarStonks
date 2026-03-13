import type { TradeAccountSummary } from '../types';

export function formatTradeStatusLabel(
  status: TradeAccountSummary['status'] | string | null | undefined,
): string {
  switch ((status ?? '').toString().trim().toLowerCase()) {
    case 'ingame':
    case 'in_game':
      return 'Ingame';
    case 'online':
      return 'Online';
    default:
      return 'Invisible';
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
