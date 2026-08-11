'use strict';

/**
 * PLZ-Format-Prüfung je Zielland + Erkennung vertauschter PLZ/Stadt-Felder.
 *
 * Hintergrund (Vorfall 2026-08-04, Auftrag 07-14991-66886): eBay lieferte für
 * einen belgischen Käufer CityName="2000" und PostalCode="Antwerpen". Die
 * Felder waren BEI EBAY vertauscht — der Käufer hatte sie falsch eingetippt und
 * eBay validiert internationale Adressfelder nicht. Unser Intake mappte korrekt
 * (city←CityName, zip←PostalCode), SendCloud lehnte den Label-Call zurecht ab:
 *   400 validation_error "Enter a valid zip code." pointer=postal_code
 * Der Operator sah nur die rohe SendCloud-Meldung und probierte 8× in 6 min.
 *
 * Zwei bewusste Grundsätze:
 *  1. FAIL-OPEN bei Unwissen. Länder ohne verlässliches Muster (IE-Eircode,
 *     GB) liefern `null` — kein Urteil. Ein falsches "ungültig" würde eine
 *     korrekte Adresse blockieren, das ist schlimmer als gar keine Prüfung.
 *  2. TAUSCHEN NUR BEI BEWEIS. Ein Tausch passiert ausschließlich, wenn die
 *     aktuelle PLZ für das Land nachweislich ungültig ist UND der Stadt-Wert
 *     eine gültige PLZ für dasselbe Land ist. Sonst wird nichts angefasst.
 *     (Gegenbeispiel, das NIE anfassen darf: NL "9645CW"/"Veendam" — korrekt.)
 */

// Nur Länder mit eindeutigem, stabilem Format. Lieber eine Lücke als ein
// falsches Muster: fehlt ein Land, wird schlicht nicht geurteilt.
// IE (Eircode) und GB sind bewusst NICHT gemustert.
const POSTAL_PATTERNS = {
  DE: /^\d{5}$/,
  AT: /^\d{4}$/,
  BE: /^\d{4}$/,
  NL: /^\d{4}\s?[A-Z]{2}$/i,
  LU: /^\d{4}$/,
  FR: /^\d{5}$/,
  MC: /^980\d{2}$/,
  DK: /^\d{4}$/,
  SE: /^\d{3}\s?\d{2}$/,
  FI: /^\d{5}$/,
  NO: /^\d{4}$/,
  PL: /^\d{2}-?\d{3}$/,
  CZ: /^\d{3}\s?\d{2}$/,
  SK: /^\d{3}\s?\d{2}$/,
  HU: /^\d{4}$/,
  SI: /^\d{4}$/,
  HR: /^\d{5}$/,
  RO: /^\d{6}$/,
  BG: /^\d{4}$/,
  EE: /^\d{5}$/,
  LV: /^(LV-)?\d{4}$/i,
  LT: /^(LT-)?\d{5}$/i,
  IT: /^\d{5}$/,
  ES: /^\d{5}$/,
  PT: /^\d{4}-?\d{3}$/,
  GR: /^\d{3}\s?\d{2}$/,
  CH: /^\d{4}$/,
  LI: /^\d{4}$/,
  US: /^\d{5}(-\d{4})?$/,
};

function _norm(value) {
  return String(value ?? '').trim();
}

function _country(value) {
  return _norm(value).toUpperCase().slice(0, 2);
}

/**
 * Prüft eine PLZ gegen das Format des Ziellandes.
 * @returns {true|false|null} true = gültig, false = nachweislich ungültig,
 *   null = kein Urteil möglich (Land ohne Muster oder leerer Wert).
 */
function isValidPostalCode(zip, country) {
  const pattern = POSTAL_PATTERNS[_country(country)];
  if (!pattern) return null;
  const value = _norm(zip);
  if (!value) return null;
  return pattern.test(value);
}

/**
 * Erkennt vertauschte PLZ/Stadt-Felder — nur bei Beweis, nie auf Verdacht.
 * @returns {{swapped: boolean, zip: string, city: string}} bei swapped=true
 *   sind zip/city bereits die KORRIGIERTEN Werte.
 */
function detectSwappedZipCity(zip, city, country) {
  const zipStr = _norm(zip);
  const cityStr = _norm(city);
  const unchanged = { swapped: false, zip: zipStr, city: cityStr };
  if (!zipStr || !cityStr) return unchanged;

  // Beweis-Bedingung: PLZ nachweislich ungültig UND Stadt ist eine gültige PLZ.
  if (isValidPostalCode(zipStr, country) !== false) return unchanged;
  if (isValidPostalCode(cityStr, country) !== true) return unchanged;

  return { swapped: true, zip: cityStr, city: zipStr };
}

module.exports = {
  POSTAL_PATTERNS,
  isValidPostalCode,
  detectSwappedZipCity,
};
