import { tActive, USER_MSG_MARK } from '../i18n/active.ts';
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
      return tActive('err.mkt.loadVariants');
    case 'market-analysis-load':
      return tActive('err.mkt.buildAnalysis');
    case 'market-analysis-refresh':
      return tActive('err.mkt.refreshAnalysis');
    case 'market-analytics-load':
      return tActive('err.mkt.loadAnalytics');
    case 'market-analytics-refresh':
      return tActive('err.mkt.refreshAnalytics');
    case 'market-item-details-load':
      return tActive('err.mkt.itemDetails');
    default:
      return tActive('err.generic');
  }
}

export function formatMarketErrorMessage(context: MarketErrorContext, error: unknown): string {
  const raw = toRawErrorMessage(error);

  if (raw.startsWith(USER_MSG_MARK)) {
    return raw.slice(USER_MSG_MARK.length);
  }

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
