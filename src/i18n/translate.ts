// Pure translation logic — no React, no store — so it can be unit-tested in isolation.
import type { AppLanguage } from '../lib/language.ts';
import { en, type TranslationKey } from './en.ts';
import { zhHans } from './zh-hans.ts';
import { pt } from './pt.ts';
import { es } from './es.ts';
import { fr } from './fr.ts';
import { de } from './de.ts';

type LocaleMap = Record<string, string>;

const LOCALES: Record<AppLanguage, LocaleMap> = {
  en,
  'zh-hans': zhHans,
  pt,
  es,
  fr,
  de,
};

export type TranslateVars = Record<string, string | number>;

function interpolate(template: string, vars?: TranslateVars): string {
  if (!vars) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

/** Resolve a key for a given language with the locale → English → key fallback chain. */
export function translate(language: AppLanguage, key: TranslationKey, vars?: TranslateVars): string {
  const template = LOCALES[language]?.[key] ?? en[key] ?? key;
  return interpolate(template, vars);
}

export type TranslateFn = (key: TranslationKey, vars?: TranslateVars) => string;
