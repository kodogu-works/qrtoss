import * as english from './locales/en';
import * as japanese from './locales/ja';
import * as spanish from './locales/es';
import type { Key } from './locales/types';

export type { Key } from './locales/types';
export { messages as en } from './locales/en';

// Register complete locales here; the language selector uses this registry too.
export const locales = { en: english, ja: japanese, es: spanish };
export type Language = keyof typeof locales;

function mapLocales<T>(select: (locale: (typeof locales)[Language]) => T): Record<Language, T> {
  return Object.fromEntries(
    Object.entries(locales).map(([language, locale]) => [language, select(locale)]),
  ) as Record<Language, T>;
}

export const dictionaries = mapLocales((locale) => locale.messages);
export const languageLabels = mapLocales((locale) => locale.label);

export function chooseLanguage(preferences: readonly string[], saved?: string | null): Language {
  if (saved && Object.hasOwn(dictionaries, saved)) return saved as Language;
  for (const value of preferences) {
    const base = value.toLowerCase().split('-')[0];
    if (base && Object.hasOwn(dictionaries, base)) return base as Language;
  }
  return 'en';
}
export function translate(
  language: Language,
  key: Key,
  values: Record<string, string | number> = {},
): string {
  return dictionaries[language][key].replace(/\{(\w+)\}/g, (_, name: string) =>
    String(values[name] ?? ''),
  );
}

export const errors = Object.fromEntries(
  Object.keys(english.errorMessages).map((code) => [
    code,
    mapLocales((locale) => locale.errorMessages[code as keyof typeof english.errorMessages]),
  ]),
) as Record<string, Record<Language, string>>;

export function errorText(language: Language, code: string): string {
  return (errors[code] ?? errors.PROTOCOL_ERROR)![language];
}
