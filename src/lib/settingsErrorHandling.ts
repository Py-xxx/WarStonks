import { tActive, USER_MSG_MARK } from '../i18n/active.ts';
export type SettingsErrorContext =
  | 'settings-load'
  | 'alecaframe-validate'
  | 'alecaframe-save'
  | 'alecaframe-refresh'
  | 'discord-webhook-save'
  | 'strategy-save';

function toRawErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error ?? '').trim();
}

function friendlySettingsErrorFallback(context: SettingsErrorContext): string {
  switch (context) {
    case 'settings-load':
      return tActive('err.set.load');
    case 'alecaframe-validate':
      return tActive('err.set.validateAleca');
    case 'alecaframe-save':
      return tActive('err.set.saveAleca');
    case 'alecaframe-refresh':
      return tActive('err.set.refreshAleca');
    case 'discord-webhook-save':
      return tActive('err.set.saveDiscord');
    case 'strategy-save':
      return tActive('err.set.saveStrategy');
    default:
      return tActive('err.generic');
  }
}

export function formatSettingsErrorMessage(
  context: SettingsErrorContext,
  error: unknown,
): string {
  const raw = toRawErrorMessage(error);

  if (raw.startsWith(USER_MSG_MARK)) {
    return raw.slice(USER_MSG_MARK.length);
  }

  if (!raw) {
    return friendlySettingsErrorFallback(context);
  }

  if (
    raw.startsWith('Couldn’t ')
    || raw.startsWith('Enter a valid ')
    || raw.startsWith('Please enter ')
  ) {
    return raw;
  }
  return friendlySettingsErrorFallback(context);
}
