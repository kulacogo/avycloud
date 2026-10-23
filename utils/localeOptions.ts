import type { Locale } from "../i18n";

export interface LocaleOption {
  code: Locale;
  short: string;
  nativeName: string;
}

/** Sprachen der Oberfläche, in Anzeigereihenfolge des Sprachwählers. */
export const LOCALE_OPTIONS: readonly LocaleOption[] = [
  { code: "en", short: "EN", nativeName: "English" },
  { code: "de", short: "DE", nativeName: "Deutsch" },
  { code: "tr", short: "TR", nativeName: "Türkçe" },
];

/** Kurzlabel für den Knopf; unbekannte Werte fallen auf Großbuchstaben zurück. */
export function localeShortLabel(code: string): string {
  const option = LOCALE_OPTIONS.find((o) => o.code === code);
  return option ? option.short : String(code || "").toUpperCase();
}
