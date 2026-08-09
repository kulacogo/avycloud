'use strict';

/**
 * chat-datasheet-contract.js — die EINE Quelle für die Feldliste der
 * Chat-Änderungskarte.
 *
 * WARUM ES DIESE DATEI GIBT (Vorfall 2026-08-10, SKU-3154363905 /
 * eBay 800481892205):
 * Die Feldliste existierte als ~17 handgepflegte Kopien (V2-Deklaration,
 * V2-Sanitizer, Legacy-Deklaration, Legacy-Sanitizer, V3-Deklaration,
 * V3-Sanitizer, Zod-Schema, Prompt-JSON, Frontend-Sanitizer, Anzeige-Labels,
 * types.ts …). Keine war aus einer anderen abgeleitet. Die 9
 * `eu_responsible_*`-Felder kamen am 2026-06-01 NUR nach V3; V2 und Legacy
 * bekamen sie nie. Als `lib/model-select.js` alle Gemini-3-Namen auf 2.5
 * umschrieb, wurde V3 unerreichbar — und der Chat konnte den
 * EU-Verantwortlichen schlagartig nicht mehr schreiben. Gemeldet hat es
 * niemand.
 *
 * DER FORMFEHLER, der die Stille erzwang: jeder Sanitizer iterierte über die
 * WHITELIST statt über die EINGABE:
 *
 *     gpsrFields.forEach((f) => { if (entry.gpsr[f]) gpsr[f] = …; });
 *
 * Eine Projektion kann bauartbedingt nicht wissen, was sie fallen lässt — es
 * entsteht kein Rest, den man loggen, melden oder testen könnte. Der
 * Datenverlust war im Code gar nicht repräsentiert. `pickWithRest()` macht
 * daraus eine Partition: der Rest ist ein Wert und damit beobachtbar.
 *
 * REGEL: Kein Inline-Array mit Datenblatt-Feldnamen außerhalb dieser Datei.
 * Abgesichert durch `__tests__/chat-contract-no-inline-whitelist.test.js`.
 */

// Hersteller-Rolle. Reihenfolge = historische V2-Deklaration, damit die
// erzeugte Tool-Deklaration zum bestehenden Verhalten deckungsgleich bleibt.
const GPSR_MANUFACTURER_FIELDS = Object.freeze([
  'entity_country',
  'country_code',
  'manufacturer_name',
  'manufacturer_address',
  'manufacturer_city',
  'manufacturer_postalcode',
  'manufacturer_state_province',
  'email',
  'manufacturer_phone',
  'url',
]);

// EU-Verantwortlicher (GPSR EU 2023/988, Pflicht bei Nicht-EU-Herstellern).
// Eigene Rolle — NIE mit den Hersteller-Feldern vermischen.
const GPSR_EU_REP_FIELDS = Object.freeze([
  'eu_responsible_name',
  'eu_responsible_address',
  'eu_responsible_city',
  'eu_responsible_postalcode',
  'eu_responsible_state_province',
  'eu_responsible_country',
  'eu_responsible_country_code',
  'eu_responsible_email',
  'eu_responsible_phone',
]);

const GPSR_FIELDS = Object.freeze([...GPSR_MANUFACTURER_FIELDS, ...GPSR_EU_REP_FIELDS]);

// `source` ist ein Protokoll-Marker (z.B. 'product_image'), kein Datenfeld —
// er wird getrennt behandelt und zählt nicht als Nutzdaten.
const GPSR_PROTOCOL_FIELDS = Object.freeze(['source']);

const IDENTITY_FIELDS = Object.freeze([
  'name',
  'brand',
  'category',
  'sku',
  'barcodes',
  'ean',
  'gtin',
  'upc',
  'mpn',
]);

const IDENTITY_CLEARABLE = Object.freeze(['barcodes', 'ean', 'gtin', 'upc']);

/**
 * Zielpfad im Produktdokument je Änderungskarten-Feld.
 * Wichtig für `mpn`: die UI liest `details.identifiers.mpn`
 * (ProductSheet.tsx) — `identification.mpn` liest niemand. Ein Schreiben
 * dorthin wäre wirkungslos und sähe trotzdem nach Erfolg aus.
 */
const IDENTITY_TARGET_PATHS = Object.freeze({
  name: 'identification.name',
  brand: 'identification.brand',
  category: 'identification.category',
  sku: 'identification.sku',
  barcodes: 'identification.barcodes',
  ean: 'details.identifiers.ean',
  gtin: 'details.identifiers.gtin',
  upc: 'details.identifiers.upc',
  mpn: 'details.identifiers.mpn',
});

const FIELD_LABELS = Object.freeze({
  'identification.name': 'Titel',
  'identification.brand': 'Marke',
  'identification.category': 'Kategorie',
  'identification.sku': 'SKU',
  'identification.barcodes': 'Barcodes (EAN/UPC/GTIN)',
  'details.identifiers.ean': 'EAN',
  'details.identifiers.gtin': 'GTIN',
  'details.identifiers.upc': 'UPC',
  'details.identifiers.mpn': 'Herstellernummer (MPN)',
  'details.short_description': 'Beschreibung',
  'details.key_features': 'Highlights',
  'details.categoryId': 'eBay-Kategorie',
  'details.pricing.sellPrice': 'Verkaufspreis',

  'details.gpsr.entity_country': 'Hersteller / Land',
  'details.gpsr.country_code': 'Hersteller / Ländercode',
  'details.gpsr.manufacturer_name': 'Hersteller / Firma',
  'details.gpsr.manufacturer_address': 'Hersteller / Adresse',
  'details.gpsr.manufacturer_city': 'Hersteller / Stadt',
  'details.gpsr.manufacturer_postalcode': 'Hersteller / PLZ',
  'details.gpsr.manufacturer_state_province': 'Hersteller / Bundesland',
  'details.gpsr.email': 'Hersteller / E-Mail',
  'details.gpsr.manufacturer_phone': 'Hersteller / Telefon',
  'details.gpsr.url': 'Hersteller / Website',

  'details.gpsr.eu_responsible_name': 'EU-Verantwortlicher / Firma',
  'details.gpsr.eu_responsible_address': 'EU-Verantwortlicher / Adresse',
  'details.gpsr.eu_responsible_city': 'EU-Verantwortlicher / Stadt',
  'details.gpsr.eu_responsible_postalcode': 'EU-Verantwortlicher / PLZ',
  'details.gpsr.eu_responsible_state_province': 'EU-Verantwortlicher / Bundesland',
  'details.gpsr.eu_responsible_country': 'EU-Verantwortlicher / Land',
  'details.gpsr.eu_responsible_country_code': 'EU-Verantwortlicher / Ländercode',
  'details.gpsr.eu_responsible_email': 'EU-Verantwortlicher / E-Mail',
  'details.gpsr.eu_responsible_phone': 'EU-Verantwortlicher / Telefon',
});

/** Menschlich lesbares Label; fällt auf den Pfad zurück, wenn keins bekannt ist. */
function fieldLabel(path) {
  return FIELD_LABELS[path] || path;
}

function isBlank(v) {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/**
 * Partition statt Projektion.
 *
 * Iteriert über die EINGABE — nicht über die Whitelist — und liefert neben den
 * behaltenen Feldern die Liste der verworfenen Schlüssel. Genau dieser Rest
 * fehlte an allen 17 Kopien und machte den Datenverlust unsichtbar.
 *
 * Ein bekanntes Feld mit leerem Wert ist KEIN Verlust und erscheint nicht im
 * Rest — sonst würde jede Karte Rauschen erzeugen.
 *
 * @param {object} input
 * @param {string[]} fields erlaubte Feldnamen
 * @returns {{kept: object, droppedKeys: string[]}}
 */
function pickWithRest(input, fields) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { kept: {}, droppedKeys: [] };
  }
  const allowed = new Set(fields);
  const kept = {};
  const droppedKeys = [];
  for (const [key, value] of Object.entries(input)) {
    if (allowed.has(key)) {
      if (!isBlank(value)) kept[key] = typeof value === 'string' ? value.trim() : value;
      continue;
    }
    // Unbekannter Schlüssel MIT Inhalt = echter Verlust, der gemeldet gehört.
    if (!isBlank(value)) droppedKeys.push(key);
  }
  return { kept, droppedKeys };
}

/**
 * Erzeugt die `properties`-Map des gpsr-Objekts für eine Gemini-Tool-Deklaration.
 * V2/V3 nutzen die Großschreibung ('STRING'), Legacy die Kleinschreibung.
 * @param {'UPPER'|'lower'} dialect
 */
function buildGpsrToolProperties(dialect = 'UPPER') {
  const type = dialect === 'lower' ? 'string' : 'STRING';
  const props = {};
  for (const f of GPSR_FIELDS) props[f] = { type };
  return props;
}

/** Dieselbe Mechanik für das identity-Objekt (ohne `clear`, das der Aufrufer setzt). */
function buildIdentityToolProperties(dialect = 'UPPER') {
  const type = dialect === 'lower' ? 'string' : 'STRING';
  const arrayType = dialect === 'lower' ? 'array' : 'ARRAY';
  const props = {};
  for (const f of IDENTITY_FIELDS) {
    props[f] = f === 'barcodes' ? { type: arrayType, items: { type } } : { type };
  }
  return props;
}

module.exports = {
  GPSR_MANUFACTURER_FIELDS,
  GPSR_EU_REP_FIELDS,
  GPSR_FIELDS,
  GPSR_PROTOCOL_FIELDS,
  IDENTITY_FIELDS,
  IDENTITY_CLEARABLE,
  IDENTITY_TARGET_PATHS,
  FIELD_LABELS,
  fieldLabel,
  pickWithRest,
  buildGpsrToolProperties,
  buildIdentityToolProperties,
};
