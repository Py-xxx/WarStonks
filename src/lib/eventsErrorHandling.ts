import { tActive, USER_MSG_MARK } from '../i18n/active.ts';
import { formatShortLocalDateTime } from './dateTime.ts';

export type EventsErrorContext =
  | 'events-active-events'
  | 'events-alerts'
  | 'events-sortie'
  | 'events-arbitration'
  | 'events-archon-hunt'
  | 'events-fissures'
  | 'events-market-news'
  | 'events-invasions'
  | 'events-syndicate-missions'
  | 'events-void-trader';

function toRawErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error ?? '').trim();
}

function getEventsSubject(context: EventsErrorContext): string {
  switch (context) {
    case 'events-active-events':
      return tActive('err.ev.sub.events');
    case 'events-alerts':
      return tActive('err.ev.sub.alerts');
    case 'events-sortie':
      return tActive('err.ev.sub.sortie');
    case 'events-arbitration':
      return tActive('err.ev.sub.arbitration');
    case 'events-archon-hunt':
      return tActive('err.ev.sub.archon');
    case 'events-fissures':
      return tActive('err.ev.sub.fissures');
    case 'events-market-news':
      return tActive('err.ev.sub.marketNews');
    case 'events-invasions':
      return tActive('err.ev.sub.invasions');
    case 'events-syndicate-missions':
      return tActive('err.ev.sub.syndicate');
    case 'events-void-trader':
      return tActive('err.ev.sub.voidTrader');
    default:
      return tActive('err.ev.sub.default');
  }
}

function buildInitialEventsMessage(context: EventsErrorContext): string {
  return tActive('err.ev.load', { subject: getEventsSubject(context) });
}

function buildDegradedEventsMessage(context: EventsErrorContext, lastAvailableAt: string | null): string {
  const formattedTimestamp = lastAvailableAt ? formatShortLocalDateTime(lastAvailableAt) : null;

  return formattedTimestamp
    ? tActive('err.ev.refreshAt', { subject: getEventsSubject(context), time: formattedTimestamp })
    : tActive('err.ev.refresh', { subject: getEventsSubject(context) });
}

export function formatEventsErrorMessage(
  context: EventsErrorContext,
  error: unknown,
  options?: { lastAvailableAt?: string | null },
): string {
  const raw = toRawErrorMessage(error);

  if (raw.startsWith(USER_MSG_MARK)) {
    return raw.slice(USER_MSG_MARK.length);
  }
  const lastAvailableAt = options?.lastAvailableAt ?? null;

  if (!raw) {
    return lastAvailableAt
      ? buildDegradedEventsMessage(context, lastAvailableAt)
      : buildInitialEventsMessage(context);
  }

  if (raw.startsWith('Couldn’t ')) {
    return raw;
  }

  return lastAvailableAt
    ? buildDegradedEventsMessage(context, lastAvailableAt)
    : buildInitialEventsMessage(context);
}
