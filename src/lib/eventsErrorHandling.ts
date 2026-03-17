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
      return 'active events';
    case 'events-alerts':
      return 'alerts';
    case 'events-sortie':
      return 'sortie data';
    case 'events-arbitration':
      return 'arbitration data';
    case 'events-archon-hunt':
      return 'Archon Hunt data';
    case 'events-fissures':
      return 'fissures';
    case 'events-market-news':
      return 'market and news data';
    case 'events-invasions':
      return 'invasions';
    case 'events-syndicate-missions':
      return 'syndicate missions';
    case 'events-void-trader':
      return 'Void Trader data';
    default:
      return 'event data';
  }
}

function buildInitialEventsMessage(context: EventsErrorContext): string {
  return `Couldn’t load ${getEventsSubject(context)} right now. Please try again. If it keeps happening, report it in Discord.`;
}

function buildDegradedEventsMessage(context: EventsErrorContext, lastAvailableAt: string | null): string {
  const formattedTimestamp = lastAvailableAt ? formatShortLocalDateTime(lastAvailableAt) : null;

  return formattedTimestamp
    ? `Couldn’t refresh ${getEventsSubject(context)} right now. Showing the last available data from ${formattedTimestamp}. If it keeps happening, report it in Discord.`
    : `Couldn’t refresh ${getEventsSubject(context)} right now. Showing the last available data if possible. If it keeps happening, report it in Discord.`;
}

export function formatEventsErrorMessage(
  context: EventsErrorContext,
  error: unknown,
  options?: { lastAvailableAt?: string | null },
): string {
  const raw = toRawErrorMessage(error);
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
