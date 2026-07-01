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
