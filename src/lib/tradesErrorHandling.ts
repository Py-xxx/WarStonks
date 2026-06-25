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
      return 'Couldn’t load your Warframe Market orders right now. Please try again. If it keeps happening, report it in Discord.';
    case 'trade-overview-refresh':
      return 'Couldn’t refresh your orders right now. Showing the last loaded list if possible. If it keeps happening, report it in Discord.';
    case 'trade-action':
      return 'Couldn’t complete that order on Warframe.Market. Please try again. If it keeps happening, report it in Discord.';
    case 'trade-autocomplete-load':
      return 'Couldn’t load the item list right now. Please try again. If it keeps happening, report it in Discord.';
    case 'listing-analysis-load':
      return 'Couldn’t build the market analysis for this item right now. You can still post the listing.';
    default:
      return 'Something went wrong. Please try again. If it keeps happening, report it in Discord.';
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
