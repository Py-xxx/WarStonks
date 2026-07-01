// Lightweight in-house i18n for UI chrome. Data (item names) is localized separately via the
// catalog's wfm_item_i18n table — see src/lib/language.ts. This module only covers static UI text.
//
// Usage:
//   const { t } = useTranslation();
//   <span>{t('nav.market')}</span>
//   <span>{t('trades.openBuys', { count })}</span>
//
// Lookup order: active locale → English → the raw key (so a missing key is visible, not blank).
import { useAppStore } from '../stores/useAppStore';
import type { AppLanguage } from '../lib/language';
import type { TranslationKey } from './en';
import { translate, type TranslateFn, type TranslateVars } from './translate';

export { translate };
export type { TranslateFn, TranslateVars };

/** React hook: re-renders when the store language changes. */
export function useTranslation(): { t: TranslateFn; language: AppLanguage } {
  const language = useAppStore((s) => s.language);
  const t: TranslateFn = (key: TranslationKey, vars?: TranslateVars) => translate(language, key, vars);
  return { t, language };
}
