import { tActive, USER_MSG_MARK } from '../i18n/active.ts';
export type TradesErrorContext =
  | 'trade-overview-load'
  | 'trade-overview-refresh'
  | 'trade-action'
  | 'trade-autocomplete-load'
  | 'listing-analysis-load';

function toRawErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  // Avoid "[object Object]" from String(error) on a non-Error throw.
  if (typeof error === 'string') {
    return error.trim();
  }
  return '';
}

function tradesErrorFallback(context: TradesErrorContext): string {
  switch (context) {
    case 'trade-overview-load':
      return tActive('err.trd.loadOrders');
    case 'trade-overview-refresh':
      return tActive('err.trd.refreshOrders');
    case 'trade-action':
      return tActive('err.trd.completeOrder');
    case 'trade-autocomplete-load':
      return tActive('err.trd.loadItems');
    case 'listing-analysis-load':
      return tActive('err.trd.analysisStillPost');
    default:
      return tActive('err.generic');
  }
}

/**
 * Maps a Trades-tab failure to a user-facing message. Backend order/sign-in errors are already
 * friendly (see `friendly_order_error` / `friendly_sign_in_error` in trades.rs) and pass through
 * unchanged; raw/technical errors and non-Error throws fall back to clear context copy (never
 * "[object Object]").
 */
export function formatTradesErrorMessage(context: TradesErrorContext, error: unknown): string {
  const raw = toRawErrorMessage(error);

  if (raw.startsWith(USER_MSG_MARK)) {
    return raw.slice(USER_MSG_MARK.length);
  }
  if (!raw) {
    return tradesErrorFallback(context);
  }
  // Pass through messages that are already user-facing.
  if (
    raw.startsWith('Couldn’t ')
    || raw.startsWith('Your Warframe.Market session')
    || raw.startsWith('Warframe.Market ')
    || raw.startsWith('Per-trade ')
    || raw.includes('rate-limit')
    || raw.includes('session expired')
  ) {
    return raw;
  }
  return tradesErrorFallback(context);
}
