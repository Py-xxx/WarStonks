// App display language. Item names come from Warframe.Market's per-language data (already stored
// locally in the catalog's wfm_item_i18n table); UI-string translation is a later phase.
export type AppLanguage = 'en' | 'zh-hans' | 'pt' | 'es' | 'fr' | 'de';

export interface LanguageOption {
  code: AppLanguage;
  /** Warframe.Market i18n lang_code used to resolve localized item names. */
  wfm: string;
  label: string;
  native: string;
  flag: string;
}

export const LANGUAGES: LanguageOption[] = [
  { code: 'en', wfm: 'en', label: 'English', native: 'English', flag: '🇬🇧' },
  { code: 'zh-hans', wfm: 'zh-hans', label: 'Chinese (Simplified)', native: '简体中文', flag: '🇨🇳' },
  { code: 'pt', wfm: 'pt', label: 'Portuguese (BR)', native: 'Português (BR)', flag: '🇧🇷' },
  { code: 'es', wfm: 'es', label: 'Spanish', native: 'Español', flag: '🇪🇸' },
  { code: 'fr', wfm: 'fr', label: 'French', native: 'Français', flag: '🇫🇷' },
  { code: 'de', wfm: 'de', label: 'German', native: 'Deutsch', flag: '🇩🇪' },
];

const STORAGE_KEY = 'warstonks.language';
export const DEFAULT_LANGUAGE: AppLanguage = 'en';

function isAppLanguage(value: string): value is AppLanguage {
  return LANGUAGES.some((option) => option.code === value);
}

export function loadLanguage(): AppLanguage {
  if (typeof window === 'undefined' || !window.localStorage) {
    return DEFAULT_LANGUAGE;
  }
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw && isAppLanguage(raw) ? raw : DEFAULT_LANGUAGE;
}

export function saveLanguage(language: AppLanguage): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // Best-effort persistence.
  }
}

export function wfmLangCode(language: AppLanguage): string {
  return LANGUAGES.find((option) => option.code === language)?.wfm ?? 'en';
}

/**
 * warframestat.us language code — differs from WFM's for Chinese (wfstat uses `zh`, WFM uses
 * `zh-hans`). Used for worldstate localization and the item-name catalog / language packs.
 */
export function wfstatLangCode(language: AppLanguage): string {
  return language === 'zh-hans' ? 'zh' : language;
}

const INTL_LOCALE_CODES: Record<AppLanguage, string> = {
  en: 'en-US',
  'zh-hans': 'zh-CN',
  pt: 'pt-BR',
  es: 'es-ES',
  fr: 'fr-FR',
  de: 'de-DE',
};

/** BCP-47 locale code for `Intl`/`toLocaleDateString` calls that need the app's chosen language. */
export function intlLocaleCode(language: AppLanguage): string {
  return INTL_LOCALE_CODES[language] ?? 'en-US';
}

/**
 * Localized word for "Set". WFM set items (slug ending `_set`) show "… Set" in English, but the
 * localized name from WFStat often maps to the base item and drops it — so we re-append this.
 */
const SET_NAME_SUFFIX: Record<AppLanguage, string> = {
  en: 'Set',
  'zh-hans': '套装',
  pt: 'Conjunto',
  es: 'Conjunto',
  fr: 'Ensemble',
  de: 'Set',
};

/**
 * Ensures a set item's display name carries the localized "Set" suffix. No-op when the name
 * already contains that word (e.g. WFStat already included it) or isn't a set.
 */
export function applySetSuffix(language: AppLanguage, slug: string | null | undefined, name: string): string {
  if (!slug || !slug.endsWith('_set')) {
    return name;
  }
  const suffix = SET_NAME_SUFFIX[language];
  const lower = name.toLowerCase();
  if (lower.includes(suffix.toLowerCase()) || lower.endsWith(' set')) {
    return name;
  }
  return `${name} ${suffix}`;
}
