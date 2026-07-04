import { tActive } from '../i18n/active.ts';
export function getUserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local';
}

function parseDateValue(value: string | null): Date | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function formatDateParts(
  date: Date,
  options: Intl.DateTimeFormatOptions,
): Record<string, string> {
  const formatter = new Intl.DateTimeFormat(undefined, {
    timeZone: getUserTimeZone(),
    ...options,
  });

  return formatter.formatToParts(date).reduce<Record<string, string>>((parts, part) => {
    if (part.type !== 'literal') {
      parts[part.type] = part.value;
    }
    return parts;
  }, {});
}

export function formatShortLocalDateTime(value: string | null): string {
  if (!value) {
    return tActive('rel.notAvailable');
  }

  const parsed = parseDateValue(value);
  if (!parsed) {
    return value;
  }

  const parts = formatDateParts(parsed, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  const meridiem = (parts.dayPeriod ?? '').toLowerCase();
  return `${parts.day} ${parts.month} ${parts.year} - ${parts.hour}:${parts.minute}${meridiem}`;
}

export function formatShortLocalDate(value: string | null): string {
  if (!value) {
    return tActive('rel.notAvailable');
  }

  const parsed = parseDateValue(value);
  if (!parsed) {
    return value;
  }

  const parts = formatDateParts(parsed, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  return `${parts.day} ${parts.month} ${parts.year}`;
}

export function formatElapsedTime(value: string | null): string {
  if (!value) {
    return tActive('rel.pending');
  }

  const parsed = parseDateValue(value);
  if (!parsed) {
    return tActive('rel.pending');
  }

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 1000));
  if (elapsedSeconds < 60) {
    return tActive('rel.s', { n: elapsedSeconds });
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return tActive('rel.m', { n: elapsedMinutes });
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return tActive('rel.h', { n: elapsedHours });
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  return tActive('rel.d', { n: elapsedDays });
}
