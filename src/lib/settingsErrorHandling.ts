export type SettingsErrorContext =
  | 'settings-load'
  | 'alecaframe-validate'
  | 'alecaframe-save'
  | 'alecaframe-refresh'
  | 'discord-webhook-save';

function toRawErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error ?? '').trim();
}

function friendlySettingsErrorFallback(context: SettingsErrorContext): string {
  switch (context) {
    case 'settings-load':
      return 'Couldn’t load app settings right now. Please try again. If it keeps happening, report it in Discord. Reference: SETTINGS-LOAD-01';
    case 'alecaframe-validate':
      return 'Couldn’t validate that Alecaframe link right now. Check the link or token and try again. If it keeps happening, report it in Discord. Reference: ALECAFRAME-VALIDATE-01';
    case 'alecaframe-save':
      return 'Couldn’t save Alecaframe settings right now. Please try again. If it keeps happening, report it in Discord. Reference: ALECAFRAME-SAVE-01';
    case 'alecaframe-refresh':
      return 'Couldn’t refresh Alecaframe balances right now. Showing the last available wallet data if possible. If it keeps happening, report it in Discord. Reference: ALECAFRAME-WALLET-REFRESH-01';
    case 'discord-webhook-save':
      return 'Couldn’t save Discord webhook settings right now. Please check the webhook and try again. If it keeps happening, report it in Discord. Reference: DISCORD-WEBHOOK-SAVE-01';
    default:
      return 'Something went wrong. Please try again. If it keeps happening, report it in Discord.';
  }
}

export function formatSettingsErrorMessage(
  context: SettingsErrorContext,
  error: unknown,
): string {
  const raw = toRawErrorMessage(error);

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

  if (raw.includes('Reference:')) {
    return raw;
  }

  return friendlySettingsErrorFallback(context);
}
