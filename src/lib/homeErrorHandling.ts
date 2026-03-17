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
      return 'Couldn’t load quick view right now. Please try another search or retry in a moment. If it keeps happening, report it in Discord. Reference: HOME-QUICKVIEW-LOAD-01';
    case 'dashboard-quick-view-copy':
      return 'Couldn’t copy the whisper message right now. Please try again. If it keeps happening, report it in Discord. Reference: HOME-QUICKVIEW-COPY-01';
    case 'dashboard-analysis-load':
      return 'Couldn’t build the analysis preview right now. Please try again. If it keeps happening, report it in Discord. Reference: HOME-ANALYSIS-LOAD-01';
    case 'watchlist-add':
      return 'Couldn’t add this item to the watchlist right now. Please try again. If it keeps happening, report it in Discord. Reference: WATCHLIST-ADD-01';
    case 'watchlist-buy-sync':
      return 'Added to the watchlist, but the linked buy order could not be synced right now. If it keeps happening, report it in Discord. Reference: WATCHLIST-BUY-SYNC-01';
    case 'watchlist-copy':
      return 'Couldn’t copy the whisper message right now. Please try again. If it keeps happening, report it in Discord. Reference: WATCHLIST-COPY-01';
    case 'watchlist-mark-bought':
      return 'Couldn’t mark this item as bought right now. Please try again. If it keeps happening, report it in Discord. Reference: WATCHLIST-MARK-BOUGHT-01';
    case 'watchlist-refresh':
      return 'Couldn’t refresh this watchlist item right now. WarStonks will try again automatically. If it keeps happening, report it in Discord. Reference: WATCHLIST-REFRESH-01';
    case 'alerts-copy':
      return 'Couldn’t copy the whisper message right now. Please try again. If it keeps happening, report it in Discord. Reference: ALERTS-COPY-01';
    case 'alerts-mark-bought':
      return 'Couldn’t mark this alert item as bought right now. Please try again. If it keeps happening, report it in Discord. Reference: ALERTS-MARK-BOUGHT-01';
    default:
      return 'Something went wrong. Please try again. If it keeps happening, report it in Discord.';
  }
}

export function formatHomeErrorMessage(context: HomeErrorContext, error: unknown): string {
  const raw = toRawErrorMessage(error);

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

  if (raw.includes('Reference:')) {
    return raw;
  }

  return friendlyHomeErrorFallback(context);
}
