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
      return 'Couldn’t load scanner data right now. Please try again. If it keeps happening, report it in Discord.';
    case 'scanner-state-refresh':
      return 'Couldn’t refresh scanner data right now. Please try again. If it keeps happening, report it in Discord.';
    case 'scanner-start':
      return 'Couldn’t start the scanner right now. Please try again. If it keeps happening, report it in Discord.';
    case 'scanner-stop':
      return 'Couldn’t stop the scanner right now. Please try again. If it keeps happening, report it in Discord.';
    case 'scanner-run':
      return 'Couldn’t complete the scanner right now. Please try again. If it keeps happening, report it in Discord.';
    default:
      return 'Something went wrong. Please try again. If it keeps happening, report it in Discord.';
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
      return 'Couldn’t stop the scanner right now. Please try again. If it keeps happening, report it in Discord.';
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
  const lastCompletedAt = options?.lastCompletedAt ?? null;

  if (context === 'scanner-start' || context === 'scanner-stop') {
    if (raw.startsWith('Couldn’t ')) {
      return raw;
    }

    return lastCompletedAt
      ? buildScannerDegradedMessage(context, lastCompletedAt)
      : buildScannerInitialMessage(context);
  }

  if (raw.startsWith('No cached scanner results yet.')) {
    return raw;
  }

  return lastCompletedAt
    ? buildScannerDegradedMessage(context, lastCompletedAt)
    : buildScannerInitialMessage(context);
}
