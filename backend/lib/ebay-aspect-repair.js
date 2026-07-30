/**
 * Artikelmerkmale so aufbereiten, dass eBay sie als Suchfilter erkennt.
 *
 * Reine Funktionen, kein I/O. Der Kategorie-Aspektkatalog wird als Parameter
 * hereingegeben (Aufrufer holt ihn aus lib/ebay-taxonomy.js).
 *
 * BEFUND (gemessen 2026-07-29, frischer Katalog vom selben Tag):
 * 17.449 von 33.274 Merkmalsnamen (52,4 %) kennt eBay in der Zielkategorie nicht.
 * Solche Merkmale stehen zwar im Angebot, erzeugen aber KEINEN Filter in der Suchleiste.
 * Der frische Katalog allein aendert daran nichts — die 162 Tage Alter waren nicht die Ursache.
 *
 * DREI REGELN, jede an echten Daten gemessen:
 *
 *  1. EINHEIT IM NAMEN (1.357 Vorkommen, davon 535 heilbar)
 *     "Gewicht (kg)" = "16"  ->  "Gewicht" = "16 kg"
 *     eBay fuehrt den Aspekt ohne Einheit im Namen und erwartet sie im WERT.
 *     Nur bei einer echten physikalischen Einheit aus ALLOWED_UNITS. Das ist keine
 *     Kosmetik: "Hersteller (Europa)" = "THULE SWEDEN AB" wuerde sonst zu
 *     "Marke" = "THULE SWEDEN AB Europa" — die GPSR-Herstellerfirma landet im
 *     Marken-Filter und der Wert ist verstuemmelt. 392 solcher Faelle wurden gemessen.
 *
 *  2. STRUKTURELL FALSCH PLATZIERT (1.648 Vorkommen, 0 Konflikte)
 *     "Zustand" gehoert bei eBay zu ConditionID, "EAN"/"GTIN"/"UPC"/"ISBN" zu
 *     ProductListingDetails. In den Artikelmerkmalen sind sie wirkungslos und belegen
 *     einen Platz. Gegenprobe gelaufen: in KEINER der genutzten Kategorien ist einer
 *     dieser Namen ein gueltiger Aspekt. Wird nur entfernt, wenn der Wert anderswo
 *     erhalten bleibt — das prueft der Aufrufer, deshalb ist die Regel abschaltbar.
 *
 *  3. GEPRUEFTE SYNONYME (1.244 Vorkommen)
 *     Delegiert an lib/ebay-aspect-name-normalizer.js mit seiner handgepflegten Tabelle.
 *
 * ERWARTUNG, ehrlich: 52,4 % unbekannt sinkt auf etwa 42 %. Der Rest sind generische
 * Namen ("Material", "Farbe", "Groesse"), die eBay in der jeweiligen Kategorie einfach
 * nicht fuehrt — die sind ohne Handarbeit am Einzelprodukt nicht heilbar.
 *
 * VERLUSTFREI: Was keine Regel trifft, bleibt unveraendert stehen. eBay erlaubt eigene
 * Merkmale, sie erzeugen nur keinen Filter. Es wird nie ein Wert erfunden.
 */

const { normalizeAspectToken, normalizeAspectNamesForCategory } = require('./ebay-aspect-name-normalizer');

/**
 * Echte physikalische Einheiten. Bewusst eine Positivliste — alles andere in Klammern
 * ist KEINE Einheit (Regionen, Kuerzel, Masszusammensetzungen wie "LxBxH").
 */
const ALLOWED_UNITS = new Set([
  'kg', 'g', 'mg', 't', 'lb', 'lbs', 'oz',
  'mm', 'cm', 'dm', 'm', 'km', 'zoll', 'in', 'inch', 'ft',
  'ml', 'l', 'cl', 'dl',
  'w', 'kw', 'ps', 'v', 'mv', 'a', 'ma', 'ah', 'mah', 'wh', 'kwh',
  'hz', 'khz', 'mhz', 'ghz',
  'bar', 'psi', 'nm', 'pa', 'kpa',
  'rpm', 'db', 'lm', 'lx', 'k',
  'm2', 'm3', 'cm2', 'cm3', 'qm',
]);

/** Namen, die bei eBay an einer anderen Stelle des Angebots gehoeren. */
const MISPLACED_ASPECT_TOKENS = new Set(
  ['Zustand', 'EAN', 'GTIN', 'UPC', 'ISBN', 'Artikelzustand']
    .map((n) => normalizeAspectToken(n))
    .filter(Boolean)
);

const MODES = new Set(['off', 'shadow', 'on']);
const DEFAULT_MODE = 'off';

function safeString(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Klammerinhalt am Ende eines Namens. */
const TRAILING_PAREN = /^(.*?)[\s]*[（([]\s*([^)）\]]+?)\s*[)）\]]\s*$/;

/**
 * Zerlegt "Gewicht (kg)" in { baseName: 'Gewicht', unit: 'kg' }.
 * Liefert null, wenn kein Klammerteil vorhanden ist ODER der Klammerinhalt keine
 * echte Einheit ist. Das Ablehnen ist der wichtigere Teil dieser Funktion.
 */
function extractUnitFromName(name) {
  const raw = safeString(name).trim();
  if (!raw) return null;
  const m = raw.match(TRAILING_PAREN);
  if (!m) return null;
  const baseName = safeString(m[1]).trim();
  const unit = safeString(m[2]).trim();
  if (!baseName || !unit) return null;
  if (!ALLOWED_UNITS.has(unit.toLowerCase())) return null;
  return { baseName, unit };
}

/**
 * Haengt die Einheit an den Wert, sofern sie nicht schon drinsteht.
 * "16" + kg -> "16 kg"; "16 kg" + kg -> "16 kg" (idempotent).
 */
function appendUnitToValue(value, unit) {
  const raw = safeString(value).trim();
  if (!raw) return raw;
  const u = safeString(unit).trim();
  if (!u) return raw;
  const hasUnit = new RegExp(`(^|[\\s\\d.,])${u.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*$`, 'i').test(raw);
  if (hasUnit) return raw;
  return `${raw} ${u}`;
}

function buildNameIndex(catalogAspectNames) {
  const index = new Map();
  const add = (n) => {
    const name = safeString(typeof n === 'string' ? n : n?.name || n?.localizedAspectName).trim();
    if (!name) return;
    const token = normalizeAspectToken(name);
    if (token && !index.has(token)) index.set(token, name);
  };
  if (Array.isArray(catalogAspectNames)) catalogAspectNames.forEach(add);
  else if (isPlainObject(catalogAspectNames)) {
    if (Array.isArray(catalogAspectNames.allAspects)) catalogAspectNames.allAspects.forEach(add);
    else Object.keys(catalogAspectNames).forEach(add);
  }
  return index;
}

function resolveRepairMode() {
  const raw = safeString(process.env.EBAY_ASPECT_REPAIR).trim().toLowerCase();
  return MODES.has(raw) ? raw : DEFAULT_MODE;
}

/**
 * Wendet die drei Regeln in fester Reihenfolge an.
 *
 * @param {object}  args
 * @param {string}  args.categoryId
 * @param {object}  args.itemSpecifics          { Name: Wert }
 * @param {*}       args.catalogAspectNames     Aspektkatalog der Kategorie
 * @param {string}  [args.mode]                 off | shadow | on (Default off)
 * @param {boolean} [args.dropMisplaced=true]   Regel 2 anwenden
 * @param {*}       [args.synonyms]             Override der Synonymtabelle (Tests)
 * @returns {{itemSpecifics: object, aenderungen: Array, unknown: Array, mode: string,
 *            catalogAvailable: boolean, changed: boolean}}
 */
function repairAspectsForCategory(args) {
  const opts = isPlainObject(args) ? args : {};
  const rawMode = safeString(opts.mode || DEFAULT_MODE).toLowerCase();
  const mode = MODES.has(rawMode) ? rawMode : DEFAULT_MODE;
  const categoryId = safeString(opts.categoryId).trim() || null;
  const input = isPlainObject(opts.itemSpecifics) ? opts.itemSpecifics : {};
  const dropMisplaced = opts.dropMisplaced !== false;

  const base = {
    itemSpecifics: input,
    aenderungen: [],
    unknown: [],
    mode,
    categoryId,
    catalogAvailable: false,
    changed: false,
  };

  if (mode === 'off') return base;

  const index = buildNameIndex(opts.catalogAspectNames);
  // Ohne Katalog kann niemand wissen, ob ein Name gueltig ist — dann nichts anfassen.
  if (!categoryId || index.size === 0) return base;
  base.catalogAvailable = true;

  const aenderungen = [];
  const zwischen = {};
  const belegt = new Set();
  Object.keys(input).forEach((k) => {
    const t = normalizeAspectToken(k);
    if (t) belegt.add(t);
  });

  Object.entries(input).forEach(([rawKey, value]) => {
    const key = safeString(rawKey);
    const token = normalizeAspectToken(key);
    if (!token) {
      zwischen[key] = value;
      return;
    }

    // Bereits gueltig -> niemals anfassen (Idempotenz).
    if (index.has(token)) {
      zwischen[key] = value;
      return;
    }

    // Regel 2: strukturell falsch platziert -> entfernen.
    if (dropMisplaced && MISPLACED_ASPECT_TOKENS.has(token)) {
      aenderungen.push({ art: 'entfernt', von: key, grund: 'gehoert an eine andere Stelle des Angebots' });
      return;
    }

    // Regel 1: Einheit im Namen -> Name ohne Einheit, Einheit in den Wert.
    const unitInfo = extractUnitFromName(key);
    if (unitInfo) {
      const zielToken = normalizeAspectToken(unitInfo.baseName);
      if (zielToken && index.has(zielToken)) {
        // Kollision: Zielname schon im Datensatz -> nicht anfassen (kein Datenverlust).
        if (belegt.has(zielToken) && zielToken !== token) {
          zwischen[key] = value;
          return;
        }
        const zielName = index.get(zielToken);
        const neuerWert = appendUnitToValue(value, unitInfo.unit);
        aenderungen.push({ art: 'einheit', von: key, nach: zielName, wertVon: safeString(value), wertNach: neuerWert });
        zwischen[zielName] = neuerWert;
        belegt.add(zielToken);
        return;
      }
    }

    zwischen[key] = value;
  });

  // Regel 3: geprueftes Synonym-Umbenennen auf dem Zwischenstand.
  const synonymErgebnis = normalizeAspectNamesForCategory({
    categoryId,
    itemSpecifics: zwischen,
    catalogAspectNames: opts.catalogAspectNames,
    synonyms: opts.synonyms,
    mode: mode === 'shadow' ? 'shadow' : 'on',
  });

  (synonymErgebnis.renames || []).forEach((r) => {
    aenderungen.push({ art: 'synonym', von: r.from, nach: r.to });
  });

  const ergebnis = mode === 'shadow' ? input : (synonymErgebnis.itemSpecifics || zwischen);

  return {
    itemSpecifics: ergebnis,
    aenderungen,
    unknown: synonymErgebnis.unknown || [],
    mode,
    categoryId,
    catalogAvailable: true,
    changed: mode === 'on' && aenderungen.length > 0,
  };
}

module.exports = {
  repairAspectsForCategory,
  extractUnitFromName,
  appendUnitToValue,
  resolveRepairMode,
  buildNameIndex,
  ALLOWED_UNITS,
  MISPLACED_ASPECT_TOKENS,
  MODES,
  DEFAULT_MODE,
};
