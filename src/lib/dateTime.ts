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
    return 'Not available';
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
    return 'Not available';
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
