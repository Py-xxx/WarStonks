// English is the source of truth: every UI string key lives here in full.
// Other locales (zh-hans, pt, es, fr, de) are partial Record<string,string> maps that
// override individual keys; anything missing falls back to this file, then to the key itself.
// Interpolate with {name} placeholders, e.g. t('trades.openBuys', { count: 3 }).
//
// Contributors: to translate, copy a key from here into the target locale file and translate
// the value. You never need to translate everything at once — untranslated keys show English.

export const en = {
  // Navigation / pages (keys match NavItemDef.id in Sidebar)
  'nav.home': 'Home',
  'nav.market': 'Market',
  'nav.events': 'Events',
  'nav.scanners': 'Scanners',
  'nav.opportunities': 'Opportunities',
  'nav.inventory': 'Inventory',
  'nav.trades': 'Trades',
  'nav.portfolio': 'Portfolio',
  'nav.strategy': 'Strategy',
  'nav.guide': 'Guide',
  'nav.discord': 'Join Discord',
  'nav.settings': 'Settings',
  'nav.expandSidebar': 'Expand sidebar',
  'nav.collapseSidebar': 'Collapse sidebar',

  // Settings
  'settings.title': 'Settings',
  'settings.heading': 'Integrations',
  'settings.close': 'Close settings',
  'settings.language': 'Language',
  'settings.language.aria': 'Display language',
  'settings.lastValidation': 'Last validation:',

  // Settings sections
  'settings.section.alecaframe.label': 'Alecaframe API',
  'settings.section.alecaframe.desc': 'Wallet sync, public stats validation, and top-bar balances.',
  'settings.section.discord.label': 'Discord Webhook',
  'settings.section.discord.desc': 'Reserved for outbound alerts and status push workflows.',
  'settings.section.notifications.label': 'Notifications',
  'settings.section.notifications.desc': 'Desktop alerts and in-app sound for watchlist hits and more.',
  'settings.section.importExport.label': 'Import & Export',
  'settings.section.importExport.desc': 'Back up or restore your inventory, watchlist, trades, and market data.',

  // Status badges
  'status.enabled': 'Enabled',
  'status.disabled': 'Disabled',
  'status.missingLink': 'Missing link',
  'status.missingUrl': 'Missing URL',
  'status.syncError': 'Sync error',
  'status.soon': 'Soon',

  // Top bar / search
  'search.placeholder': 'Search WFM items, sets, relics…',
  'search.loading': 'Loading item catalog…',
  'search.error': 'Could not load items',
  'search.noResults': 'No matching items',

  // Common actions
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.confirm': 'Confirm',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.loading': 'Loading…',
  'common.retry': 'Retry',
  'common.viewAll': 'View All',
} as const;

export type TranslationKey = keyof typeof en;
