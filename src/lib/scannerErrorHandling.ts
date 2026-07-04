import { tActive, USER_MSG_MARK } from '../i18n/active.ts';
import { formatShortLocalDateTime } from './dateTime.ts';

export type ScannerErrorContext =
  | 'scanner-state-load'
  | 'scanner-state-refresh'
  | 'scanner-start'
  | 'scanner-stop'
  | 'scanner-run';

function toRawErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error ?? '').trim();
}

function buildScannerInitialMessage(context: ScannerErrorContext): string {
  switch (context) {
    case 'scanner-state-load':
      return tActive('err.scan.load');
    case 'scanner-state-refresh':
      return tActive('err.scan.refresh');
    case 'scanner-start':
      return tActive('err.scan.start');
    case 'scanner-stop':
      return tActive('err.scan.stop');
    case 'scanner-run':
      return tActive('err.scan.complete');
    default:
      return tActive('err.generic');
  }
}

function buildScannerDegradedMessage(
  context: ScannerErrorContext,
  lastCompletedAt: string | null,
): string {
  const formattedTimestamp = lastCompletedAt ? formatShortLocalDateTime(lastCompletedAt) : null;
  const savedScanSuffix = formattedTimestamp
    ? ` Showing the last saved scan from ${formattedTimestamp}.`
    : ' Showing the last saved scan if possible.';

  switch (context) {
    case 'scanner-state-load':
    case 'scanner-state-refresh':
      return `Couldn’t refresh scanner data right now.${savedScanSuffix} If it keeps happening, report it in Discord.`;
    case 'scanner-start':
      return `Couldn’t start a new scanner refresh right now.${savedScanSuffix} If it keeps happening, report it in Discord.`;
    case 'scanner-run':
      return `Couldn’t complete the scanner refresh right now.${savedScanSuffix} If it keeps happening, report it in Discord.`;
    case 'scanner-stop':
      return tActive('err.scan.stop');
    default:
      return buildScannerInitialMessage(context);
  }
}

export function formatScannerErrorMessage(
  context: ScannerErrorContext,
  error: unknown,
  options?: { lastCompletedAt?: string | null },
): string {
  const raw = toRawErrorMessage(error);

  if (raw.startsWith(USER_MSG_MARK)) {
    return raw.slice(USER_MSG_MARK.length);
  }
  const lastCompletedAt = options?.lastCompletedAt ?? null;

  if (context === 'scanner-start' || context === 'scanner-stop') {
    if (raw.startsWith('Couldn’t ')) {
      return raw;
    }

    return lastCompletedAt
      ? buildScannerDegradedMessage(context, lastCompletedAt)
      : buildScannerInitialMessage(context);
  }

  if (raw.startsWith(tActive('err.scan.noCache'))) {
    return raw;
  }

  return lastCompletedAt
    ? buildScannerDegradedMessage(context, lastCompletedAt)
    : buildScannerInitialMessage(context);
}
