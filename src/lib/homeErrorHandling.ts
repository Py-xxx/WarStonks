import { tActive, USER_MSG_MARK } from '../i18n/active.ts';
export type HomeErrorContext =
  | 'dashboard-quick-view-load'
  | 'dashboard-quick-view-copy'
  | 'dashboard-analysis-load'
  | 'watchlist-add'
  | 'watchlist-buy-sync'
  | 'watchlist-copy'
  | 'watchlist-mark-bought'
  | 'watchlist-refresh'
  | 'alerts-copy'
  | 'alerts-mark-bought';

function toRawErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error ?? '').trim();
}

function friendlyHomeErrorFallback(context: HomeErrorContext): string {
  switch (context) {
    case 'dashboard-quick-view-load':
      return tActive('err.home.loadQv');
    case 'dashboard-quick-view-copy':
      return tActive('err.home.copyWhisper');
    case 'dashboard-analysis-load':
      return tActive('err.home.buildPreview');
    case 'watchlist-add':
      return tActive('err.home.addWatchlist');
    case 'watchlist-buy-sync':
      return tActive('err.home.buySync');
    case 'watchlist-copy':
      return tActive('err.home.copyWhisper');
    case 'watchlist-mark-bought':
      return tActive('err.home.markBought');
    case 'watchlist-refresh':
      return tActive('err.home.refreshItem');
    case 'alerts-copy':
      return tActive('err.home.copyWhisper');
    case 'alerts-mark-bought':
      return tActive('err.home.markBought');
    default:
      return tActive('err.generic');
  }
}

export function formatHomeErrorMessage(context: HomeErrorContext, error: unknown): string {
  const raw = toRawErrorMessage(error);

  if (raw.startsWith(USER_MSG_MARK)) {
    return raw.slice(USER_MSG_MARK.length);
  }

  if (!raw) {
    return friendlyHomeErrorFallback(context);
  }

  if (
    raw.startsWith('Couldn’t ')
    || raw.startsWith('Added to the watchlist, but ')
    || raw.startsWith('Search and load ')
    || raw.startsWith('Select a rank ')
    || raw.startsWith('Enter a desired price ')
    || raw.startsWith('Bought price must be ')
    || raw.startsWith('That watchlist item could not be found.')
  ) {
    return raw;
  }
  return friendlyHomeErrorFallback(context);
}
