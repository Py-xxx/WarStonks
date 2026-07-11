import { tActive } from '../i18n/active.ts';
import { intlLocaleCode, loadLanguage } from './language.ts';

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

/**
 * Formats a date in the app's chosen language, letting `Intl` own the field ordering and
 * conventions (e.g. Chinese renders year-first `2026年7月5日`, German day-first `5. Juli 2026`,
 * en-US `Jul 5, 2026`). Previously this hand-assembled parts in a fixed English `day month year`
 * order under the *system* locale, so non-English users got English ordering.
 */
function formatLocalized(date: Date, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(intlLocaleCode(loadLanguage()), {
    timeZone: getUserTimeZone(),
    ...options,
  }).format(date);
}

export function formatShortLocalDateTime(value: string | null): string {
  if (!value) {
    return tActive('rel.notAvailable');
  }

  const parsed = parseDateValue(value);
  if (!parsed) {
    return value;
  }

  // No `hour12` — let the locale decide (en-US → 12h, zh/de/fr/… → 24h).
  return formatLocalized(parsed, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatShortLocalDate(value: string | null): string {
  if (!value) {
    return tActive('rel.notAvailable');
  }

  const parsed = parseDateValue(value);
  if (!parsed) {
    return value;
  }

  return formatLocalized(parsed, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
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
