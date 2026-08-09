'use strict';

/**
 * gpsr-registry-guard.js — verhindert, dass ein unbelegter Marken-Eintrag
 * seine GPSR-Daten über fremde Produkte verschmiert.
 *
 * BEFUND 2026-08-10 (Produktionsdaten, read-only gemessen):
 * `gpsrManufacturers/markenlos` enthielt
 *
 *   manufacturer_name  "Markenlos"
 *   manufacturer_address "78 avenue des Champs Elysees Bureau 326", Paris
 *   manufacturer_state_province "Zhejiang"   <- chinesische Provinz in Pariser Adresse
 *   email              "mjcm190928@gmail.com" <- Freemail als Herstellerkontakt
 *   eu_responsible_name "Geaplan GmbH"        <- unbeteiligte fremde Firma
 *   confidence 0, sources []
 *
 * `lib/firestore.js` schlägt diesen Eintrag über `identification.brand` nach —
 * beim SPEICHERN und beim LESEN. "Markenlos" ist aber keine Marke, sondern das
 * Fehlen einer Marke: 36 völlig unverwandte Live-Produkte teilen sich diesen
 * "Hersteller". Gemessen trugen 32 Angebote den zeichengleichen Block.
 *
 * Da der Read-Pfad mit-enforced, überlebte auch jede manuelle Korrektur nur bis
 * zum nächsten Laden. Genau deshalb wirkten Korrekturen wirkungslos.
 *
 * Zwei unabhängige, fail-safe Sperren:
 *   1. `isPlaceholderBrand()` — Platzhalter keyen nie einen Lookup.
 *   2. `isEnforceableRegistryEntry()` — ohne jeden Beleg keine Durchsetzung.
 */

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

// Nur EXAKTE Platzhalter, nie Teiltreffer: "Generic Electric AB" ist eine echte
// Marke und darf nicht an "generic" hängenbleiben.
const PLACEHOLDER_BRANDS = new Set([
  'markenlos',
  'ohnemarke',
  'markeunbekannt',
  'unbekannt',
  'unbekannterhersteller',
  'noname',
  'nobrand',
  'unbranded',
  'generic',
  'generisch',
  'na',
  'ka',
  'keineangabe',
  'sonstige',
  'sonstiges',
  'diverse',
]);

/**
 * Ist der Name gar keine Marke, sondern ein Platzhalter für "keine Marke"?
 * Leer zählt ebenfalls als Platzhalter (nichts nachzuschlagen).
 */
function isPlaceholderBrand(name) {
  const raw = safeString(name);
  if (!raw) return true;
  // Reine Strich-/Punkt-Platzhalter ("-", "–", "—", "...").
  if (/^[\s\-–—._/]+$/.test(raw)) return true;
  const norm = raw.toLowerCase().replace(/[^a-z0-9äöüß]/g, '');
  return PLACEHOLDER_BRANDS.has(norm);
}

/**
 * Darf dieser Registry-Eintrag über die Produktdaten gelegt werden?
 *
 * Ein Eintrag ganz ohne Beleg (confidence 0/fehlend UND keine Quellen UND
 * keine Beleg-Metadaten) ist eine ungeprüfte Behauptung. Ihn durchzusetzen
 * bedeutet, eine ungeprüfte Behauptung an rechtlich haftende
 * Marktplatz-Angaben zu schreiben. Fail-safe: im Zweifel NICHT durchsetzen.
 */
function isEnforceableRegistryEntry(reg) {
  if (!reg || typeof reg !== 'object') return false;
  const gpsr = reg.gpsr && typeof reg.gpsr === 'object' ? reg.gpsr : null;
  if (!gpsr || !Object.keys(gpsr).length) return false;

  const confidence = Number(reg.confidence);
  const hasConfidence = Number.isFinite(confidence) && confidence > 0;
  const hasSources = Array.isArray(reg.sources) && reg.sources.length > 0;
  const hasEvidence = Boolean(reg.evidence && typeof reg.evidence === 'object' && Object.keys(reg.evidence).length);

  return hasConfidence || hasSources || hasEvidence;
}

module.exports = {
  isPlaceholderBrand,
  isEnforceableRegistryEntry,
  PLACEHOLDER_BRANDS,
};
