export type MarketErrorContext =
  | 'market-variant-load'
  | 'market-analysis-load'
  | 'market-analysis-refresh'
  | 'market-analytics-load'
  | 'market-analytics-refresh'
  | 'market-item-details-load';

function toRawErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error ?? '').trim();
}

function friendlyMarketErrorFallback(context: MarketErrorContext): string {
  switch (context) {
    case 'market-variant-load':
      return 'Couldn’t load market variants right now. Please try again. If it keeps happening, report it in Discord.';
    case 'market-analysis-load':
      return 'Couldn’t build the market analysis right now. Please try again. If it keeps happening, report it in Discord.';
    case 'market-analysis-refresh':
      return 'Couldn’t refresh the market analysis right now. Showing the last available analysis if possible. If it keeps happening, report it in Discord.';
    case 'market-analytics-load':
      return 'Couldn’t load market analytics right now. Please try again. If it keeps happening, report it in Discord.';
    case 'market-analytics-refresh':
      return 'Couldn’t refresh market analytics right now. Showing the last available snapshot if possible. If it keeps happening, report it in Discord.';
    case 'market-item-details-load':
      return 'Couldn’t load item details right now. Showing the best available item info if possible. If it keeps happening, report it in Discord.';
    default:
      return 'Something went wrong. Please try again. If it keeps happening, report it in Discord.';
  }
}

export function formatMarketErrorMessage(context: MarketErrorContext, error: unknown): string {
  const raw = toRawErrorMessage(error);

  if (!raw) {
    return friendlyMarketErrorFallback(context);
  }

  if (
    raw.startsWith('Couldn’t ')
    || raw.startsWith('Use the global search ')
    || raw.startsWith('Pick the correct rank ')
    || raw.startsWith('This item has separate rank markets.')
  ) {
    return raw;
  }

  return friendlyMarketErrorFallback(context);
}
