// Node-safe active-language translation for non-React code (store actions, libs, error
// formatters). Reads the persisted language directly from localStorage instead of the Zustand
// store, so unit-testable libs can import this without dragging the whole app store along.
import { translate, type TranslateVars } from './translate.ts';
import type { TranslationKey } from './en.ts';
import { loadLanguage } from '../lib/language.ts';

export function tActive(key: TranslationKey, vars?: TranslateVars): string {
  return translate(loadLanguage(), key, vars);
}

/**
 * Zero-width marker prefixed onto user-facing, already-translated error messages thrown from
 * the store. The formatXErrorMessage libs pass such messages straight through (stripping the
 * marker) instead of replacing them with a generic fallback.
 */
export const USER_MSG_MARK = '\u200b';

/** Translated user-facing error message, marked for passthrough by the error-format libs. */
export function tUserMessage(key: TranslationKey, vars?: TranslateVars): string {
  return USER_MSG_MARK + tActive(key, vars);
}
